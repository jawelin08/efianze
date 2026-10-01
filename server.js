const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const { Pool } = require('pg');

const root = path.resolve(__dirname, 'www');
const port = Number(process.env.PORT) || 4354;
const scrypt = promisify(crypto.scrypt);
const allowedUsers = new Set(
  (process.env.ALLOWED_USERS || '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean),
);
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL })
  : null;
const authAttempts = new Map();
let databaseReady = false;
const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

const sendJson = (response, statusCode, payload) => {
  response.writeHead(statusCode, {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(payload));
};

const readJson = async (request) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) throw Object.assign(new Error('Request too large'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { status: 400 });
  }
};

const checkRateLimit = (email) => {
  const now = Date.now();
  const previous = authAttempts.get(email);
  if (previous && now - previous.startedAt < 15 * 60 * 1000 && previous.count >= 8) {
    throw Object.assign(new Error('Demasiados intentos. Vuelve a probar en 15 minutos.'), {
      status: 429,
    });
  }
  if (!previous || now - previous.startedAt >= 15 * 60 * 1000) {
    authAttempts.set(email, { startedAt: now, count: 1 });
  } else {
    previous.count++;
  }
};

const makePasswordHash = async (password, salt) =>
  scrypt(password, salt, 64, { N: 32768, maxmem: 64 * 1024 * 1024 });

const issueSession = async (userId) => {
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    "insert into app_sessions (token_hash, user_id, expires_at) values ($1, $2, now() + interval '30 days')",
    [tokenHash, userId],
  );
  return token;
};

const authenticate = async (request) => {
  const token = (request.headers.authorization || '').match(/^Bearer ([A-Za-z0-9_-]{40,60})$/)?.[1];
  if (!token) return null;
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const result = await pool.query(
    'select app_users.id, app_users.email from app_sessions join app_users on app_users.id = app_sessions.user_id where app_sessions.token_hash = $1 and app_sessions.expires_at > now()',
    [tokenHash],
  );
  const user = result.rows[0];
  return user && allowedUsers.has(user.email) ? user : null;
};

const initializeDatabase = async () => {
  if (!pool) return;
  await pool.query(`
    create table if not exists app_users (
      id bigserial primary key,
      email text not null unique,
      password_salt bytea not null,
      password_hash bytea not null,
      created_at timestamptz not null default now()
    );
    create table if not exists app_sessions (
      token_hash text primary key,
      user_id bigint not null references app_users(id) on delete cascade,
      expires_at timestamptz not null
    );
    create table if not exists household_state (
      state_key text primary key,
      state_value text not null,
      updated_at timestamptz not null default now()
    );
    create table if not exists household_revision (
      id smallint primary key check (id = 1),
      revision bigint not null default 0,
      source_device text not null default '',
      updated_at timestamptz not null default now()
    );
    insert into household_revision (id) values (1) on conflict (id) do nothing;
    create index if not exists app_sessions_expiry_idx on app_sessions (expires_at);
  `);
  databaseReady = true;
};

const handleApi = async (request, response, url) => {
  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Max-Age': '86400',
    });
    response.end();
    return;
  }

  if (url.pathname === '/api/health') {
    sendJson(response, databaseReady ? 200 : 503, { status: databaseReady ? 'ok' : 'database-unavailable' });
    return;
  }
  if (!databaseReady) {
    sendJson(response, 503, { error: 'La base de datos todavía no está disponible.' });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/auth/register') {
    const body = await readJson(request);
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const inviteCode = String(body.inviteCode || '');
    checkRateLimit(email);
    if (!allowedUsers.has(email)) {
      sendJson(response, 403, { error: 'Este correo no está autorizado para el espacio familiar.' });
      return;
    }
    const configuredInvite = process.env.SIGNUP_INVITE_CODE || '';
    const inviteMatches = configuredInvite.length > 0 && inviteCode.length === configuredInvite.length &&
      crypto.timingSafeEqual(Buffer.from(inviteCode), Buffer.from(configuredInvite));
    if (!inviteMatches) {
      sendJson(response, 403, { error: 'El código de invitación no es válido.' });
      return;
    }
    if (!/^\S+@\S+\.\S+$/.test(email) || password.length < 10 || password.length > 200) {
      sendJson(response, 400, { error: 'Usa un correo válido y una contraseña de al menos 10 caracteres.' });
      return;
    }
    const salt = crypto.randomBytes(16);
    const passwordHash = await makePasswordHash(password, salt);
    try {
      const result = await pool.query(
        'insert into app_users (email, password_salt, password_hash) values ($1, $2, $3) returning id, email',
        [email, salt, passwordHash],
      );
      const user = result.rows[0];
      sendJson(response, 201, { token: await issueSession(user.id), user: { email: user.email } });
    } catch (error) {
      if (error.code === '23505') {
        sendJson(response, 409, { error: 'Ya existe una cuenta con ese correo.' });
        return;
      }
      throw error;
    }
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/auth/login') {
    const body = await readJson(request);
    const email = String(body.email || '').trim().toLowerCase();
    checkRateLimit(email);
    const result = await pool.query(
      'select id, email, password_salt, password_hash from app_users where email = $1',
      [email],
    );
    const user = result.rows[0];
    let passwordMatches = false;
    if (user && typeof body.password === 'string') {
      const candidate = await makePasswordHash(body.password, user.password_salt);
      passwordMatches = candidate.length === user.password_hash.length &&
        crypto.timingSafeEqual(candidate, user.password_hash);
    }
    if (!passwordMatches || !allowedUsers.has(email)) {
      sendJson(response, 401, { error: 'Correo o contraseña incorrectos.' });
      return;
    }
    sendJson(response, 200, {
      token: await issueSession(user.id),
      user: { email: user.email },
    });
    return;
  }

  const user = await authenticate(request);
  if (!user) {
    sendJson(response, 401, { error: 'La sesión caducó. Inicia sesión de nuevo.' });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/auth/me') {
    sendJson(response, 200, { user: { email: user.email } });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
    const token = request.headers.authorization.slice('Bearer '.length);
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    await pool.query('delete from app_sessions where token_hash = $1', [tokenHash]);
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/household/state') {
    const [state, revision] = await Promise.all([
      pool.query('select state_key, state_value from household_state order by state_key'),
      pool.query('select revision, source_device, updated_at from household_revision where id = 1'),
    ]);
    sendJson(response, 200, {
      state: Object.fromEntries(state.rows.map((row) => [row.state_key, row.state_value])),
      revision: Number(revision.rows[0].revision),
      updatedAt: revision.rows[0].updated_at,
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/household/sync') {
    const body = await readJson(request);
    const changes = body.changes;
    const deviceId = String(body.deviceId || '');
    if (!changes || typeof changes !== 'object' || Array.isArray(changes) || deviceId.length < 8 || deviceId.length > 80) {
      sendJson(response, 400, { error: 'Los cambios enviados no son válidos.' });
      return;
    }
    const entries = Object.entries(changes);
    if (entries.length > 200 || entries.some(([key, value]) =>
      !/^[a-zA-Z0-9:_-]{1,120}$/.test(key) || (value !== null && (typeof value !== 'string' || value.length > 200000)))) {
      sendJson(response, 400, { error: 'Hay datos demasiado grandes o con formato inválido.' });
      return;
    }

    const database = await pool.connect();
    try {
      await database.query('begin');
      for (const [key, value] of entries) {
        if (value === null) {
          await database.query('delete from household_state where state_key = $1', [key]);
        } else {
          await database.query(
            'insert into household_state (state_key, state_value) values ($1, $2) on conflict (state_key) do update set state_value = excluded.state_value, updated_at = now()',
            [key, value],
          );
        }
      }
      const result = await database.query(
        "update household_revision set revision = revision + 1, source_device = $1, updated_at = now() where id = 1 returning revision, updated_at",
        [deviceId],
      );
      await database.query('commit');
      sendJson(response, 200, { revision: Number(result.rows[0].revision), updatedAt: result.rows[0].updated_at });
    } catch (error) {
      await database.query('rollback');
      throw error;
    } finally {
      database.release();
    }
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/household/revision') {
    const since = Number(url.searchParams.get('since'));
    const deviceId = String(url.searchParams.get('deviceId') || '');
    if (!Number.isSafeInteger(since) || since < 0 || deviceId.length < 8 || deviceId.length > 80) {
      sendJson(response, 400, { error: 'La revisión solicitada no es válida.' });
      return;
    }
    const result = await pool.query('select revision, source_device from household_revision where id = 1');
    const revision = Number(result.rows[0].revision);
    sendJson(response, 200, {
      revision,
      changed: revision > since && result.rows[0].source_device !== deviceId,
    });
    return;
  }

  sendJson(response, 404, { error: 'Ruta no encontrada.' });
};

http.createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  } catch {
    response.writeHead(400).end('Bad request');
    return;
  }

  const url = new URL(request.url, 'http://localhost');
  if (pathname.startsWith('/api/')) {
    try {
      await handleApi(request, response, url);
    } catch (error) {
      console.error('API request failed:', error);
      sendJson(response, error.status || 500, {
        error: error.status ? error.message : 'Ocurrió un error interno.',
      });
    }
    return;
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405).end('Method not allowed');
    return;
  }

  const filePath = path.resolve(root, `.${pathname}`);
  if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  fs.stat(filePath, (error, stats) => {
    const target = !error && stats.isDirectory() ? path.join(filePath, 'index.html') : filePath;
    fs.readFile(target, (readError, content) => {
      if (readError) {
        response.writeHead(404).end('Not found');
        return;
      }

      response.writeHead(200, {
        'Content-Type': contentTypes[path.extname(target).toLowerCase()] || 'application/octet-stream',
      });
      response.end(request.method === 'HEAD' ? undefined : content);
    });
  });
}).listen(port, '0.0.0.0', () => {
  console.log(`NextFinanz web server listening on port ${port}`);
});

if (pool) {
  initializeDatabase().catch((error) => {
    console.error('PostgreSQL initialization failed:', error.message);
  });
} else {
  console.warn('DATABASE_URL is not set; the static app is available but the API is disabled.');
}