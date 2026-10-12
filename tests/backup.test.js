import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, studyDateKey } from '../core.js';
import { BackupClient, BACKUP_META_KEY, BACKUP_FORMAT, SESSION_KEY, canonicalJSON,
  hashState, validateEnvelope, decideRestore, encodeBackupBody, decodeBackupResponse } from '../backup.js';

const SERVICE = 'https://backup.example.test';
const now = new Date('2026-10-11T23:00:00.000Z');
const user = { id: '89184687', login: 'scpsyl' };
const repo = { owner: 'ielts-wanglu-dictation', name: 'wanglu-dictation-backups', private: true };
const identity = `${user.id}:${repo.owner}/${repo.name}`;
const clone = value => structuredClone(value);
const stateWithGoal = goal => ({ ...createInitialState(), settings: { ...createInitialState().settings, dailyGoal: goal } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const jsonResponse = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => clone(data) });

function memoryStorage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}

async function envelope(state, revisionId = 'revision-00000001', parentRevisionId = null) {
  return { format: BACKUP_FORMAT, version: 1, revisionId, parentRevisionId, updatedAt: now.toISOString(),
    studyDay: studyDateKey(now), state: clone(state), stateHash: await hashState(state) };
}

async function harness(t, { local = createInitialState(), remote = null, baseline = null, fetchHook, storage = memoryStorage(), session = true, lockManager } = {}) {
  let state = clone(local);
  let storedRemote = remote ? clone(remote) : null;
  let sha = remote ? 'sha-remote-1' : null;
  const requests = [], statuses = [];
  let applied = 0;
  if (session) storage.setItem(SESSION_KEY, JSON.stringify({ serviceUrl: SERVICE, session: 'opaque-session-at-least-16', user, repo }));
  if (baseline) storage.setItem(BACKUP_META_KEY, JSON.stringify({ serviceUrl: SERVICE, identity,
    baseHash: baseline.stateHash, baseRevisionId: baseline.revisionId, baseSha: 'sha-base', dirty: false }));
  const client = new BackupClient({ serviceUrl: SERVICE, storage, lockManager, now: () => now, debounceMs: 100000, maxWaitMs: 100000,
    getState: () => state, applyState: next => { state = next; applied++; }, onStatus: value => statuses.push(value),
    fetchImpl: async (url, options) => {
      const request = { path: new URL(url).pathname, method: options.method, headers: options.headers,
        body: options.body ? JSON.parse(options.body) : null };
      requests.push(request);
      const intercepted = await fetchHook?.(request, { setRemote: (next, nextSha = 'sha-remote-new') => { storedRemote = clone(next); sha = nextSha; } });
      if (intercepted) return intercepted;
      if (request.path === '/api/logout') return jsonResponse({ ok: true });
      if (request.path === '/api/session') return jsonResponse({ user, repo, expiresAt: '2026-11-01T00:00:00Z' });
      if (request.method === 'GET') return jsonResponse(storedRemote ? { exists: true, sha, envelope: storedRemote } : { exists: false });
      if (request.method === 'PUT') {
        if (request.body.baseSha !== sha) return jsonResponse({ error: { code: 'CONFLICT', message: 'changed' } }, 409);
        storedRemote = await decodeBackupResponse(request.body);
        sha = `sha-written-${requests.length}`;
        return jsonResponse({ sha });
      }
      throw new Error('Unexpected request');
    } });
  t.after(() => client.dispose());
  return { client, storage, requests, statuses, getState: () => state,
    change: next => { state = clone(next); client.notifyChanged(); }, getRemote: () => storedRemote,
    setRemote: (next, nextSha = 'sha-remote-new') => { storedRemote = clone(next); sha = nextSha; }, getApplied: () => applied };
}

test('restore policy protects dirty data, supports clean descendants, and does not use wall clocks', () => {
  const decision = overrides => decideRestore({ localHash: 'local', remoteHash: 'remote', baseHash: null, ...overrides });
  assert.equal(decision({ localIsEmpty: true }), 'restore');
  assert.equal(decision({ localIsEmpty: true, localChangedDuringRead: true }), 'local');
  assert.equal(decision({}), 'conflict');
  assert.equal(decision({ baseHash: 'local' }), 'restore');
  assert.equal(decision({ baseHash: 'remote' }), 'upload');
  assert.equal(decision({ localHash: 'remote', baseHash: 'old' }), 'same');
  assert.equal(decision({ remoteExists: false }), 'upload');
  assert.equal(decision({ remoteExists: false, baseHash: 'old' }), 'conflict');
});

test('canonical hashes ignore object insertion order but preserve answer ordering', async () => {
  assert.equal(canonicalJSON({ b: { z: 1, a: '中' }, a: [2, 1] }), canonicalJSON({ a: [2, 1], b: { a: '中', z: 1 } }));
  assert.equal(await hashState({ b: 2, a: 1 }), await hashState({ a: 1, b: 2 }));
  assert.notEqual(await hashState([1, 2]), await hashState([2, 1]));
});

test('tampered or structurally invalid backups never pass validation', async () => {
  const data = await envelope(createInitialState());
  assert.deepEqual((await validateEnvelope(data)).state, createInitialState());
  data.state.settings.dailyGoal = 900;
  await assert.rejects(validateEnvelope(data), /校验失败/);
  await assert.rejects(validateEnvelope({ ...data, version: 2 }), /格式无效/);
  const invalid = await envelope({ ...createInitialState(), history: 'invalid' });
  await assert.rejects(validateEnvelope(invalid), /历史记录/);
});

test('transport compresses large UTF-8 JSON and rejects oversized compressed metadata', async () => {
  const large = { text: '学习记录和中文草稿'.repeat(40000) };
  const packed = await encodeBackupBody('base', large);
  assert.equal(packed.baseSha, 'base');
  assert.equal(typeof packed.envelopeGzip, 'string');
  assert.deepEqual(await decodeBackupResponse(packed), large);
  await assert.rejects(decodeBackupResponse({ envelopeGzip: 'A'.repeat(4 * 1024 * 1024 + 4) }), /格式无效/);
});

test('an unconfigured client never attempts networking or alters learning data', async t => {
  let called = 0;
  const client = new BackupClient({ serviceUrl: '', storage: memoryStorage(), getState: createInitialState,
    applyState: () => called++, fetchImpl: () => { called++; throw new Error('unexpected'); } });
  t.after(() => client.dispose());
  await client.init(); client.notifyChanged(); await client.flush(); await client.checkRemote();
  assert.equal(client.getConnection().status, 'unconfigured');
  assert.equal(called, 0);
  assert.throws(() => new BackupClient({ serviceUrl: 'http://example.com' }), /HTTPS/);
});

test('a pristine browser restores validated remote state; same study-day reload only checks the session', async t => {
  const data = await envelope(stateWithGoal(100));
  const h = await harness(t, { remote: data });
  await h.client.init();
  assert.equal(h.getState().settings.dailyGoal, 100);
  assert.equal(h.getApplied(), 1);
  assert.equal(h.requests.filter(r => r.method === 'PUT').length, 0);
  h.client.dispose();
  const reload = await harness(t, { local: h.getState(), remote: data, storage: h.storage });
  await reload.client.init();
  assert.deepEqual(reload.requests.map(r => r.path), ['/api/session']);
  assert.equal(reload.getApplied(), 0);
});

test('initial non-default preferences are treated as local work rather than overwritten', async t => {
  const h = await harness(t, { local: stateWithGoal(70), remote: await envelope(stateWithGoal(100)) });
  await h.client.init();
  assert.equal(h.client.getConnection().status, 'conflict');
  assert.equal(h.getState().settings.dailyGoal, 70);
  assert.equal(h.requests.filter(r => r.method === 'PUT').length, 0);
});

test('unsent local changes upload against the known remote base with the correct parent revision', async t => {
  const base = await envelope(stateWithGoal(70));
  const h = await harness(t, { local: stateWithGoal(90), remote: base, baseline: base });
  await h.client.init();
  assert.equal(h.getRemote().state.settings.dailyGoal, 90);
  assert.equal(h.getRemote().parentRevisionId, base.revisionId);
  assert.equal(h.client.getConnection().pending, false);
  assert.equal(h.requests.find(r => r.method === 'PUT').body.baseSha, 'sha-remote-1');
});

test('local edits arriving during the first remote GET cannot be discarded by restoration', async t => {
  const blocked = deferred(), started = deferred();
  const h = await harness(t, { remote: await envelope(stateWithGoal(100)), fetchHook: async request => {
    if (request.path === '/api/backup' && request.method === 'GET') { started.resolve(); await blocked.promise; }
  } });
  const init = h.client.init(); await started.promise;
  h.change(stateWithGoal(75)); blocked.resolve(); await init;
  assert.equal(h.getState().settings.dailyGoal, 75);
  assert.equal(h.getApplied(), 0);
  assert.equal(h.client.getConnection().status, 'conflict');
  assert.equal(h.requests.filter(r => r.method === 'PUT').length, 0);
});

test('a completed upload does not mark changes made during that upload as saved', async t => {
  const blocked = deferred(), started = deferred();
  let blockOnce = true;
  const base = await envelope(stateWithGoal(50));
  const h = await harness(t, { local: stateWithGoal(80), remote: base, baseline: base, fetchHook: async request => {
    if (request.method === 'PUT' && blockOnce) { blockOnce = false; started.resolve(); await blocked.promise; }
  } });
  const init = h.client.init(); await started.promise;
  h.change(stateWithGoal(95)); blocked.resolve(); await init;
  assert.equal(h.getRemote().state.settings.dailyGoal, 80);
  assert.equal(h.getState().settings.dailyGoal, 95);
  assert.equal(h.client.getConnection().pending, true);
  await h.client.flush();
  assert.equal(h.getRemote().state.settings.dailyGoal, 95);
  assert.equal(h.client.getConnection().pending, false);
});

test('a CAS rejection creates a conflict without retrying a destructive overwrite', async t => {
  const base = await envelope(stateWithGoal(50));
  const advanced = await envelope(stateWithGoal(120), 'revision-00000002', base.revisionId);
  let rejectOnce = true;
  const h = await harness(t, { local: stateWithGoal(80), remote: base, baseline: base, fetchHook: async (request, server) => {
    if (request.method === 'PUT' && rejectOnce) {
      rejectOnce = false; server.setRemote(advanced);
      return jsonResponse({ error: { code: 'CONFLICT', message: 'changed' } }, 409);
    }
  } });
  await h.client.init();
  assert.equal(h.client.getConnection().status, 'conflict');
  assert.equal(h.client.pendingConflict.remote.state.settings.dailyGoal, 120);
  assert.equal(h.getState().settings.dailyGoal, 80);
  assert.equal(h.requests.filter(r => r.method === 'PUT').length, 1);
  await h.client.flush();
  assert.equal(h.requests.filter(r => r.method === 'PUT').length, 1);
});

test('conflict selection is re-confirmed when the remote changed after the dialog opened', async t => {
  const h = await harness(t, { local: stateWithGoal(70), remote: await envelope(stateWithGoal(100)) });
  await h.client.init();
  h.setRemote(await envelope(stateWithGoal(110), 'revision-00000002'));
  await h.client.resolveConflict('remote');
  assert.equal(h.getState().settings.dailyGoal, 70);
  assert.equal(h.client.getConnection().status, 'conflict');
  await h.client.resolveConflict('remote');
  assert.equal(h.getState().settings.dailyGoal, 110);
  assert.equal(h.client.getConnection().status, 'saved');
});

test('choosing local explicitly replaces the displayed remote revision with a CAS write', async t => {
  const data = await envelope(stateWithGoal(100));
  const h = await harness(t, { local: stateWithGoal(70), remote: data });
  await h.client.init(); await h.client.resolveConflict('local');
  assert.equal(h.getRemote().state.settings.dailyGoal, 70);
  assert.equal(h.getRemote().parentRevisionId, data.revisionId);
  assert.equal(h.client.pendingConflict, null);
});

test('opaque sessions refresh between requests, stay outside state, and are removed by logout', async t => {
  const h = await harness(t, { remote: await envelope(createInitialState()), fetchHook: async request => {
    if (request.path === '/api/session') return jsonResponse({ user, repo, refreshedSession: 'new-opaque-secret-session', expiresAt: '2027-01-01T00:00:00Z' });
  } });
  await h.client.init();
  assert.equal(h.requests.at(-1).headers.Authorization, 'Bearer new-opaque-secret-session');
  assert.equal(JSON.stringify(h.getState()).includes('opaque'), false);
  assert.equal(JSON.stringify(h.client.getConnection()).includes('opaque'), false);
  assert.equal(JSON.parse(h.storage.getItem(SESSION_KEY)).session, 'new-opaque-secret-session');
  h.client.logout();
  assert.equal(h.storage.getItem(SESSION_KEY), null);
  assert.deepEqual(h.getState(), createInitialState());
});

test('expired authentication disconnects without destroying local learning state', async t => {
  const h = await harness(t, { local: stateWithGoal(70), fetchHook: async () => jsonResponse({ error: { code: 'UNAUTHORIZED', message: 'expired' } }, 401) });
  await h.client.init();
  assert.equal(h.client.getConnection().status, 'disconnected');
  assert.equal(h.client.getConnection().connected, false);
  assert.equal(h.getState().settings.dailyGoal, 70);
});

test('browser locks make two tabs reuse the first refreshed session and respect shared logout', async t => {
  let tail = Promise.resolve();
  const lockManager = { request(_name, task) { const result = tail.then(task); tail = result.catch(() => {}); return result; } };
  const storage = memoryStorage();
  const received = [];
  const fetchHook = async request => {
    if (request.path === '/api/session') {
      received.push(request.headers.Authorization);
      return jsonResponse({ user, repo, refreshedSession: 'refreshed-shared-session' });
    }
  };
  const data = await envelope(createInitialState());
  const first = await harness(t, { remote: data, storage, lockManager, fetchHook });
  const second = await harness(t, { remote: data, storage, lockManager, fetchHook });
  await Promise.all([first.client.init(), second.client.init()]);
  assert.deepEqual(received, ['Bearer opaque-session-at-least-16', 'Bearer refreshed-shared-session']);
  first.client.logout();
  const requestsBefore = second.requests.length;
  await second.client.checkRemote();
  assert.equal(second.requests.length, requestsBefore);
  assert.equal(second.client.getConnection().connected, false);
  assert.deepEqual(second.getState(), createInitialState());
});

test('logout is immediate even if server token revocation never completes', async t => {
  const revocation = deferred();
  const h = await harness(t, { fetchHook: async request => request.path === '/api/logout' ? revocation.promise : undefined });
  const stateBefore = clone(h.getState());
  h.client.logout();
  assert.equal(h.client.getConnection().connected, false);
  assert.equal(h.storage.getItem(SESSION_KEY), null);
  assert.deepEqual(h.getState(), stateBefore);
  assert.equal(h.requests.at(-1).path, '/api/logout');
  revocation.resolve(jsonResponse({ ok: true }));
});

test('logout during a pending remote read blocks any later restore or write', async t => {
  const blocked = deferred(), started = deferred();
  const h = await harness(t, { remote: await envelope(stateWithGoal(100)), fetchHook: async request => {
    if (request.path === '/api/backup') { started.resolve(); await blocked.promise; }
  } });
  const init = h.client.init(); await started.promise;
  h.client.logout(); blocked.resolve(); await init;
  assert.deepEqual(h.getState(), createInitialState());
  assert.equal(h.getApplied(), 0);
  assert.equal(h.client.getConnection().status, 'disconnected');
});

test('popup accepts only the exact service origin, popup window, and nonce', async t => {
  const events = new Map();
  let openedURL;
  const popup = { closed: false, close() { this.closed = true; } };
  const windowRef = { open(url) { openedURL = url; return popup; },
    addEventListener(name, callback) { events.set(name, callback); }, removeEventListener(name) { events.delete(name); } };
  const client = new BackupClient({ serviceUrl: SERVICE, windowRef, storage: memoryStorage(), getState: createInitialState,
    applyState: () => {}, fetchImpl: async url => new URL(url).pathname === '/api/session'
      ? jsonResponse({ user, repo }) : jsonResponse({ exists: true, sha: 'sha-auth', envelope: await envelope(createInitialState()) }) });
  t.after(() => client.dispose());
  const login = client.login();
  const nonce = new URL(openedURL).searchParams.get('nonce');
  const message = { type: 'wanglu-auth', nonce, session: 'opaque-login-session-12345', user };
  events.get('message')({ origin: 'https://evil.example', source: popup, data: message });
  events.get('message')({ origin: SERVICE, source: {}, data: message });
  events.get('message')({ origin: SERVICE, source: popup, data: { ...message, nonce: 'wrong' } });
  assert.equal(client.getConnection().connected, false);
  events.get('message')({ origin: SERVICE, source: popup, data: message });
  await login;
  assert.equal(client.getConnection().connected, true);
  assert.equal(popup.closed, true);
  assert.equal(events.has('message'), false);
});
