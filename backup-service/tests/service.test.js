import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { Readable } from 'node:stream';
import { APP_ORIGIN, COOKIE_NAME, canonical, createHandler, readConfig, seal, unseal } from '../lib/service.js';

const epoch = Date.parse('2026-10-12T06:00:00Z');
const env = { GITHUB_CLIENT_ID: 'Iv1.test', GITHUB_CLIENT_SECRET: 'test-only-client-secret',
  SESSION_SECRET: Buffer.alloc(32, 31).toString('base64'), ALLOWED_GITHUB_USER_ID: '89184687',
  APP_ORIGIN, SERVICE_ORIGIN: 'https://backup.example.test',
  BACKUP_OWNER: 'ielts-wanglu-dictation', BACKUP_REPO: 'wanglu-dictation-backups' };
const config = readConfig(env);
const user = { id: '89184687', login: 'scpsyl', avatarUrl: '' };
const prefix = '/repos/ielts-wanglu-dictation/wanglu-dictation-backups';
function session(overrides = {}) {
  return seal({ user, accessToken: 'ghu_access_test_only', accessExpiresAt: epoch + 28800000,
    refreshToken: 'ghr_refresh_test_only', refreshExpiresAt: epoch + 15897600000,
    issuedAt: epoch, expiresAt: epoch + 2592000000, ...overrides }, config);
}
function envelope(overrides = {}) {
  const state = overrides.state || { version: 1, settings: { dailyGoal: 50 }, history: [], reviews: {}, draft: null };
  return { format: 'wanglu-github-backup', version: 1, revisionId: randomUUID(), parentRevisionId: null,
    updatedAt: new Date(epoch).toISOString(), studyDay: '2026-10-12', ...overrides, state,
    stateHash: createHash('sha256').update(canonical(state)).digest('hex') };
}
function blobSha(bytes) { return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'); }
function mockGithub() {
  const calls = [], files = new Map(), blobs = new Map();
  const model = { calls, files, isPrivate: true, userId: 89184687, race: false, invalidHash: false,
    setFile(path, data) { const bytes = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data)); files.set(path, bytes); blobs.set(blobSha(bytes), bytes); },
    async fetch(url, options = {}) {
      const parsed = new URL(url), path = parsed.pathname, method = options.method || 'GET';
      calls.push({ url, options, path, method });
      const reply = (data, status = 200) => new Response(status === 204 ? null : JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
      if (url === 'https://github.com/login/oauth/access_token') return reply({ access_token: 'ghu_new_token',
        token_type: 'bearer', expires_in: 28800, refresh_token: 'ghr_new_refresh', refresh_token_expires_in: 15897600 });
      if (path === '/user') return reply({ id: model.userId, login: 'scpsyl', avatar_url: 'https://avatars.githubusercontent.com/u/89184687' });
      if (path === prefix) return reply({ private: model.isPrivate, name: 'wanglu-dictation-backups', owner: { login: 'ielts-wanglu-dictation' } });
      if (path.startsWith(`${prefix}/contents/`)) {
        const filePath = path.slice(`${prefix}/contents/`.length);
        if (method === 'PUT') {
          const input = JSON.parse(options.body), previous = files.get(filePath);
          if (model.race || (previous && input.sha !== blobSha(previous)) || (!previous && input.sha)) return reply({ message: 'conflict' }, 409);
          assert.equal(filePath, 'latest.json');
          assert.equal(input.branch, 'main');
          model.setFile(filePath, Buffer.from(input.content, 'base64').toString('utf8'));
          return reply({ content: { sha: blobSha(files.get(filePath)) } }, previous ? 200 : 201);
        }
        assert.equal(parsed.searchParams.get('ref'), 'main');
        const bytes = files.get(filePath);
        if (!bytes) return reply({ message: 'Not found' }, 404);
        const sha = blobSha(bytes);
        return reply({ type: 'file', sha: model.invalidHash ? 'b'.repeat(40) : sha, size: bytes.length,
          encoding: bytes.length > 1024 * 1024 ? 'none' : 'base64', content: bytes.length > 1024 * 1024 ? '' : bytes.toString('base64') });
      }
      if (path.startsWith(`${prefix}/git/blobs/`)) {
        const sha = path.split('/').at(-1), bytes = blobs.get(sha);
        return bytes ? reply({ sha, size: bytes.length, encoding: 'base64', content: bytes.toString('base64') }) : reply({}, 404);
      }
      if (path === '/applications/Iv1.test/token' && method === 'DELETE') return reply(null, 204);
      throw new Error(`Unexpected mock URL: ${method} ${url}`);
    },
  };
  return model;
}
function setup() {
  const github = mockGithub();
  const handler = createHandler({ env, fetchImpl: github.fetch, now: () => epoch });
  return { github, handler };
}
async function call(handler, path, { method = 'GET', token, body, headers = {}, origin = APP_ORIGIN } = {}) {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
  req.url = path; req.method = method;
  req.headers = { ...(origin ? { origin } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers };
  const result = { status: 200, headers: {}, text: '' };
  const res = { setHeader(name, value) { result.headers[name.toLowerCase()] = value; },
    set statusCode(value) { result.status = value; }, end(value = '') { result.text = value; } };
  await handler(req, res);
  if (result.headers['content-type']?.startsWith('application/json')) result.json = JSON.parse(result.text);
  return result;
}
async function oauthStart(handler) {
  const nonce = 'frontend_nonce_1234567890123456';
  const start = await call(handler, `/auth/start?nonce=${nonce}`, { origin: null });
  assert.equal(start.status, 302);
  const cookieHeader = start.headers['set-cookie'].split(';')[0];
  const saved = unseal(cookieHeader.slice(COOKIE_NAME.length + 1), config, 'oauth-state');
  return { start, nonce, cookieHeader, saved };
}

test('OAuth uses one-time cookie, fixed callback, no broad scopes, and PKCE through exchange', async () => {
  const { handler, github } = setup();
  const { start, nonce, saved, cookieHeader } = await oauthStart(handler);
  assert.match(start.headers['set-cookie'], /HttpOnly; Secure; SameSite=Lax/);
  const authorize = new URL(start.headers.location);
  assert.equal(authorize.origin, 'https://github.com');
  assert.equal(authorize.searchParams.get('redirect_uri'), `${env.SERVICE_ORIGIN}/auth/callback`);
  assert.equal(authorize.searchParams.has('scope'), false);
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorize.searchParams.get('code_challenge'), createHash('sha256').update(saved.verifier).digest('base64url'));
  const callback = await call(handler, `/auth/callback?code=test-code&state=${saved.state}`, { origin: null, headers: { cookie: cookieHeader } });
  assert.equal(callback.status, 200);
  assert.match(callback.headers['set-cookie'], /Max-Age=0/);
  assert.match(callback.headers['content-security-policy'], /script-src 'nonce-/);
  assert.match(callback.text, /postMessage\(result,"https:\/\/ielts-wanglu-dictation.github.io"\)/);
  assert.equal(callback.text.includes('ghu_'), false);
  assert.equal(callback.text.includes('ghr_'), false);
  const result = JSON.parse(callback.text.match(/const result=(.*?);if\(window.opener\)/)[1]);
  assert.equal(result.nonce, nonce);
  assert.equal(result.user.id, env.ALLOWED_GITHUB_USER_ID);
  assert.equal(unseal(result.session, config).accessToken, 'ghu_new_token');
  const exchange = github.calls.find(item => item.url.includes('/login/oauth/access_token'));
  assert.equal(JSON.parse(exchange.options.body).code_verifier, saved.verifier);
});

test('OAuth wrong, missing and Unicode states fail before any GitHub exchange', async () => {
  for (const state of ['wrong-state-123456789', '界'.repeat(43), '']) {
    const { handler, github } = setup();
    const { cookieHeader } = await oauthStart(handler);
    const response = await call(handler, `/auth/callback?code=x&state=${encodeURIComponent(state)}`, { origin: null, headers: { cookie: cookieHeader } });
    assert.equal(response.status, 400);
    assert.equal(github.calls.length, 0);
  }
});

test('OAuth rejects forbidden user and does not issue a session', async () => {
  const { handler, github } = setup(); github.userId = 7;
  const { saved, cookieHeader } = await oauthStart(handler);
  const response = await call(handler, `/auth/callback?code=x&state=${saved.state}`, { origin: null, headers: { cookie: cookieHeader } });
  assert.equal(response.status, 403);
  assert.match(response.text, /USER_NOT_ALLOWED/);
  assert.equal(response.text.includes('"session":'), false);
  assert.equal(github.calls.some(item => item.path === prefix), false);
});

test('CORS accepts exact frontend only, preflights explicit headers, and never uses cookie auth', async () => {
  const { handler, github } = setup();
  const bad = await call(handler, '/api/backup', { token: session(), origin: 'https://evil.example' });
  assert.equal(bad.status, 403); assert.equal(bad.headers['access-control-allow-origin'], undefined);
  const good = await call(handler, '/api/backup', { method: 'OPTIONS', headers: { 'access-control-request-method': 'PUT', 'access-control-request-headers': 'authorization,content-type' } });
  assert.equal(good.status, 204); assert.equal(good.headers['access-control-allow-origin'], APP_ORIGIN);
  const cookieOnly = await call(handler, '/api/session', { headers: { cookie: `session=${session()}` } });
  assert.equal(cookieOnly.status, 401); assert.equal(github.calls.length, 0);
});

test('AES sessions reject tampering, wrong audience, expiry and forbidden ID', async () => {
  const { handler } = setup();
  const original = session();
  const changed = original.slice(0, 30) + (original[30] === 'A' ? 'B' : 'A') + original.slice(31);
  const wrongAudience = seal({ user, expiresAt: epoch + 1000, accessToken: 'ghu_x', accessExpiresAt: epoch + 1000 }, { ...config, serviceOrigin: 'https://other.test' });
  for (const token of [changed, wrongAudience, session({ expiresAt: epoch - 1 }), session({ user: { ...user, id: '7' } })]) {
    assert.equal((await call(handler, '/api/session', { token })).status, 401);
  }
});

test('backup operations refuse a public repository before reading or writing any study file', async () => {
  const { handler, github } = setup(); github.isPrivate = false;
  const result = await call(handler, '/api/backup', { method: 'PUT', token: session(), body: { baseSha: null, envelope: envelope() } });
  assert.equal(result.status, 403); assert.equal(result.json.error.code, 'PRIVATE_REPOSITORY_REQUIRED');
  assert.equal(github.calls.length, 1);
});

test('first backup creates only latest.json; updates require current SHA and revision parent', async () => {
  const { handler, github } = setup(), token = session(), first = envelope();
  const missing = await call(handler, '/api/backup', { token });
  assert.deepEqual({ exists: missing.json.exists, sha: missing.json.sha, envelope: missing.json.envelope }, { exists: false, sha: null, envelope: null });
  const saved = await call(handler, '/api/backup', { method: 'PUT', token, body: { baseSha: null, envelope: first } });
  assert.equal(saved.status, 200);
  const next = envelope({ parentRevisionId: first.revisionId });
  const stale = await call(handler, '/api/backup', { method: 'PUT', token, body: { baseSha: null, envelope: next } });
  assert.equal(stale.status, 409);
  const badParent = await call(handler, '/api/backup', { method: 'PUT', token, body: { baseSha: saved.json.sha, envelope: envelope() } });
  assert.equal(badParent.status, 409);
  const updated = await call(handler, '/api/backup', { method: 'PUT', token, body: { baseSha: saved.json.sha, envelope: next } });
  assert.equal(updated.status, 200); assert.notEqual(updated.json.sha, saved.json.sha);
  assert.deepEqual(JSON.parse(github.files.get('latest.json')), next);
});

test('GitHub CAS conflict during PUT stays a409 without retry or overwrite', async () => {
  const { handler, github } = setup(); github.race = true;
  const response = await call(handler, '/api/backup', { method: 'PUT', token: session(), body: { baseSha: null, envelope: envelope() } });
  assert.equal(response.status, 409); assert.equal(github.calls.filter(item => item.method === 'PUT').length, 1);
});

test('integrity mismatch and prototype-pollution fields never reach GitHub PUT', async () => {
  const { handler, github } = setup();
  const mismatch = envelope(); mismatch.state.settings.dailyGoal = 100;
  const result = await call(handler, '/api/backup', { method: 'PUT', token: session(), body: { baseSha: null, envelope: mismatch } });
  assert.equal(result.status, 400); assert.equal(result.json.error.code, 'HASH_MISMATCH');
  const unsafe = envelope(); unsafe.state.settings = JSON.parse('{"__proto__":{"polluted":true}}');
  const response = await call(handler, '/api/backup', { method: 'PUT', token: session(), body: { baseSha: null, envelope: unsafe } });
  assert.equal(response.status, 400); assert.equal(github.calls.some(item => item.method === 'PUT'), false);
  assert.equal({}.polluted, undefined);
});

test('large gzip request saves readable JSON and GET uses immutable Git blob then gzip response', async () => {
  const { handler, github } = setup();
  const state = envelope().state; state.settings.largeTestData = '词汇'.repeat(220000);
  const data = envelope({ state }), compressed = gzipSync(JSON.stringify(data)).toString('base64');
  const saved = await call(handler, '/api/backup', { method: 'PUT', token: session(), body: { baseSha: null, envelopeGzip: compressed } });
  assert.equal(saved.status, 200);
  assert.equal(github.files.get('latest.json')[0], '{'.charCodeAt(0));
  const fetched = await call(handler, '/api/backup', { token: session() });
  assert.equal(fetched.status, 200); assert.equal(fetched.json.envelope, undefined);
  assert.deepEqual(JSON.parse(gunzipSync(Buffer.from(fetched.json.envelopeGzip, 'base64'))), data);
  assert.ok(github.calls.some(item => item.path === `${prefix}/git/blobs/${saved.json.sha}`));
});

test('malformed gzip, decompression bombs and ambiguous transport are rejected', async () => {
  const { handler } = setup();
  for (const body of [
    { baseSha: null, envelopeGzip: 'not-gzip' },
    { baseSha: null, envelope: envelope(), envelopeGzip: 'eA==' },
    { baseSha: null, envelopeGzip: gzipSync(Buffer.alloc(10 * 1024 * 1024 + 1, 65)).toString('base64') },
  ]) assert.equal((await call(handler, '/api/backup', { method: 'PUT', token: session(), body })).status, 400);
});

test('refresh rotates both GitHub tokens and returns an opaque replacement session', async () => {
  const { handler, github } = setup();
  const response = await call(handler, '/api/session', { token: session({ accessExpiresAt: epoch - 1 }) });
  assert.equal(response.status, 200); assert.ok(response.json.refreshedSession);
  const refreshed = unseal(response.json.refreshedSession, config);
  assert.equal(refreshed.accessToken, 'ghu_new_token'); assert.equal(refreshed.refreshToken, 'ghr_new_refresh');
  const tokenCall = github.calls.find(item => item.url.includes('/login/oauth/access_token'));
  assert.equal(JSON.parse(tokenCall.options.body).grant_type, 'refresh_token');
  assert.equal(response.text.includes('ghu_'), false); assert.equal(response.text.includes('ghr_'), false);
});

test('refreshed session is preserved on subsequent conflict/error response', async () => {
  const { handler, github } = setup(); github.race = true;
  const result = await call(handler, '/api/backup', { method: 'PUT', token: session({ accessExpiresAt: epoch - 1 }), body: { baseSha: null, envelope: envelope() } });
  assert.equal(result.status, 409); assert.ok(result.json.refreshedSession);
});

test('historical snapshots use validated fixed paths and are read-only', async () => {
  const { handler, github } = setup(), historic = envelope();
  github.setFile('snapshots/2026-10-12.json', historic);
  github.setFile('snapshots/index.json', { format: 'wanglu-github-backup-index', version: 1, snapshots: [{ date: '2026-10-12',
    path: 'snapshots/2026-10-12.json', stateHash: historic.stateHash, revisionId: historic.revisionId,
    archivedAt: new Date(epoch).toISOString(), sourceUpdatedAt: historic.updatedAt, sourceCommit: 'a'.repeat(40) }] });
  const index = await call(handler, '/api/snapshots', { token: session() });
  assert.equal(index.status, 200); assert.equal(index.json.snapshots.length, 1);
  const result = await call(handler, '/api/backup?date=2026-10-12', { token: session() });
  assert.equal(result.status, 200); assert.deepEqual(result.json.envelope, historic);
  const invalid = await call(handler, '/api/backup?date=2026-02-30', { token: session() });
  assert.equal(invalid.status, 400);
  const traversal = await call(handler, '/api/backup?date=../../secret', { token: session() });
  assert.equal(traversal.status, 400);
  const write = await call(handler, '/api/backup?date=2026-10-12', { method: 'PUT', token: session(), body: {} });
  assert.equal(write.status, 405);
});

test('logout revokes only the current GitHub token and returns no credentials', async () => {
  const { handler, github } = setup();
  const result = await call(handler, '/api/logout', { method: 'POST', token: session() });
  assert.equal(result.status, 200); assert.deepEqual(result.json, { ok: true });
  const request = github.calls.find(item => item.method === 'DELETE');
  assert.equal(request.path, '/applications/Iv1.test/token');
  assert.equal(JSON.parse(request.options.body).access_token, 'ghu_access_test_only');
});

test('rewritten Vercel URL routes correctly and config errors expose no secrets', async () => {
  const { handler } = setup();
  assert.equal((await call(handler, '/api/handler?route=health')).status, 200);
  const broken = createHandler({ env: { ...env, SESSION_SECRET: 'invalid' } });
  const response = await call(broken, '/health');
  assert.equal(response.status, 503); assert.equal(response.text.includes('test-only-client-secret'), false);
});
