/* Read-only Google Calendar access via the desktop OAuth flow (system browser + loopback redirect + PKCE).
   Tokens are encrypted with Electron safeStorage (Windows DPAPI) in their own file, which is never part of an export. */
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
// SRTS_GOOGLE_TEST_BASE points these at a local fake Google server; used only by the automated tests.
const TB = process.env.SRTS_DATA_DIR && process.env.SRTS_GOOGLE_TEST_BASE;
const AUTH_URL = TB ? TB + '/auth' : 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = TB ? TB + '/token' : 'https://oauth2.googleapis.com/token';
const API = TB ? TB + '/calendar/v3' : 'https://www.googleapis.com/calendar/v3';

let ctx = null; // {dir, safeStorage, extraDirs, openExternal}
const init = c => { ctx = c; };
const tokenFile = () => path.join(ctx.dir, 'google-auth.bin');
const clientFile = () => path.join(ctx.dir, 'google-client.json');

class GoogleError extends Error { constructor(msg, code) { super(msg); this.code = code; } }
const b64u = b => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// ---------- client (the app's Google project credentials, not the manager's) ----------
function readClient() {
  const cands = [clientFile(), ...ctx.extraDirs.map(d => path.join(d, 'google-client.json'))];
  for (const f of cands) {
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''));
      const c = j.installed || j.web || j;           // accepts the file downloaded from Google Cloud as-is
      if (c.client_id || c.clientId) return { clientId: c.client_id || c.clientId, clientSecret: c.client_secret || c.clientSecret || '', source: f };
    } catch (_) {}
  }
  return null;
}
function saveClient(clientId, clientSecret) {
  clientId = (clientId || '').trim(); clientSecret = (clientSecret || '').trim();
  if (!/\.apps\.googleusercontent\.com$/.test(clientId)) throw new GoogleError('That does not look like a Google Client ID (it should end in .apps.googleusercontent.com).', 'bad_client');
  fs.writeFileSync(clientFile(), JSON.stringify({ clientId, clientSecret }, null, 1), 'utf8');
}

// ---------- token storage ----------
function readTokens() {
  try {
    if (!fs.existsSync(tokenFile())) return null;
    if (!ctx.safeStorage.isEncryptionAvailable()) return null;
    return JSON.parse(ctx.safeStorage.decryptString(fs.readFileSync(tokenFile())));
  } catch (_) { return null; }
}
function writeTokens(t) {
  if (!ctx.safeStorage.isEncryptionAvailable()) throw new GoogleError('Windows secure storage is not available, so the app will not save a Google sign-in.', 'no_safe_storage');
  fs.writeFileSync(tokenFile(), ctx.safeStorage.encryptString(JSON.stringify(t)));
}
function status() {
  const c = readClient(), t = readTokens();
  return { configured: !!c, clientSource: c ? c.source : null, connected: !!(t && t.refresh_token), account: t ? t.account || null : null, connectedAt: t ? t.connectedAt || null : null };
}

// ---------- OAuth ----------
async function tokenRequest(params) {
  const c = readClient(); if (!c) throw new GoogleError('Google is not set up yet. See the Google tab.', 'not_configured');
  const body = new URLSearchParams({ client_id: c.clientId, ...(c.clientSecret ? { client_secret: c.clientSecret } : {}), ...params });
  let res;
  try { res = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }); }
  catch (e) { throw new GoogleError('Could not reach Google. Check the internet connection.', 'offline'); }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (j.error === 'invalid_grant') throw new GoogleError('Google access was revoked or expired. Please reconnect Google Calendar.', 'reauth');
    throw new GoogleError(`Google sign-in failed: ${j.error_description || j.error || res.status}`, 'auth');
  }
  return j;
}

/** Opens the browser, waits for the redirect on 127.0.0.1, exchanges the code. */
function connect() {
  const c = readClient();
  if (!c) return Promise.reject(new GoogleError('Google is not set up yet. See the Google tab.', 'not_configured'));
  const verifier = b64u(crypto.randomBytes(48));
  const challenge = b64u(crypto.createHash('sha256').update(verifier).digest());
  const state = b64u(crypto.randomBytes(16));
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); server.close(); fn(v); };
    const server = http.createServer(async (req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== '/callback') { res.writeHead(404); return res.end(); }
      const esc = x => String(x).replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';');
      const page = (title, msg) => { title = esc(title); msg = esc(msg); res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(`<!doctype html><meta charset=utf-8><title>${title}</title><body style="font:16px Segoe UI,sans-serif;max-width:480px;margin:15vh auto;text-align:center"><h2>${title}</h2><p>${msg}</p>`); };
      if (u.searchParams.get('state') !== state) { page('Sign-in failed', 'Unexpected response. Close this tab and try again.'); return finish(reject, new GoogleError('Sign-in response did not match. Try again.', 'auth')); }
      if (u.searchParams.get('error')) { page('Not connected', 'Google Calendar access was not granted. You can close this tab.'); return finish(reject, new GoogleError(u.searchParams.get('error') === 'access_denied' ? 'Access was not granted in the browser.' : `Google returned: ${u.searchParams.get('error')}`, 'denied')); }
      try {
        const j = await tokenRequest({ code: u.searchParams.get('code'), code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: `http://127.0.0.1:${server.address().port}/callback` });
        let account = null;
        try { const r = await fetch(`${API}/calendars/primary`, { headers: { Authorization: `Bearer ${j.access_token}` } }); account = (await r.json()).id || null; } catch (_) {}
        if (!j.refresh_token) throw new GoogleError('Google did not return a long-lived sign-in. Remove the app at myaccount.google.com/permissions and connect again.', 'no_refresh');
        writeTokens({ refresh_token: j.refresh_token, access_token: j.access_token, expires_at: Date.now() + (j.expires_in - 60) * 1000, account, connectedAt: new Date().toISOString() });
        page('Connected', 'Santa Rosa Tile Scheduler can now read your calendar. You can close this tab and return to the app.');
        finish(resolve, status());
      } catch (e) { page('Sign-in failed', e.message); finish(reject, e); }
    });
    const timer = setTimeout(() => finish(reject, new GoogleError('Timed out waiting for the browser sign-in (3 minutes).', 'timeout')), 180000);
    server.on('error', e => finish(reject, new GoogleError('Could not start the local sign-in listener: ' + e.message, 'listen')));
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const q = new URLSearchParams({ client_id: c.clientId, redirect_uri: `http://127.0.0.1:${port}/callback`, response_type: 'code', scope: SCOPE, code_challenge: challenge, code_challenge_method: 'S256', state, access_type: 'offline', prompt: 'consent' });
      ctx.openExternal(`${AUTH_URL}?${q}`);
    });
  });
}

async function accessToken() {
  const t = readTokens();
  if (!t || !t.refresh_token) throw new GoogleError('Google Calendar is not connected.', 'not_connected');
  if (t.access_token && t.expires_at > Date.now()) return t.access_token;
  const j = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token });
  writeTokens({ ...t, access_token: j.access_token, expires_at: Date.now() + (j.expires_in - 60) * 1000 });
  return j.access_token;
}
async function api(pathAndQuery) {
  const tok = await accessToken();
  let res;
  try { res = await fetch(API + pathAndQuery, { headers: { Authorization: `Bearer ${tok}` } }); }
  catch (_) { throw new GoogleError('Could not reach Google. Check the internet connection.', 'offline'); }
  if (res.status === 401) throw new GoogleError('Google access expired. Please reconnect Google Calendar.', 'reauth');
  if (res.status === 403) throw new GoogleError('Google refused the request (the Calendar API may not be enabled for this app).', 'forbidden');
  if (!res.ok) throw new GoogleError(`Google Calendar returned an error (${res.status}).`, 'api');
  return res.json();
}

async function listCalendars() {
  const j = await api('/users/me/calendarList?minAccessRole=reader&maxResults=250');
  return (j.items || []).map(c => ({ id: c.id, name: c.summaryOverride || c.summary, primary: !!c.primary }));
}
async function fetchEvents(calendarIds, timeMin, timeMax) {
  const out = [];
  for (const id of calendarIds) {
    let pageToken = '';
    do {
      const q = new URLSearchParams({ singleEvents: 'true', orderBy: 'startTime', maxResults: '250', timeMin, timeMax, ...(pageToken ? { pageToken } : {}) });
      const j = await api(`/calendars/${encodeURIComponent(id)}/events?${q}`);
      out.push(...(j.items || [])); pageToken = j.nextPageToken || '';
    } while (pageToken);
  }
  return out;
}
async function disconnect() {
  const t = readTokens();
  try { fs.unlinkSync(tokenFile()); } catch (_) {}
  if (t && t.refresh_token) { try { await fetch('https://oauth2.googleapis.com/revoke', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: t.refresh_token }) }); } catch (_) {} }
  return status();
}

module.exports = { init, status, saveClient, connect, listCalendars, fetchEvents, disconnect, GoogleError };
