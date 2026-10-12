import { createInitialState, parseBackup, studyDateKey } from './core.js';

export const SESSION_KEY = 'wanglu-github-session-v1';
export const BACKUP_META_KEY = 'wanglu-github-meta-v1';
export const BACKUP_FORMAT = 'wanglu-github-backup';
const MAX_UNCOMPRESSED = 10 * 1024 * 1024;
const MAX_COMPRESSED = 3 * 1024 * 1024;

/** Object keys are sorted recursively; array order remains meaningful. */
export function canonicalJSON(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('备份包含无法序列化的数据');
  return encoded;
}

export async function hashState(state, cryptoProvider = globalThis.crypto) {
  const digest = await cryptoProvider.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJSON(state)));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

const initialJSON = canonicalJSON(createInitialState());
export function isPristineState(state) { return canonicalJSON(state) === initialJSON; }

/** Clock time never grants permission to overwrite newer or unsent local work. */
export function decideRestore({ localHash, remoteHash, baseHash, remoteExists = true,
  localIsEmpty = false, localChangedDuringRead = false }) {
  if (!remoteExists) return baseHash ? 'conflict' : 'upload';
  if (localHash === remoteHash) return 'same';
  if (baseHash && remoteHash === baseHash) return 'upload';
  if ((baseHash && localHash === baseHash) || (!baseHash && localIsEmpty)) {
    return localChangedDuringRead ? 'local' : 'restore';
  }
  return 'conflict';
}

export async function validateEnvelope(input, cryptoProvider = globalThis.crypto) {
  if (!input || input.format !== BACKUP_FORMAT || input.version !== 1
      || typeof input.revisionId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(input.revisionId)
      || !(input.parentRevisionId === null || (typeof input.parentRevisionId === 'string'
        && /^[A-Za-z0-9_-]{8,128}$/.test(input.parentRevisionId)))
      || typeof input.updatedAt !== 'string' || !Number.isFinite(Date.parse(input.updatedAt))
      || typeof input.studyDay !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.studyDay)
      || studyDateKey(input.updatedAt) !== input.studyDay
      || typeof input.stateHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.stateHash)) {
    throw new Error('GitHub 备份格式无效，已保留本机数据');
  }
  const state = parseBackup(input.state);
  if (await hashState(input.state, cryptoProvider) !== input.stateHash
      || await hashState(state, cryptoProvider) !== input.stateHash) {
    throw new Error('GitHub 备份校验失败，已保留本机数据');
  }
  return { format: BACKUP_FORMAT, version: 1, revisionId: input.revisionId,
    parentRevisionId: input.parentRevisionId, updatedAt: input.updatedAt,
    studyDay: input.studyDay, state, stateHash: input.stateHash };
}

async function boundedBytes(stream, limit) {
  const reader = stream.getReader();
  const parts = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) { await reader.cancel(); throw new Error('备份数据超过大小限制，请先导出本地备份'); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(total);
  let position = 0;
  for (const part of parts) { result.set(part, position); position += part.byteLength; }
  return result;
}

export async function encodeBackupBody(baseSha, envelope) {
  const encoded = new TextEncoder().encode(JSON.stringify(envelope));
  if (encoded.byteLength > MAX_UNCOMPRESSED) throw new Error('备份超过 10 MB，请先导出本地备份');
  if (encoded.byteLength <= 256 * 1024) return { baseSha, envelope };
  if (!globalThis.CompressionStream) {
    if (encoded.byteLength <= MAX_COMPRESSED) return { baseSha, envelope };
    throw new Error('当前浏览器无法压缩较大的备份，请更新浏览器或导出本地备份');
  }
  const bytes = await boundedBytes(new Blob([encoded]).stream().pipeThrough(new CompressionStream('gzip')), MAX_COMPRESSED);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return { baseSha, envelopeGzip: btoa(binary) };
}

export async function decodeBackupResponse(result) {
  if (result.envelope !== undefined) {
    if (new TextEncoder().encode(JSON.stringify(result.envelope)).byteLength > MAX_UNCOMPRESSED) throw new Error('GitHub 备份超过大小限制');
    return result.envelope;
  }
  if (typeof result.envelopeGzip !== 'string' || result.envelopeGzip.length > 4 * 1024 * 1024
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(result.envelopeGzip)) throw new Error('压缩备份格式无效');
  if (!globalThis.DecompressionStream) throw new Error('请更新浏览器以读取压缩备份；本机数据已保留');
  const bytes = Uint8Array.from(atob(result.envelopeGzip), character => character.charCodeAt(0));
  const decoded = await boundedBytes(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')), MAX_UNCOMPRESSED);
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decoded));
}

function normalizeServiceURL(value) {
  if (!value) return '';
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:'))
      || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('备份服务地址必须是 HTTPS 源地址');
  }
  return url.origin;
}

function defaultStorage() { try { return globalThis.localStorage; } catch { return null; } }
function readStored(storage, key) { try { return JSON.parse(storage?.getItem(key) || 'null'); } catch { return null; } }
function blankMeta(serviceUrl) {
  return { serviceUrl, identity: null, baseSha: null, baseRevisionId: null, baseHash: null,
    lastUploadedAt: null, lastCheckedAt: null, lastCheckedDay: null, dirty: false };
}
function optionalUnref(timer) { timer?.unref?.(); return timer; }
class BackupError extends Error {
  constructor(message, status, code) { super(message); this.status = status; this.code = code; }
}

/**
 * A single-user client. The opaque auth session and replication metadata are stored
 * separately from the exportable learning state. applyState must be synchronous.
 */
export class BackupClient {
  constructor({ serviceUrl = '', getState, applyState, onStatus = () => {}, storage = defaultStorage(),
    fetchImpl = globalThis.fetch?.bind(globalThis), windowRef = globalThis.window,
    cryptoProvider = globalThis.crypto, now = () => new Date(), debounceMs = 3000, maxWaitMs = 15000,
    lockManager = windowRef?.navigator?.locks || globalThis.navigator?.locks } = {}) {
    this.serviceUrl = normalizeServiceURL(serviceUrl);
    this.getState = getState;
    this.applyState = applyState;
    this.onStatus = onStatus;
    this.storage = storage;
    this.fetchImpl = fetchImpl;
    this.window = windowRef;
    this.locks = lockManager;
    this.crypto = cryptoProvider;
    this.now = now;
    this.debounceMs = debounceMs;
    this.maxWaitMs = maxWaitMs;
    this.pendingConflict = null;
    this._epoch = 0;
    this._changes = 0;
    this._chain = Promise.resolve();
    this._initialized = false;
    this._applying = false;
    this._retryDelay = 30000;
    const session = readStored(storage, SESSION_KEY);
    this._session = session?.serviceUrl === this.serviceUrl && typeof session.session === 'string' ? session : null;
    this._persistedSession = this._session?.session || null;
    const meta = readStored(storage, BACKUP_META_KEY);
    this._meta = meta?.serviceUrl === this.serviceUrl ? { ...blankMeta(this.serviceUrl), ...meta } : blankMeta(this.serviceUrl);
    this._status = this.serviceUrl ? (this._session ? 'local' : 'disconnected') : 'unconfigured';
    this._message = this.serviceUrl ? '学习记录保存在本机' : 'GitHub 备份服务尚未配置';
    this._wake = () => {
      if (!this._session) return;
      if (this._meta.lastCheckedDay !== studyDateKey(this.now())) void this.checkRemote();
      else if (this._meta.dirty && !this.pendingConflict) void this.flush();
    };
    this._storageChanged = event => {
      if ((event.key !== SESSION_KEY && event.key !== null) || !this._session) return;
      this._refreshStoredSession();
    };
  }

  getConnection() {
    return { configured: Boolean(this.serviceUrl), connected: Boolean(this._session), status: this._status,
      message: this._message, user: this._session?.user || null, repo: this._session?.repo || null,
      expiresAt: this._session?.expiresAt || null, lastUploadedAt: this._meta.lastUploadedAt,
      lastCheckedAt: this._meta.lastCheckedAt, pending: Boolean(this._meta.dirty), conflict: Boolean(this.pendingConflict) };
  }

  _emit(status, message) {
    this._status = status;
    this._message = message;
    const connection = this.getConnection();
    try { this.onStatus(connection); } catch { /* UI errors must not corrupt persisted state. */ }
    return connection;
  }

  _store(key, value) {
    if (!this.storage) return false;
    try {
      if (value === null) this.storage.removeItem(key);
      else this.storage.setItem(key, JSON.stringify(value));
      return true;
    } catch { return false; /* Keep the in-memory connection usable when browser storage is full. */ }
  }

  _saveSession() {
    this._persistedSession = this._store(SESSION_KEY, this._session) ? this._session?.session || null : null;
  }

  _refreshStoredSession() {
    if (!this._persistedSession || !this._session) return;
    const saved = readStored(this.storage, SESSION_KEY);
    if (saved?.serviceUrl === this.serviceUrl && typeof saved.session === 'string' && saved.session) {
      this._session = saved; this._persistedSession = saved.session;
    } else {
      this._epoch++; this._cancelTimers(); this.pendingConflict = null;
      this._session = null; this._persistedSession = null;
      this._emit('disconnected', 'GitHub 连接已在其他标签页断开，本机记录已保留');
    }
  }

  _saveMeta() { this._store(BACKUP_META_KEY, this._meta); }
  _snapshot() { return parseBackup(this.getState()); }
  _cancelTimers() {
    clearTimeout(this._debounceTimer); clearTimeout(this._maxTimer); clearTimeout(this._retryTimer);
    this._debounceTimer = this._maxTimer = this._retryTimer = null;
  }

  _enqueue(work) {
    const epoch = this._epoch;
    const result = this._chain.then(async () => {
      if (epoch !== this._epoch || !this._session || !this.serviceUrl) return this.getConnection();
      try { return await work(epoch); }
      catch (error) {
        if (epoch !== this._epoch) return this.getConnection();
        if (error.status === 401) {
          this._session = null; this._saveSession(); this._cancelTimers();
          return this._emit('disconnected', 'GitHub 登录已过期，请重新连接；本机记录已保留');
        }
        if (this._meta.dirty && !this.pendingConflict && (!error.status || error.status >= 500)) this._scheduleRetry();
        return this._emit('error', error.message || '备份连接暂不可用，本机记录已保留');
      }
    });
    this._chain = result.catch(() => {});
    return result;
  }

  async _request(path, options = {}) {
    const epoch = this._epoch;
    const send = () => {
      // A different tab may have refreshed an expiring GitHub token while this
      // request waited for the lock. Read the resulting opaque session first.
      this._refreshStoredSession();
      if (epoch !== this._epoch || !this._session) throw new BackupError('连接已关闭', 0, 'CANCELLED');
      return this._requestUnlocked(path, options);
    };
    return this.locks?.request ? this.locks.request(`wanglu-github-request:${this.serviceUrl}`, send) : send();
  }

  async _requestUnlocked(path, { method = 'GET', body } = {}) {
    const epoch = this._epoch;
    const controller = new AbortController();
    const timeout = optionalUnref(setTimeout(() => controller.abort(), 25000));
    let response;
    try {
      response = await this.fetchImpl(`${this.serviceUrl}${path}`, { method, cache: 'no-store', credentials: 'omit',
        redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${this._session.session}`, Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch {
      clearTimeout(timeout);
      throw new BackupError('暂时无法连接 GitHub 备份，学习记录仍保留在本机', 0, 'NETWORK');
    }
    if (epoch !== this._epoch) { clearTimeout(timeout); throw new BackupError('连接已关闭', 0, 'CANCELLED'); }
    let data;
    try { data = await response.json(); }
    catch { throw new BackupError('备份服务返回了无法读取的内容', controller.signal.aborted ? 0 : response.status, 'INVALID_RESPONSE'); }
    finally { clearTimeout(timeout); }
    if (epoch !== this._epoch) throw new BackupError('连接已关闭', 0, 'CANCELLED');
    if (typeof data.refreshedSession === 'string' && data.refreshedSession.length > 0) {
      this._session = { ...this._session, session: data.refreshedSession,
        ...(data.expiresAt ? { expiresAt: data.expiresAt } : {}) };
      this._saveSession();
    }
    if (!response.ok) throw new BackupError(String(data.error?.message || 'GitHub 备份请求失败').slice(0, 500), response.status, data.error?.code);
    return data;
  }

  _acceptSessionInfo(info) {
    if (!info.user?.login || !info.user?.id || !info.repo?.owner || !info.repo?.name || info.repo.private !== true) {
      throw new Error('备份服务未返回有效的私有仓库连接');
    }
    const identity = `${info.user.id}:${info.repo.owner}/${info.repo.name}`;
    if (this._meta.identity !== identity) this._meta = { ...blankMeta(this.serviceUrl), identity };
    this._session = { ...this._session, user: info.user, repo: info.repo, expiresAt: info.expiresAt || this._session.expiresAt };
    this._saveSession();
    this._saveMeta();
  }

  async init() {
    if (this._initialized) return this.getConnection();
    this._initialized = true;
    this.window?.addEventListener('online', this._wake);
    this.window?.addEventListener('focus', this._wake);
    this.window?.addEventListener('storage', this._storageChanged);
    if (this.serviceUrl) this._dayTimer = optionalUnref(setInterval(this._wake, 60000));
    if (!this._session || !this.serviceUrl) return this._emit(this._status, this._message);
    return this._enqueue(async epoch => {
      this._emit('connecting', '正在检查 GitHub 连接');
      this._acceptSessionInfo(await this._request('/api/session'));
      const localHash = await hashState(this._snapshot(), this.crypto);
      if (epoch !== this._epoch) return this.getConnection();
      this._meta.dirty = localHash !== this._meta.baseHash;
      this._saveMeta();
      if (this._meta.lastCheckedDay !== studyDateKey(this.now()) || !this._meta.baseHash) return this._checkRemote();
      if (this._meta.dirty) this._scheduleUpload();
      return this._emit(this._meta.dirty ? 'local' : 'saved', this._meta.dirty ? '本机有新记录，等待上传' : 'GitHub 备份已连接');
    });
  }

  async login() {
    if (!this.serviceUrl) throw new Error('GitHub 备份服务尚未配置');
    if (!this.window?.open) throw new Error('当前环境无法打开 GitHub 登录窗口');
    const nonce = this.crypto.randomUUID().replaceAll('-', '');
    // Open synchronously inside the click handler so browsers permit the popup.
    const popup = this.window.open(`${this.serviceUrl}/auth/start?nonce=${encodeURIComponent(nonce)}`,
      `wanglu-github-${nonce}`, 'popup,width=620,height=760');
    if (!popup) throw new Error('登录窗口被浏览器拦截，请允许本站打开弹窗');
    this._emit('connecting', '请在弹出的 GitHub 窗口完成登录');
    const result = await new Promise((resolve, reject) => {
      let deadline, closed;
      const cleanup = () => {
        clearTimeout(deadline); clearInterval(closed);
        this.window.removeEventListener('message', receive);
        if (this._cancelLogin === cancel) this._cancelLogin = null;
        try { popup.close(); } catch { /* Cross-origin browser policy. */ }
      };
      const cancel = () => { cleanup(); reject(new Error('GitHub 登录已取消')); };
      const receive = event => {
        if (event.origin !== this.serviceUrl || event.source !== popup || event.data?.type !== 'wanglu-auth' || event.data.nonce !== nonce) return;
        if (event.data.error) { cleanup(); reject(new Error(String(event.data.error.message || 'GitHub 登录失败').slice(0, 500))); return; }
        if (typeof event.data.session !== 'string' || event.data.session.length < 16 || event.data.session.length > 50000) return;
        cleanup(); resolve(event.data);
      };
      this.window.addEventListener('message', receive);
      this._cancelLogin?.(); this._cancelLogin = cancel;
      deadline = optionalUnref(setTimeout(() => { cleanup(); reject(new Error('GitHub 登录超时，请重试')); }, 180000));
      closed = optionalUnref(setInterval(() => { if (popup.closed) cancel(); }, 600));
    }).catch(error => { this._emit(this._session ? 'local' : 'disconnected', error.message); throw error; });
    this._epoch++;
    this._cancelTimers();
    this.pendingConflict = null;
    this._session = { serviceUrl: this.serviceUrl, session: result.session, user: result.user || null };
    this._saveSession();
    return this._enqueue(async () => {
      this._acceptSessionInfo(await this._request('/api/session'));
      return this._checkRemote();
    });
  }

  logout() {
    const previous = this._session;
    this._epoch++; this._cancelTimers(); this._cancelLogin?.();
    this._session = null; this.pendingConflict = null;
    this._saveSession();
    if (previous && this.serviceUrl) {
      const controller = new AbortController();
      const timeout = optionalUnref(setTimeout(() => controller.abort(), 10000));
      try {
        Promise.resolve(this.fetchImpl(`${this.serviceUrl}/api/logout`, { method: 'POST', cache: 'no-store',
          credentials: 'omit', redirect: 'error', signal: controller.signal, keepalive: true,
          headers: { Authorization: `Bearer ${previous.session}`, Accept: 'application/json' } }))
          .catch(() => {}).finally(() => clearTimeout(timeout));
      } catch { clearTimeout(timeout); }
    }
    return this._emit(this.serviceUrl ? 'disconnected' : 'unconfigured', '已断开 GitHub 连接，本机学习记录已保留');
  }

  notifyChanged() {
    if (this._applying) return;
    this._changes++;
    this._meta.dirty = true;
    this._saveMeta();
    if (!this._session || !this.serviceUrl || this.pendingConflict) return;
    this._emit('local', '本机有新记录，等待上传');
    this._scheduleUpload();
  }

  _scheduleUpload() {
    if (!this._session || this.pendingConflict) return;
    clearTimeout(this._debounceTimer);
    this._debounceTimer = optionalUnref(setTimeout(() => void this.flush(), this.debounceMs));
    if (!this._maxTimer) this._maxTimer = optionalUnref(setTimeout(() => void this.flush(), this.maxWaitMs));
  }

  _scheduleRetry() {
    if (this._retryTimer) return;
    this._retryTimer = optionalUnref(setTimeout(() => { this._retryTimer = null; void this.flush(); }, this._retryDelay));
    this._retryDelay = Math.min(this._retryDelay * 2, 300000);
  }

  checkRemote() { return this._enqueue(() => this._checkRemote()); }
  flush() {
    this._cancelTimers();
    if (this.pendingConflict) return Promise.resolve(this.getConnection());
    return this._enqueue(() => this._checkRemote());
  }

  async _readRemote() {
    const result = await this._request('/api/backup');
    if (result.exists === false) return { exists: false, sha: null, envelope: null };
    if (result.exists !== true || typeof result.sha !== 'string' || !result.sha) throw new Error('GitHub 备份响应不完整');
    return { exists: true, sha: result.sha, envelope: await validateEnvelope(await decodeBackupResponse(result), this.crypto) };
  }

  _recordBase(remote, { uploaded = false, dirty = false } = {}) {
    this._meta.baseSha = remote.sha;
    this._meta.baseRevisionId = remote.envelope.revisionId;
    this._meta.baseHash = remote.envelope.stateHash;
    this._meta.lastCheckedAt = this.now().toISOString();
    this._meta.lastCheckedDay = studyDateKey(this.now());
    this._meta.dirty = dirty;
    if (uploaded) this._meta.lastUploadedAt = remote.envelope.updatedAt;
    this._retryDelay = 30000;
    this._saveMeta();
  }

  _setConflict(remote, local, message = '本机和 GitHub 备份都有改动，请先选择要保留的版本') {
    this._cancelTimers();
    this.pendingConflict = { local: structuredClone(local), remote: remote.envelope,
      remoteSha: remote.sha, remoteExists: remote.exists };
    this._meta.dirty = true;
    this._saveMeta();
    return this._emit('conflict', message);
  }

  _applyRemote(remote) {
    this._applying = true;
    try { this.applyState(structuredClone(remote.envelope.state)); }
    finally { this._applying = false; }
    this.pendingConflict = null;
    this._recordBase(remote);
    return this._emit('saved', '已从 GitHub 恢复最新学习进度');
  }

  async _checkRemote() {
    const epoch = this._epoch;
    const before = canonicalJSON(this._snapshot());
    const beforeChanges = this._changes;
    this._emit('checking', '正在检查 GitHub 备份');
    const remote = await this._readRemote();
    const local = this._snapshot();
    const localJSON = canonicalJSON(local);
    const localHash = await hashState(local, this.crypto);
    if (epoch !== this._epoch) return this.getConnection();
    // No await may appear between this final comparison and applying a restore.
    if (canonicalJSON(this._snapshot()) !== localJSON) {
      this._meta.dirty = true; this._saveMeta(); this._scheduleUpload();
      return this._emit('local', '检查期间本机有新记录，已保留并安排重新检查');
    }
    const decision = decideRestore({ localHash, remoteHash: remote.envelope?.stateHash,
      baseHash: this._meta.baseHash, remoteExists: remote.exists, localIsEmpty: isPristineState(local),
      localChangedDuringRead: this._changes !== beforeChanges || before !== localJSON });
    if (decision === 'same') {
      this.pendingConflict = null; this._recordBase(remote);
      return this._emit('saved', '本机与 GitHub 备份一致');
    }
    if (decision === 'restore') return this._applyRemote(remote);
    if (decision === 'upload') return this._upload(local, localHash, remote);
    if (decision === 'local') {
      this._meta.dirty = true; this._saveMeta(); this._scheduleUpload();
      return this._emit('local', '本机记录已更新，保留本机并稍后重试');
    }
    return this._setConflict(remote, local);
  }

  async _upload(local, localHash, remote) {
    const epoch = this._epoch;
    const now = this.now();
    const envelope = { format: BACKUP_FORMAT, version: 1, revisionId: this.crypto.randomUUID(),
      parentRevisionId: remote.envelope?.revisionId || null, updatedAt: now.toISOString(),
      studyDay: studyDateKey(now), state: local, stateHash: localHash };
    this._emit('saving', '正在上传学习记录到 GitHub');
    let response;
    try {
      const body = await encodeBackupBody(remote.sha, envelope);
      if (epoch !== this._epoch) return this.getConnection();
      response = await this._request('/api/backup', { method: 'PUT', body });
    }
    catch (error) {
      if (error.status !== 409) throw error;
      const latest = await this._readRemote();
      if (epoch !== this._epoch) return this.getConnection();
      return this._setConflict(latest, this._snapshot(), '上传时 GitHub 备份发生了变化，请确认要保留的版本');
    }
    if (typeof response.sha !== 'string' || !response.sha) throw new Error('备份服务未确认上传结果；本机记录已保留');
    const current = this._snapshot();
    const currentHash = await hashState(current, this.crypto);
    if (epoch !== this._epoch) return this.getConnection();
    const dirty = currentHash !== localHash || canonicalJSON(this._snapshot()) !== canonicalJSON(current);
    this.pendingConflict = null;
    this._recordBase({ sha: response.sha, envelope }, { uploaded: true, dirty });
    if (dirty) this._scheduleUpload();
    return this._emit(dirty ? 'local' : 'saved', dirty ? '上一份记录已上传，正在等待保存新改动' : '学习记录已备份到 GitHub');
  }

  resolveConflict(choice) {
    if (!['local', 'remote'].includes(choice)) return Promise.reject(new Error('请选择本机或 GitHub 版本'));
    return this._enqueue(async () => {
      const conflict = this.pendingConflict;
      if (!conflict) return this.getConnection();
      const epoch = this._epoch;
      const before = canonicalJSON(this._snapshot());
      const remote = await this._readRemote();
      if (epoch !== this._epoch) return this.getConnection();
      const local = this._snapshot();
      if (remote.sha !== conflict.remoteSha) return this._setConflict(remote, local, 'GitHub 备份又有更新，请重新确认版本');
      if (choice === 'remote') {
        if (!remote.exists) return this._setConflict(remote, local, 'GitHub 当前没有可恢复的备份，请保留本机版本');
        if (canonicalJSON(local) !== before) return this._setConflict(remote, local, '确认期间本机记录有更新，请重新选择版本');
        return this._applyRemote(remote);
      }
      const localHash = await hashState(local, this.crypto);
      if (epoch !== this._epoch) return this.getConnection();
      return this._upload(local, localHash, remote);
    });
  }

  dispose() {
    this._epoch++; this._cancelTimers(); this._cancelLogin?.(); clearInterval(this._dayTimer);
    this.window?.removeEventListener('online', this._wake);
    this.window?.removeEventListener('focus', this._wake);
    this.window?.removeEventListener('storage', this._storageChanged);
  }
}
