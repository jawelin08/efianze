const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const mysql = require('mysql2/promise');

const root = path.resolve(__dirname, 'www');
const port = Number(process.env.PORT) || 4354;
const scrypt = promisify(crypto.scrypt);
const allowedUsers = new Set(
  (process.env.ALLOWED_USERS || '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean),
);
const mysqlUrl = process.env.MYSQL_URL || process.env.MYSQL_PUBLIC_URL;
const mysqlHost = process.env.MYSQLHOST || process.env.MYSQL_HOST;
const pool = mysqlUrl
  ? mysql.createPool(mysqlUrl)
  : mysqlHost && process.env.MYSQLUSER && process.env.MYSQLPASSWORD && process.env.MYSQLDATABASE
    ? mysql.createPool({
        host: mysqlHost,
        port: Number(process.env.MYSQLPORT || process.env.MYSQL_PORT || 3306),
        user: process.env.MYSQLUSER,
        password: process.env.MYSQLPASSWORD,
        database: process.env.MYSQLDATABASE,
        waitForConnections: true,
        connectionLimit: 10,
        enableKeepAlive: true,
      })
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
  await pool.execute(
    'insert into app_sessions (token_hash, user_id, expires_at) values (?, ?, date_add(current_timestamp, interval 30 day))',
    [tokenHash, userId],
  );
  return token;
};

const authenticate = async (request) => {
  const token = (request.headers.authorization || '').match(/^Bearer ([A-Za-z0-9_-]{40,60})$/)?.[1];
  if (!token) return null;
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const [rows] = await pool.execute(
    'select app_users.id, app_users.email from app_sessions join app_users on app_users.id = app_sessions.user_id where app_sessions.token_hash = ? and app_sessions.expires_at > current_timestamp',
    [tokenHash],
  );
  const user = rows[0];
  return user && allowedUsers.has(user.email) ? user : null;
};

const initializeDatabase = async () => {
  if (!pool) return;
  await pool.query(`
    create table if not exists app_users (
      id bigint unsigned not null auto_increment primary key,
      email varchar(320) not null unique,
      password_salt varbinary(16) not null,
      password_hash varbinary(64) not null,
      created_at timestamp not null default current_timestamp
    ) engine=InnoDB;
  `);
  await pool.query(`
    create table if not exists app_sessions (
      token_hash char(64) not null primary key,
      user_id bigint unsigned not null,
      expires_at datetime not null,
      created_at timestamp not null default current_timestamp,
      index app_sessions_user_id_idx (user_id),
      index app_sessions_expiry_idx (expires_at),
      constraint app_sessions_user_fk foreign key (user_id) references app_users(id) on delete cascade
    ) engine=InnoDB;
  `);
  await pool.query(`
    create table if not exists household_state (
      state_key varchar(120) not null primary key,
      state_value mediumtext not null,
      updated_at timestamp not null default current_timestamp on update current_timestamp
    ) engine=InnoDB;
  `);
  await pool.query(`
    create table if not exists household_revision (
      id tinyint unsigned not null primary key,
      revision bigint unsigned not null default 0,
      source_device varchar(80) not null default '',
      updated_at timestamp not null default current_timestamp on update current_timestamp
    ) engine=InnoDB;
  `);
  await pool.execute(
    'insert ignore into household_revision (id, revision, source_device) values (1, 0, ?)',
    [''],
  );
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
    checkRateLimit(email);
    if (!allowedUsers.has(email)) {
      sendJson(response, 403, { error: 'Este correo no está autorizado para el espacio familiar.' });
      return;
    }
    if (!/^\S+@\S+\.\S+$/.test(email) || password.length < 10 || password.length > 200) {
      sendJson(response, 400, { error: 'Usa un correo válido y una contraseña de al menos 10 caracteres.' });
      return;
    }
    const salt = crypto.randomBytes(16);
    const passwordHash = await makePasswordHash(password, salt);
    try {
      const [result] = await pool.execute(
        'insert into app_users (email, password_salt, password_hash) values (?, ?, ?)',
        [email, salt, passwordHash],
      );
      sendJson(response, 201, {
        token: await issueSession(result.insertId),
        user: { email },
      });
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') {
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
    const [rows] = await pool.execute(
      'select id, email, password_salt, password_hash from app_users where email = ?',
      [email],
    );
    const user = rows[0];
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
    await pool.execute('delete from app_sessions where token_hash = ?', [tokenHash]);
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/household/state') {
    const [stateResult, revisionResult] = await Promise.all([
      pool.query('select state_key, state_value from household_state order by state_key'),
      pool.query('select revision, source_device, updated_at from household_revision where id = 1'),
    ]);
    const [stateRows] = stateResult;
    const [revisionRows] = revisionResult;
    sendJson(response, 200, {
      state: Object.fromEntries(stateRows.map((row) => [row.state_key, row.state_value])),
      revision: Number(revisionRows[0].revision),
      updatedAt: revisionRows[0].updated_at,
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

    const database = await pool.getConnection();
    try {
      await database.beginTransaction();
      for (const [key, value] of entries) {
        if (value === null) {
          await database.execute('delete from household_state where state_key = ?', [key]);
        } else {
          await database.execute(
            'insert into household_state (state_key, state_value) values (?, ?) on duplicate key update state_value = values(state_value), updated_at = current_timestamp',
            [key, value],
          );
        }
      }
      await database.execute(
        'update household_revision set revision = revision + 1, source_device = ?, updated_at = current_timestamp where id = 1',
        [deviceId],
      );
      const [revisionRows] = await database.query(
        'select revision, updated_at from household_revision where id = 1',
      );
      await database.commit();
      sendJson(response, 200, {
        revision: Number(revisionRows[0].revision),
        updatedAt: revisionRows[0].updated_at,
      });
    } catch (error) {
      await database.rollback();
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
    const [rows] = await pool.query('select revision, source_device from household_revision where id = 1');
    const revision = Number(rows[0].revision);
    sendJson(response, 200, {
      revision,
      changed: revision > since && rows[0].source_device !== deviceId,
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
    console.error('MySQL initialization failed:', error.message);
  });
} else {
  console.warn('MySQL is not configured; the static app is available but the API is disabled.');
}