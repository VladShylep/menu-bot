// Мінімальний клієнт Google Sheets REST API для Cloudflare Workers.
// Бібліотека googleapis у Workers не працює, тому JWT для service account
// підписуємо самі через WebCrypto (RS256) і обмінюємо на access token.

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const API = 'https://sheets.googleapis.com/v4/spreadsheets';

let cachedToken = null; // { token, exp } — живе, поки живе ізолят Worker'а

function b64url(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToArrayBuffer(pem) {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

async function getAccessToken(serviceAccountJson) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.exp - 60 > now) return cachedToken.token;

  const sa = typeof serviceAccountJson === 'string' ? JSON.parse(serviceAccountJson) : serviceAccountJson;
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = { iss: sa.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 };
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(sa.private_key.replace(/\\n/g, '\n')),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const jwt = `${unsigned}.${b64url(sig)}`;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  if (!res.ok) throw new Error(`Google OAuth: ${res.status} ${await res.text()}`);
  const data = await res.json();
  cachedToken = { token: data.access_token, exp: now + (data.expires_in ?? 3600) };
  return cachedToken.token;
}

export class Sheets {
  constructor({ spreadsheetId, serviceAccountJson }) {
    this.id = spreadsheetId;
    this.sa = serviceAccountJson;
  }

  async request(path, { method = 'GET', body, query = {} } = {}) {
    const token = await getAccessToken(this.sa);
    const qs = new URLSearchParams(query).toString();
    const url = `${API}/${this.id}${path}${qs ? `?${qs}` : ''}`;
    const res = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`Google Sheets ${method} ${path}: ${res.status} ${await res.text()}`);
    return res.json();
  }

  static range(tab, a1 = 'A1:Z') {
    return encodeURIComponent(`'${tab.replace(/'/g, "''")}'!${a1}`);
  }

  async getValues(tab, a1) {
    const data = await this.request(`/values/${Sheets.range(tab, a1)}`, {
      query: { valueRenderOption: 'UNFORMATTED_VALUE', dateTimeRenderOption: 'FORMATTED_STRING' },
    });
    return data.values ?? [];
  }

  async updateValues(tab, a1, values) {
    return this.request(`/values/${Sheets.range(tab, a1)}`, {
      method: 'PUT',
      query: { valueInputOption: 'RAW' },
      body: { values },
    });
  }

  async appendValues(tab, values) {
    return this.request(`/values/${Sheets.range(tab, 'A1')}:append`, {
      method: 'POST',
      query: { valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS' },
      body: { values },
    });
  }

  async clear(tab, a1) {
    return this.request(`/values/${Sheets.range(tab, a1)}:clear`, { method: 'POST', body: {} });
  }

  async sheetTitles() {
    const data = await this.request('', { query: { fields: 'sheets.properties.title' } });
    return (data.sheets ?? []).map((s) => s.properties.title);
  }

  async addSheets(titles) {
    if (!titles.length) return;
    await this.request(':batchUpdate', {
      method: 'POST',
      body: { requests: titles.map((title) => ({ addSheet: { properties: { title } } })) },
    });
  }
}
