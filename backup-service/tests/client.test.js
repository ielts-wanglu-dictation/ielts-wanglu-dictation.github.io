import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { BackupClient, SESSION_KEY, hashState } from '../../backup.js';
import { createInitialState } from '../../core.js';
import { allWords } from '../../data.js';
import { APP_ORIGIN, createHandler } from '../lib/service.js';

const SERVICE = 'https://client-integration.example.test';
const instant = new Date('2026-10-12T06:00:00.000Z');
const prefix = '/repos/ielts-wanglu-dictation/wanglu-dictation-backups';
const env = { GITHUB_CLIENT_ID: 'Iv1.integration', GITHUB_CLIENT_SECRET: 'integration-test-only-secret',
  SESSION_SECRET: Buffer.alloc(32, 97).toString('base64'), ALLOWED_GITHUB_USER_ID: '89184687',
  APP_ORIGIN, SERVICE_ORIGIN: SERVICE,
  BACKUP_OWNER: 'ielts-wanglu-dictation', BACKUP_REPO: 'wanglu-dictation-backups' };
const blobSha = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const reply = (value, status = 200) => new Response(status === 204 ? null : JSON.stringify(value),
  { status, headers: { 'Content-Type': 'application/json' } });

/** Only the external GitHub boundary is mocked; all client and service code is real. */
function system() {
  const files = new Map(), blobs = new Map(), githubCalls = [], serviceCalls = [];
  let tokenSequence = 0;
  const github = async (url, options = {}) => {
    const parsed = new URL(url), pathname = parsed.pathname, method = options.method || 'GET';
    githubCalls.push({ pathname, method, options });
    if (url === 'https://github.com/login/oauth/access_token') {
      const request = JSON.parse(options.body);
      assert.ok(request.code_verifier, 'the actual callback sends PKCE verification');
      return reply({ access_token: `ghu_integration_access_${++tokenSequence}`, token_type: 'bearer',
        expires_in: 28800, refresh_token: `ghr_integration_refresh_${tokenSequence}`, refresh_token_expires_in: 15897600 });
    }
    if (pathname === '/user') return reply({ id: 89184687, login: 'scpsyl' });
    if (pathname === prefix) return reply({ private: true, name: 'wanglu-dictation-backups',
      owner: { login: 'ielts-wanglu-dictation' } });
    if (pathname.startsWith(`${prefix}/contents/`)) {
      const name = pathname.slice(`${prefix}/contents/`.length);
      const current = files.get(name);
      if (method === 'PUT') {
        const request = JSON.parse(options.body);
        assert.equal(name, 'latest.json');
        assert.equal(request.branch, 'main');
        if ((current && request.sha !== blobSha(current)) || (!current && request.sha)) return reply({ message: 'conflict' }, 409);
        const bytes = Buffer.from(request.content, 'base64');
        files.set(name, bytes); blobs.set(blobSha(bytes), bytes);
        return reply({ content: { sha: blobSha(bytes) } }, current ? 200 : 201);
      }
      assert.equal(parsed.searchParams.get('ref'), 'main');
      if (!current) return reply({ message: 'missing' }, 404);
      const inline = current.length <= 1024 * 1024;
      return reply({ type: 'file', sha: blobSha(current), size: current.length,
        encoding: inline ? 'base64' : 'none', content: inline ? current.toString('base64') : '' });
    }
    if (pathname.startsWith(`${prefix}/git/blobs/`)) {
      const sha = pathname.split('/').at(-1), bytes = blobs.get(sha);
      assert.ok(bytes, 'requested immutable blob exists');
      return reply({ sha, size: bytes.length, encoding: 'base64', content: bytes.toString('base64') });
    }
    if (pathname === '/applications/Iv1.integration/token' && method === 'DELETE') return reply(null, 204);
    throw new Error(`Unexpected GitHub boundary: ${method} ${pathname}`);
  };
  const handler = createHandler({ env, fetchImpl: github, now: () => instant.getTime() });
  const bridge = async (url, options = {}) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, SERVICE);
    const req = Readable.from(options.body ? [options.body] : []);
    req.url = parsed.pathname + parsed.search;
    req.method = options.method || 'GET';
    req.headers = Object.fromEntries(new Headers(options.headers || {}).entries());
    if (!parsed.pathname.startsWith('/auth/')) req.headers.origin = APP_ORIGIN;
    const responseHeaders = new Headers();
    let status = 200, output = '';
    await handler(req, { setHeader: (key, value) => responseHeaders.set(key, value),
      set statusCode(value) { status = value; }, end(value = '') { output = value; } });
    serviceCalls.push({ pathname: parsed.pathname, method: req.method, status,
      body: options.body ? JSON.parse(options.body) : null,
      output: responseHeaders.get('content-type')?.startsWith('application/json') ? JSON.parse(output) : null });
    return new Response(output, { status, headers: responseHeaders });
  };
  return { files, githubCalls, serviceCalls, bridge };
}

function device(t, server, initialState = createInitialState()) {
  let state = structuredClone(initialState), opened;
  const entries = new Map(), events = new Map();
  const storage = { getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value), removeItem: key => entries.delete(key) };
  const popup = { closed: false, close() { this.closed = true; } };
  const windowRef = { open(url) { opened = url; popup.closed = false; return popup; },
    addEventListener(name, fn) { events.set(name, fn); }, removeEventListener(name) { events.delete(name); } };
  const client = new BackupClient({ serviceUrl: SERVICE, storage, windowRef, fetchImpl: server.bridge,
    now: () => instant, debounceMs: 100000, maxWaitMs: 100000,
    getState: () => state, applyState: value => { state = structuredClone(value); } });
  t.after(() => client.dispose());
  return { client, storage, getState: () => state,
    change(value) { state = structuredClone(value); client.notifyChanged(); },
    async login() {
      const pending = client.login();
      const start = await server.bridge(opened);
      assert.equal(start.status, 302);
      const authorization = new URL(start.headers.get('location'));
      const cookie = start.headers.get('set-cookie').split(';')[0];
      const callback = await server.bridge(`${SERVICE}/auth/callback?code=integration-code&state=${authorization.searchParams.get('state')}`,
        { headers: { Cookie: cookie } });
      assert.equal(callback.status, 200);
      const html = await callback.text();
      assert.equal(html.includes('ghu_'), false);
      assert.equal(html.includes('ghr_'), false);
      const message = JSON.parse(html.match(/const result=(.*?);if\(window.opener\)/)[1]);
      events.get('message')({ origin: SERVICE, source: popup, data: message });
      const result = await pending;
      assert.equal(result.connected, true);
      const saved = storage.getItem(SESSION_KEY);
      assert.match(JSON.parse(saved).session, /^wls1\./);
      assert.equal(saved.includes('ghu_'), false);
      assert.equal(saved.includes('ghr_'), false);
      return result;
    } };
}

test('real client/service OAuth, first upload, second-device restore and divergent edits round-trip', async t => {
  const server = system();
  const initial = createInitialState(); initial.settings.dailyGoal = 70;
  const first = device(t, server, initial);
  assert.equal((await first.login()).status, 'saved');
  const original = JSON.parse(server.files.get('latest.json'));
  assert.deepEqual(original.state, initial);
  assert.equal(original.stateHash, await hashState(initial));
  assert.equal(original.parentRevisionId, null);

  const second = device(t, server);
  assert.equal((await second.login()).status, 'saved');
  assert.deepEqual(second.getState(), initial);
  assert.equal(server.githubCalls.filter(call => call.method === 'PUT').length, 1);

  const newer = structuredClone(initial); newer.settings.dailyGoal = 80;
  first.change(newer);
  assert.equal((await first.client.flush()).status, 'saved');
  const latest = JSON.parse(server.files.get('latest.json'));
  assert.equal(latest.parentRevisionId, original.revisionId);

  const divergent = structuredClone(initial); divergent.settings.dailyGoal = 90;
  second.change(divergent);
  assert.equal((await second.client.flush()).status, 'conflict');
  assert.equal(second.getState().settings.dailyGoal, 90);
  assert.equal(JSON.parse(server.files.get('latest.json')).state.settings.dailyGoal, 80);
  assert.equal(server.githubCalls.filter(call => call.method === 'PUT').length, 2,
    'a conflict must not issue a destructive write');
  assert.equal((await second.client.resolveConflict('remote')).status, 'saved');
  assert.deepEqual(second.getState(), newer);
});

test('real client/service gzip upload and blob-backed compressed restoration retain valid large history', async t => {
  const server = system(), state = createInitialState(), word = allWords[0];
  state.history = Array.from({ length: 350 }, (_, index) => ({ id: `large-history-${index}`,
    sectionId: word.sectionId, title: '压缩传输测试', mode: 'normal', date: instant.toISOString(),
    duration: 10, total: 1, correct: 0, results: [{ wordId: word.id, text: word.text,
      meaning: word.meaning, phonetic: word.phonetic, sectionId: word.sectionId,
      typed: '错误样本'.repeat(300), ok: false }] }));
  const source = device(t, server, state);
  assert.equal((await source.login()).status, 'saved');
  const upload = server.serviceCalls.find(call => call.method === 'PUT');
  assert.ok(upload.body.envelopeGzip);
  assert.equal(upload.body.envelope, undefined);
  assert.ok(server.files.get('latest.json').byteLength > 1024 * 1024);

  const destination = device(t, server);
  assert.equal((await destination.login()).status, 'saved');
  assert.deepEqual(destination.getState(), state);
  assert.ok(server.serviceCalls.some(call => call.output?.envelopeGzip));
  assert.ok(server.githubCalls.some(call => call.pathname.startsWith(`${prefix}/git/blobs/`)));
  assert.equal(server.githubCalls.filter(call => call.method === 'PUT').length, 1);
});
