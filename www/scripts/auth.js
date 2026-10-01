(() => {
  const rawStorage = window.localStorage;
  const metadataPrefix = '__flynanz_';
  const tokenKey = `${metadataPrefix}session_token`;
  const emailKey = `${metadataPrefix}session_email`;
  const linkedKey = `${metadataPrefix}household_linked`;
  const pendingChanges = new Map();
  const configBase = String(window.FLYNANZ_API_BASE_URL || '').trim().replace(/\/$/, '');
  const baseUrl = configBase || (window.location.protocol.startsWith('http') ? window.location.origin : '');
  let active = false;
  let applyingRemote = false;
  let deviceId = rawStorage.getItem(`${metadataPrefix}device_id`);
  let revision = 0;
  let flushTimer;
  let pollTimer;
  let syncQueue = Promise.resolve();
  let mode = 'signin';

  if (!deviceId) {
    deviceId = Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map((part) => part.toString(16).padStart(2, '0'))
      .join('');
    rawStorage.setItem(`${metadataPrefix}device_id`, deviceId);
  }

  const isAppKey = (key) => !key.startsWith(metadataPrefix);

  const appKeys = () => {
    const keys = [];
    for (let index = 0; index < rawStorage.length; index++) {
      const key = rawStorage.key(index);
      if (key && isAppKey(key)) keys.push(key);
    }
    return keys;
  };

  const appStorage = {
    get length() {
      return active ? appKeys().length : 0;
    },
    getItem(key) {
      return active ? rawStorage.getItem(String(key)) : null;
    },
    setItem(key, value) {
      if (!active) return;
      key = String(key);
      value = String(value);
      rawStorage.setItem(key, value);
      if (!applyingRemote) queueChange(key, value);
    },
    removeItem(key) {
      if (!active) return;
      key = String(key);
      rawStorage.removeItem(key);
      if (!applyingRemote) queueChange(key, null);
    },
    clear() {
      if (!active) return;
      appKeys().forEach((key) => {
        rawStorage.removeItem(key);
        if (!applyingRemote) queueChange(key, null);
      });
    },
    key(index) {
      return active ? appKeys()[index] || null : null;
    },
  };

  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: appStorage,
  });

  const setMessage = (message, isError = false) => {
    const messageElement = document.getElementById('authMessage');
    if (!messageElement) return;
    messageElement.textContent = message || '';
    messageElement.classList.toggle('is-error', isError);
  };

  const setMode = () => {
    const signup = mode === 'signup';
    document.getElementById('authTitle').textContent = signup ? 'Crea su cuenta' : 'Bienvenido';
    document.getElementById('authCopy').textContent = signup
      ? 'El correo debe estar autorizado para el hogar.'
      : 'Inicia sesión para continuar.';
    document.getElementById('authSubmit').textContent = signup ? 'Crear cuenta' : 'Iniciar sesión';
    document.getElementById('authSwitchText').textContent = signup
      ? '¿Ya tienes cuenta?'
      : '¿Aún no tienes cuenta?';
    document.getElementById('authSwitch').textContent = signup ? 'Iniciar sesión' : 'Crear cuenta';
    document.getElementById('inviteField').hidden = !signup;
    document.getElementById('authInvite').required = signup;
    document.getElementById('authPassword').autocomplete = signup ? 'new-password' : 'current-password';
    setMessage('');
  };

  const request = async (path, options = {}) => {
    if (!baseUrl) {
      throw new Error('Configura la URL pública de Railway en scripts/authConfig.js.');
    }
    const headers = { 'Content-Type': 'application/json', ...options.headers };
    const token = rawStorage.getItem(tokenKey);
    if (token) headers.Authorization = `Bearer ${token}`;
    let response;
    try {
      response = await fetch(`${baseUrl}${path}`, { ...options, headers });
    } catch {
      throw new Error('No se pudo conectar con Railway. Comprueba la conexión a internet.');
    }
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(result.error || 'No se pudo completar la solicitud.');
      error.status = response.status;
      throw error;
    }
    return result;
  };

  const queueChange = (key, value) => {
    if (!active || applyingRemote || !isAppKey(key)) return;
    pendingChanges.set(key, value);
    clearTimeout(flushTimer);
    flushTimer = setTimeout(() => flushChanges(), 400);
  };

  const flushChanges = () => {
    if (!active || pendingChanges.size === 0) return syncQueue;
    const changes = Object.fromEntries(pendingChanges);
    pendingChanges.clear();
    syncQueue = syncQueue.catch(() => {}).then(async () => {
      const result = await request('/api/household/sync', {
        method: 'POST',
        body: JSON.stringify({ changes, deviceId }),
      });
      revision = result.revision;
    }).catch((error) => {
      Object.entries(changes).forEach(([key, value]) => {
        if (!pendingChanges.has(key)) pendingChanges.set(key, value);
      });
      ons.notification.toast('Sin conexión: los cambios se guardaron en el dispositivo y se reintentarán.', {
        timeout: 3500,
      });
      throw error;
    });
    return syncQueue;
  };

  const syncInitialState = async () => {
    const unsyncedChanges = new Map(pendingChanges);
    const remote = await request('/api/household/state');
    revision = remote.revision;
    const remoteKeys = Object.keys(remote.state);
    if (remoteKeys.length) {
      const localKeys = appKeys();
      if (!rawStorage.getItem(linkedKey) && localKeys.length) {
        const choice = await ons.notification.confirm(
          'Este teléfono ya tiene datos y el hogar también. ¿Qué información desean conservar?',
          {
            title: 'Datos en este dispositivo',
            buttonLabels: ['Usar datos del hogar', 'Compartir datos de este teléfono'],
            cancelable: false,
          },
        );
        if (choice === 1) {
          const replacement = Object.fromEntries(
            remoteKeys.map((key) => [key, null]),
          );
          localKeys.forEach((key) => {
            replacement[key] = rawStorage.getItem(key);
          });
          const result = await request('/api/household/sync', {
            method: 'POST',
            body: JSON.stringify({ changes: replacement, deviceId }),
          });
          revision = result.revision;
          rawStorage.setItem(linkedKey, 'true');
          return;
        }
      }
      applyingRemote = true;
      try {
        appKeys().forEach((key) => rawStorage.removeItem(key));
        Object.entries(remote.state).forEach(([key, value]) => rawStorage.setItem(key, value));
      } finally {
        applyingRemote = false;
      }
      applyingRemote = true;
      try {
        unsyncedChanges.forEach((value, key) => {
          if (value === null) rawStorage.removeItem(key);
          else rawStorage.setItem(key, value);
        });
      } finally {
        applyingRemote = false;
      }
      rawStorage.setItem(linkedKey, 'true');
      return;
    }

    const initialChanges = Object.fromEntries(
      appKeys().map((key) => [key, rawStorage.getItem(key)]),
    );
    if (Object.keys(initialChanges).length) {
      const result = await request('/api/household/sync', {
        method: 'POST',
        body: JSON.stringify({ changes: initialChanges, deviceId }),
      });
      revision = result.revision;
    }
    rawStorage.setItem(linkedKey, 'true');
  };

  const pollForChanges = async () => {
    if (!active) return;
    try {
      await flushChanges();
      const result = await request(
        `/api/household/revision?since=${revision}&deviceId=${encodeURIComponent(deviceId)}`,
      );
      if (result.changed) window.location.reload();
      else revision = result.revision;
    } catch (error) {
      if (/sesión caducó/i.test(error.message)) {
        rawStorage.removeItem(tokenKey);
        rawStorage.removeItem(emailKey);
        active = false;
        window.showLoginPage();
      }
    }
  };

  const openSession = async (token, email) => {
    rawStorage.setItem(tokenKey, token);
    rawStorage.setItem(emailKey, email);
    try {
      await syncInitialState();
      active = true;
      clearInterval(pollTimer);
      pollTimer = setInterval(pollForChanges, 5000);
      window.resumeAppWithSession();
    } catch (error) {
      try {
        await request('/api/auth/logout', { method: 'POST' });
      } catch {
      }
      rawStorage.removeItem(tokenKey);
      rawStorage.removeItem(emailKey);
      active = false;
      setMessage(error.message, true);
    }
  };

  window.FlynanzAuth = {
    initialize: async () => {
      const token = rawStorage.getItem(tokenKey);
      if (!token) return null;
      try {
        const result = await request('/api/auth/me');
        await syncInitialState();
        active = true;
        clearInterval(pollTimer);
        pollTimer = setInterval(pollForChanges, 5000);
        return result.user;
      } catch (error) {
        if (error.status === 401) {
          rawStorage.removeItem(tokenKey);
          rawStorage.removeItem(emailKey);
        }
        if (/conectar con Railway|configura la URL/i.test(error.message)) throw error;
        if (error.status !== 401) throw error;
        return null;
      }
    },
    submit: async (event) => {
      event.preventDefault();
      setMessage('');
      const email = document.getElementById('authEmail').value.trim();
      const password = document.getElementById('authPassword').value;
      const signup = mode === 'signup';
      const submitButton = document.getElementById('authSubmit');
      submitButton.disabled = true;
      try {
        const result = await request(signup ? '/api/auth/register' : '/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({
            email,
            password,
            inviteCode: signup ? document.getElementById('authInvite').value : undefined,
          }),
        });
        await openSession(result.token, result.user.email);
      } catch (error) {
        setMessage(error.message, true);
      } finally {
        submitButton.disabled = false;
      }
      return false;
    },
    toggleMode: () => {
      mode = mode === 'signin' ? 'signup' : 'signin';
      setMode();
    },
    signOut: async () => {
      try {
        clearTimeout(flushTimer);
        await flushChanges();
        await request('/api/auth/logout', { method: 'POST' });
        clearInterval(pollTimer);
        appKeys().forEach((key) => rawStorage.removeItem(key));
        rawStorage.removeItem(tokenKey);
        rawStorage.removeItem(emailKey);
        pendingChanges.clear();
        active = false;
        window.showLoginPage();
      } catch (error) {
        ons.notification.toast(error.message, { timeout: 3500 });
      }
    },
    setMessage,
  };

  document.addEventListener('show', (event) => {
    if (event.target.matches('#loginPage')) {
      setMessage(baseUrl ? '' : 'Configura la URL de Railway en scripts/authConfig.js.', !baseUrl);
    }
  });
})();