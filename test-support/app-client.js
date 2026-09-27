export function createAppClient(base, timeoutMs = 3000) {
  let cookie = '';
  return {
    async login(password = 'Cornel123') {
      const response = await fetch(`${base}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`App login failed (${response.status})`);
      cookie = response.headers.get('set-cookie')?.split(';', 1)[0] || '';
      if (!cookie) throw new Error('App login did not set a session cookie');
      return response;
    },
    request(path, options = {}) {
      const headers = new Headers(options.headers);
      if (cookie) headers.set('Cookie', cookie);
      return fetch(`${base}${path}`, {
        ...options,
        headers,
        signal: options.signal || AbortSignal.timeout(timeoutMs),
      });
    },
  };
}
