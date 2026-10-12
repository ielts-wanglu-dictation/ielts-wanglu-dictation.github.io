import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';

export const APP_ORIGIN = 'https://ielts-wanglu-dictation.github.io';
export const COOKIE_NAME = '__Host-wanglu-oauth';
export const MAX_BODY_BYTES = 10 * 1024 * 1024;
export const MAX_BACKUP_BYTES = 10 * 1024 * 1024;
export const MAX_COMPRESSED_BYTES = 3 * 1024 * 1024;
const COMPRESS_THRESHOLD = 256 * 1024;
const compress = promisify(gzip), decompress = promisify(gunzip);
const OWNER = 'ielts-wanglu-dictation';
const REPO = 'wanglu-dictation-backups';
const API_VERSION = '2026-03-10';
const STATE_TTL = 10 * 60 * 1000;
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const NONCE = /^[A-Za-z0-9_-]{16,128}$/;
const ROUTES = new Map([['/health', 'health'], ['/auth/start', 'auth-start'], ['/auth/callback', 'auth-callback'], ['/api/session', 'session'], ['/api/backup', 'backup'], ['/api/snapshots', 'snapshots'], ['/api/logout', 'logout']]);

export class ServiceError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new ServiceError(status, code, message); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

export function readConfig(env) {
  const secret = env.SESSION_SECRET || '';
  const key = Buffer.from(secret, 'base64');
  let service;
  try { service = new URL(env.SERVICE_ORIGIN); } catch { fail(503, 'NOT_CONFIGURED', '备份服务尚未完成配置。'); }
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET || !/^[1-9]\d{0,19}$/.test(env.ALLOWED_GITHUB_USER_ID || '')
    || key.length !== 32 || key.toString('base64') !== secret
    || env.APP_ORIGIN !== APP_ORIGIN || service.protocol !== 'https:'
    || service.origin !== env.SERVICE_ORIGIN || service.username || service.password
    || (env.BACKUP_OWNER || OWNER) !== OWNER || (env.BACKUP_REPO || REPO) !== REPO) {
    fail(503, 'NOT_CONFIGURED', '备份服务尚未完成配置。');
  }
  return { key, clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET,
    userId: String(env.ALLOWED_GITHUB_USER_ID), appOrigin: APP_ORIGIN, serviceOrigin: service.origin,
    callback: `${service.origin}/auth/callback`, owner: OWNER, repo: REPO };
}

function aad(config, purpose) {
  return Buffer.from(`wanglu-v1|${purpose}|${config.serviceOrigin}|${config.appOrigin}|${config.userId}`);
}
export function seal(payload, config, purpose = 'session') {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', config.key, iv);
  cipher.setAAD(aad(config, purpose));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return ['wls1', iv.toString('base64url'), encrypted.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
}
export function unseal(token, config, purpose = 'session') {
  try {
    if (typeof token !== 'string' || token.length > 8192 || !/^wls1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw Error();
    const [, ivText, encryptedText, tagText] = token.split('.');
    const iv = Buffer.from(ivText, 'base64url'), tag = Buffer.from(tagText, 'base64url');
    if (iv.length !== 12 || tag.length !== 16) throw Error();
    const decipher = createDecipheriv('aes-256-gcm', config.key, iv);
    decipher.setAAD(aad(config, purpose));
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(encryptedText, 'base64url')), decipher.final()]).toString('utf8'));
  } catch { fail(401, 'AUTH_REQUIRED', '登录已失效，请重新连接 GitHub。'); }
}

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function safeJson(value, depth = 0, budget = { nodes: 0 }) {
  if (++budget.nodes > 500000 || depth > 60) fail(400, 'INVALID_BACKUP', '备份结构过于复杂。');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (!Array.isArray(value) && !plain(value)) fail(400, 'INVALID_BACKUP', '备份必须是普通 JSON 数据。');
  for (const key of Object.keys(value)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) fail(400, 'INVALID_BACKUP', '备份包含不允许的字段。');
    safeJson(value[key], depth + 1, budget);
  }
}
export function validateEnvelope(envelope) {
  safeJson(envelope);
  if (!plain(envelope) || envelope.format !== 'wanglu-github-backup' || envelope.version !== 1
    || !UUID.test(envelope.revisionId || '') || !(envelope.parentRevisionId === null || UUID.test(envelope.parentRevisionId || ''))
    || typeof envelope.updatedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(envelope.updatedAt)
    || !Number.isFinite(Date.parse(envelope.updatedAt)) || !/^\d{4}-\d{2}-\d{2}$/.test(envelope.studyDay || '')
    || !/^[a-f0-9]{64}$/.test(envelope.stateHash || '') || !plain(envelope.state)
    || envelope.state.version !== 1 || !Array.isArray(envelope.state.history)
    || !plain(envelope.state.settings) || !plain(envelope.state.reviews)
    || !(envelope.state.draft === null || plain(envelope.state.draft))) {
    fail(400, 'INVALID_BACKUP', '备份格式无效。');
  }
  const keys = ['format', 'version', 'revisionId', 'parentRevisionId', 'updatedAt', 'studyDay', 'state', 'stateHash'];
  if (Object.keys(envelope).some(key => !keys.includes(key))) fail(400, 'INVALID_BACKUP', '备份包含未知字段。');
  const digest = createHash('sha256').update(canonical(envelope.state), 'utf8').digest('hex');
  if (!timingSafeEqual(Buffer.from(digest), Buffer.from(envelope.stateHash))) fail(400, 'HASH_MISMATCH', '备份校验失败，内容与摘要不一致。');
  const text = JSON.stringify(envelope);
  if (Buffer.byteLength(text) > MAX_BACKUP_BYTES) fail(413, 'BACKUP_TOO_LARGE', '云备份最多支持 10 MiB，请导出本地备份保存完整记录。');
  return text;
}

function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
async function decodeEnvelope(body) {
  const hasPlain = Object.hasOwn(body, 'envelope'), hasGzip = Object.hasOwn(body, 'envelopeGzip');
  if (hasPlain === hasGzip) fail(400, 'INVALID_BACKUP', '请求应仅包含一种备份格式。');
  if (hasPlain) {
    if (Buffer.byteLength(JSON.stringify(body.envelope)) > 4_000_000) fail(413, 'COMPRESSION_REQUIRED', '这份备份需要压缩传输，请使用支持压缩的浏览器。');
    return body.envelope;
  }
  const encoded = body.envelopeGzip;
  if (typeof encoded !== 'string' || encoded.length > MAX_COMPRESSED_BYTES * 4 / 3
    || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) fail(400, 'INVALID_COMPRESSION', '压缩备份格式无效或过大。');
  try {
    const input = Buffer.from(encoded, 'base64');
    if (input.length > MAX_COMPRESSED_BYTES) fail(413, 'BACKUP_TOO_LARGE', '压缩备份最多支持 3 MiB。');
    if (input.toString('base64') !== encoded) fail(400, 'INVALID_COMPRESSION', '压缩备份编码无效。');
    const bytes = await decompress(input, { maxOutputLength: MAX_BACKUP_BYTES });
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    fail(400, 'INVALID_COMPRESSION', '压缩备份损坏或解压后超过 10 MiB。');
  }
}
async function transportBackup(result) {
  if (!result.exists) return result;
  const bytes = Buffer.from(JSON.stringify(result.envelope), 'utf8');
  if (bytes.length <= COMPRESS_THRESHOLD) return result;
  const zipped = await compress(bytes);
  if (zipped.length > MAX_COMPRESSED_BYTES) fail(413, 'BACKUP_TOO_LARGE', '压缩后的云备份超过 3 MiB，请从私有仓库下载本地恢复。');
  const { envelope, ...metadata } = result;
  return { ...metadata, envelopeGzip: zipped.toString('base64') };
}

function header(req, name) {
  const value = req.headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value || '';
}
function cookie(req) {
  const values = header(req, 'cookie').split(';').map(part => part.trim()).filter(part => part.startsWith(`${COOKIE_NAME}=`));
  return values.length === 1 ? values[0].slice(COOKIE_NAME.length + 1) : '';
}
function setCookie(res, value, maxAge) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`);
}
function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}
function sanitizeError(error) {
  return error instanceof ServiceError ? error : new ServiceError(500, 'INTERNAL_ERROR', '备份服务暂时不可用，请稍后重试。');
}
function popup(res, config, message, status = 200) {
  const nonce = randomBytes(18).toString('base64');
  const serialize = value => JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
  const script = `history.replaceState(null,'','/auth/callback');const result=${serialize(message)};if(window.opener){window.opener.postMessage(result,${serialize(config.appOrigin)});window.close();}`;
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
  res.setHeader('Cross-Origin-Opener-Policy', 'unsafe-none');
  res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>GitHub 备份登录</title><body><p>${message.error ? '登录未完成，请返回听写页面重试。' : '登录已完成，可以关闭此窗口并返回听写页面。'}</p><script nonce="${nonce}">${script}</script></body></html>`);
}

async function readBody(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(header(req, 'content-type'))) fail(415, 'JSON_REQUIRED', '请求必须使用 application/json。');
  if (Number(header(req, 'content-length')) > MAX_BODY_BYTES) fail(413, 'BODY_TOO_LARGE', '请求内容过大。');
  let text;
  if (req.body !== undefined && req.body !== null) {
    if (Buffer.isBuffer(req.body)) text = req.body.toString('utf8');
    else if (typeof req.body === 'string') text = req.body;
    else { safeJson(req.body); text = JSON.stringify(req.body); }
  } else {
    const chunks = []; let size = 0;
    for await (const chunk of req) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_BODY_BYTES) fail(413, 'BODY_TOO_LARGE', '请求内容过大。');
      chunks.push(bytes);
    }
    text = Buffer.concat(chunks).toString('utf8');
  }
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) fail(413, 'BODY_TOO_LARGE', '请求内容过大。');
  try { return JSON.parse(text); } catch { fail(400, 'INVALID_JSON', 'JSON 内容无效。'); }
}

export function createHandler({ env = process.env, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  async function requestJson(url, options = {}, maxBytes = MAX_BODY_BYTES * 1.5) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetchImpl(url, { ...options, redirect: 'error', signal: controller.signal });
      const declared = Number(response.headers.get('content-length'));
      if (declared > maxBytes) fail(502, 'UPSTREAM_TOO_LARGE', 'GitHub 返回内容过大。');
      let size = 0; const parts = [];
      if (response.body) {
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > maxBytes) { controller.abort(); fail(502, 'UPSTREAM_TOO_LARGE', 'GitHub 返回内容过大。'); }
          parts.push(Buffer.from(chunk));
        }
      }
      const text = Buffer.concat(parts).toString('utf8');
      let data;
      try { data = text ? JSON.parse(text) : null; } catch { fail(502, 'UPSTREAM_INVALID', 'GitHub 返回了无法识别的数据。'); }
      return { status: response.status, data, headers: response.headers };
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      if (controller.signal.aborted) fail(504, 'UPSTREAM_TIMEOUT', '连接 GitHub 超时，请稍后重试。');
      fail(502, 'UPSTREAM_UNAVAILABLE', '暂时无法连接 GitHub。');
    } finally { clearTimeout(timer); }
  }

  async function github(config, token, path, options = {}) {
    return requestJson(`https://api.github.com${path}`, { ...options, headers: {
      Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': API_VERSION, 'User-Agent': 'wanglu-personal-backup',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    } });
  }
  function requireGithub(response, allowed = [200]) {
    if (allowed.includes(response.status)) return response.data;
    if (response.status === 401) fail(401, 'AUTH_REQUIRED', 'GitHub 授权已失效，请重新连接。');
    if ([403, 429].includes(response.status) && (response.headers.get('x-ratelimit-remaining') === '0' || response.status === 429)) fail(429, 'RATE_LIMITED', 'GitHub 请求频率已达上限，请稍后重试。');
    if ([403, 404].includes(response.status)) fail(403, 'REPOSITORY_ACCESS', '无法访问指定私有备份仓库，请检查 GitHub App 安装及权限。');
    fail(502, 'GITHUB_ERROR', 'GitHub 暂未完成请求，请稍后重试。');
  }
  async function exchange(config, fields) {
    const response = await requestJson('https://github.com/login/oauth/access_token', { method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, ...fields }),
    }, 64000);
    const token = response.data;
    if (response.status !== 200 || !plain(token) || token.error || typeof token.access_token !== 'string'
      || !token.access_token.startsWith('ghu_') || token.access_token.length > 2048
      || (token.token_type && token.token_type.toLowerCase() !== 'bearer')) {
      fail(401, 'AUTH_REQUIRED', 'GitHub 登录已失效或未完成，请重新连接。');
    }
    return token;
  }
  function tokenFields(token) {
    const stamp = now();
    const accessExpiresAt = Number.isFinite(token.expires_in) && token.expires_in > 0 ? stamp + token.expires_in * 1000 : stamp + SESSION_TTL;
    const refresh = typeof token.refresh_token === 'string' && token.refresh_token.startsWith('ghr_') && token.refresh_token.length <= 2048 ? token.refresh_token : null;
    const refreshExpiresAt = refresh && Number.isFinite(token.refresh_token_expires_in) && token.refresh_token_expires_in > 0 ? stamp + token.refresh_token_expires_in * 1000 : null;
    return { accessToken: token.access_token, accessExpiresAt, refreshToken: refresh, refreshExpiresAt };
  }
  async function readUser(config, token) {
    const user = requireGithub(await github(config, token, '/user'));
    if (!user || String(user.id) !== config.userId) fail(403, 'USER_NOT_ALLOWED', '此备份服务仅供指定 GitHub 账户使用。');
    return { id: String(user.id), login: String(user.login || '').slice(0, 100),
      avatarUrl: typeof user.avatar_url === 'string' && user.avatar_url.startsWith('https://avatars.githubusercontent.com/') ? user.avatar_url : '' };
  }
  async function authenticate(req, config) {
    const authorization = header(req, 'authorization');
    if (!/^Bearer wls1\.[A-Za-z0-9_.-]+$/.test(authorization)) fail(401, 'AUTH_REQUIRED', '请先连接 GitHub。');
    let session = unseal(authorization.slice(7), config);
    if (!plain(session) || session.user?.id !== config.userId || !Number.isFinite(session.expiresAt)
      || session.expiresAt <= now() || typeof session.accessToken !== 'string'
      || !Number.isFinite(session.accessExpiresAt)) fail(401, 'AUTH_REQUIRED', '登录已过期，请重新连接 GitHub。');
    let refreshedSession;
    if (session.accessExpiresAt <= now() + 60000) {
      if (!session.refreshToken || !session.refreshExpiresAt || session.refreshExpiresAt <= now()) fail(401, 'AUTH_REQUIRED', '登录已过期，请重新连接 GitHub。');
      const token = await exchange(config, { grant_type: 'refresh_token', refresh_token: session.refreshToken });
      const fields = tokenFields(token);
      const user = await readUser(config, fields.accessToken);
      session = { ...session, ...fields, user };
      refreshedSession = seal(session, config);
    }
    return { session, extra: { ...(refreshedSession ? { refreshedSession } : {}), expiresAt: new Date(session.expiresAt).toISOString() } };
  }
  async function repository(config, token) {
    const repo = requireGithub(await github(config, token, `/repos/${config.owner}/${config.repo}`));
    if (!repo || repo.private !== true || String(repo.name).toLowerCase() !== config.repo.toLowerCase()
      || String(repo.owner?.login).toLowerCase() !== config.owner.toLowerCase()) {
      fail(403, 'PRIVATE_REPOSITORY_REQUIRED', '备份仓库必须保持私有；本次操作已停止。');
    }
    return { owner: config.owner, name: config.repo, private: true };
  }
  async function readFile(config, token, path) {
    const prefix = `/repos/${config.owner}/${config.repo}`;
    const response = await github(config, token, `${prefix}/contents/${path}?ref=main`);
    if (response.status === 404) return null;
    const file = requireGithub(response);
    if (!plain(file) || file.type !== 'file' || !SHA.test(file.sha || '') || !Number.isFinite(file.size)
      || file.size > MAX_BODY_BYTES) fail(422, 'INVALID_REMOTE_BACKUP', '仓库中的备份文件格式或大小无效。');
    let content = file.content;
    if (file.encoding !== 'base64' || typeof content !== 'string' || !content) {
      // Pin to the immutable blob SHA: a simultaneous update cannot mix old SHA and new content.
      const blob = requireGithub(await github(config, token, `${prefix}/git/blobs/${file.sha}`));
      if (!plain(blob) || blob.encoding !== 'base64' || blob.sha !== file.sha || typeof blob.content !== 'string') fail(422, 'INVALID_REMOTE_BACKUP', '无法读取云备份内容。');
      content = blob.content;
    }
    const bytes = Buffer.from(content.replace(/\s/g, ''), 'base64');
    if (bytes.length !== file.size || bytes.length > MAX_BODY_BYTES) fail(422, 'INVALID_REMOTE_BACKUP', '云备份内容不完整或过大。');
    const actualSha = createHash(file.sha.length === 64 ? 'sha256' : 'sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    if (actualSha !== file.sha) fail(422, 'INVALID_REMOTE_BACKUP', '云备份文件校验失败。');
    return { sha: file.sha, bytes };
  }
  async function backup(config, token, date = null) {
    const file = await readFile(config, token, date ? `snapshots/${date}.json` : 'latest.json');
    if (!file) return { exists: false, sha: null, envelope: null };
    let envelope;
    try { envelope = JSON.parse(file.bytes.toString('utf8')); validateEnvelope(envelope); }
    catch (error) {
      if (error instanceof ServiceError && error.status === 413) throw error;
      fail(422, 'INVALID_REMOTE_BACKUP', '云备份格式或内容摘要无效，未修改本机数据。');
    }
    return { exists: true, sha: file.sha, envelope };
  }
  async function snapshots(config, token) {
    const file = await readFile(config, token, 'snapshots/index.json');
    if (!file) return [];
    try {
      if (file.bytes.length > 2_000_000) throw Error();
      const index = JSON.parse(file.bytes.toString('utf8'));
      safeJson(index);
      if (index.format !== 'wanglu-github-backup-index' || index.version !== 1 || !Array.isArray(index.snapshots) || index.snapshots.length > 5000) throw Error();
      const dates = new Set();
      return index.snapshots.map(item => {
        if (!plain(item) || !validDate(item.date) || dates.has(item.date) || item.path !== `snapshots/${item.date}.json`
          || !/^[a-f0-9]{64}$/.test(item.stateHash || '') || !UUID.test(item.revisionId || '')
          || !SHA.test(item.sourceCommit || '') || typeof item.archivedAt !== 'string' || !Number.isFinite(Date.parse(item.archivedAt))
          || typeof item.sourceUpdatedAt !== 'string' || !Number.isFinite(Date.parse(item.sourceUpdatedAt))) throw Error();
        dates.add(item.date);
        return { date: item.date, path: item.path, stateHash: item.stateHash, revisionId: item.revisionId,
          archivedAt: item.archivedAt, sourceUpdatedAt: item.sourceUpdatedAt, sourceCommit: item.sourceCommit };
      }).sort((left, right) => right.date.localeCompare(left.date));
    } catch { fail(422, 'INVALID_SNAPSHOT_INDEX', '历史备份索引无效，请检查私有仓库。'); }
  }

  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Vary', 'Origin');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    let config, authExtra = {}, oauthNonce;
    let route = '';
    try {
      const origin = header(req, 'origin');
      if (origin && origin !== APP_ORIGIN) fail(403, 'ORIGIN_NOT_ALLOWED', '不允许此页面访问备份服务。');
      if (origin === APP_ORIGIN) res.setHeader('Access-Control-Allow-Origin', APP_ORIGIN);
      const url = new URL(req.url, 'https://routing.invalid');
      route = ROUTES.get(url.pathname) || (url.pathname === '/api/handler' ? url.searchParams.get('route') : '') || '';
      if (![...ROUTES.values()].includes(route)) fail(404, 'NOT_FOUND', '接口不存在。');
      const method = String(req.method || 'GET').toUpperCase();
      if (method === 'OPTIONS') {
        if (origin !== APP_ORIGIN || !['session', 'backup', 'snapshots', 'logout', 'health'].includes(route)) fail(403, 'ORIGIN_NOT_ALLOWED', '不允许此页面访问备份服务。');
        if (!['GET', 'PUT', 'POST'].includes(header(req, 'access-control-request-method'))) fail(405, 'METHOD_NOT_ALLOWED', '请求方法不受支持。');
        const requested = header(req, 'access-control-request-headers').toLowerCase().split(',').map(value => value.trim()).filter(Boolean);
        if (requested.some(value => !['authorization', 'content-type'].includes(value))) fail(403, 'HEADERS_NOT_ALLOWED', '请求头不受支持。');
        res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        res.setHeader('Access-Control-Max-Age', '600');
        res.statusCode = 204; res.end(); return;
      }
      if ((route === 'logout' && method !== 'POST') || (method !== 'GET' && !(route === 'backup' && method === 'PUT') && !(route === 'logout' && method === 'POST'))) {
        res.setHeader('Allow', route === 'backup' ? 'GET, PUT, OPTIONS' : route === 'logout' ? 'POST, OPTIONS' : 'GET, OPTIONS');
        fail(405, 'METHOD_NOT_ALLOWED', '请求方法不受支持。');
      }
      config = readConfig(env);
      if (route === 'health') { json(res, 200, { ok: true, app: 'wanglu-backup-service', version: 1, maxBackupBytes: MAX_BACKUP_BYTES, maxCompressedBytes: MAX_COMPRESSED_BYTES, compression: 'gzip-base64' }); return; }
      if (route === 'auth-start') {
        const nonce = url.searchParams.get('nonce');
        if (!NONCE.test(nonce || '') || url.searchParams.getAll('nonce').length !== 1) fail(400, 'INVALID_NONCE', '登录请求无效，请从听写页面重新连接。');
        const state = randomBytes(32).toString('base64url'), verifier = randomBytes(32).toString('base64url');
        setCookie(res, seal({ state, verifier, nonce, expiresAt: now() + STATE_TTL }, config, 'oauth-state'), STATE_TTL / 1000);
        const target = new URL('https://github.com/login/oauth/authorize');
        target.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.callback,
          state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', allow_signup: 'false' }).toString();
        res.statusCode = 302; res.setHeader('Location', target.href); res.end(); return;
      }
      if (route === 'auth-callback') {
        setCookie(res, '', 0);
        let state;
        try { state = unseal(cookie(req), config, 'oauth-state'); }
        catch { fail(400, 'INVALID_STATE', '登录验证已失效，请从听写页面重新连接。'); }
        const supplied = url.searchParams.get('state') || '';
        if (!plain(state) || !NONCE.test(state.nonce || '') || !NONCE.test(state.state || '')
          || typeof state.verifier !== 'string' || state.expiresAt <= now() || !Number.isFinite(state.expiresAt)
          || !NONCE.test(supplied) || supplied.length !== state.state.length || url.searchParams.getAll('state').length !== 1
          || !timingSafeEqual(Buffer.from(supplied), Buffer.from(state.state))) fail(400, 'INVALID_STATE', '登录验证已失效，请重新连接。');
        oauthNonce = state.nonce;
        if (url.searchParams.has('error')) fail(401, 'LOGIN_CANCELLED', 'GitHub 登录未获授权。');
        const code = url.searchParams.get('code');
        if (!code || code.length > 1024 || url.searchParams.getAll('code').length !== 1) fail(400, 'INVALID_CODE', 'GitHub 登录返回无效，请重试。');
        const token = await exchange(config, { code, redirect_uri: config.callback, code_verifier: state.verifier });
        const fields = tokenFields(token);
        const user = await readUser(config, fields.accessToken);
        await repository(config, fields.accessToken);
        const session = { user, ...fields, issuedAt: now(), expiresAt: Math.min(now() + SESSION_TTL, fields.refreshExpiresAt || fields.accessExpiresAt) };
        popup(res, config, { type: 'wanglu-auth', nonce: state.nonce, session: seal(session, config), user }); return;
      }
      const auth = await authenticate(req, config);
      authExtra = auth.extra;
      if (route === 'logout') {
        const response = await requestJson(`https://api.github.com/applications/${encodeURIComponent(config.clientId)}/token`, {
          method: 'DELETE', headers: { Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
            Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': API_VERSION },
          body: JSON.stringify({ access_token: auth.session.accessToken }),
        }, 64000);
        requireGithub(response, [204, 404]);
        json(res, 200, { ok: true }); return;
      }
      const repo = await repository(config, auth.session.accessToken);
      if (route === 'session') { json(res, 200, { user: auth.session.user, repo, ...authExtra }); return; }
      if (route === 'snapshots') { json(res, 200, { snapshots: await snapshots(config, auth.session.accessToken), ...authExtra }); return; }
      const date = url.searchParams.get('date');
      if (url.searchParams.has('date') && (!validDate(date) || url.searchParams.getAll('date').length !== 1)) fail(400, 'INVALID_DATE', '历史备份日期无效。');
      if (method === 'GET') { json(res, 200, { ...await transportBackup(await backup(config, auth.session.accessToken, date)), ...authExtra }); return; }
      if (date) fail(405, 'READ_ONLY_SNAPSHOT', '历史快照只读；新备份只能写入 latest.json。');
      const body = await readBody(req);
      if (!plain(body) || Object.keys(body).some(key => !['baseSha', 'envelope', 'envelopeGzip'].includes(key))
        || !(body.baseSha === null || (typeof body.baseSha === 'string' && SHA.test(body.baseSha)))) fail(400, 'INVALID_BACKUP', '请提供备份及上次读取的文件版本。');
      const envelope = await decodeEnvelope(body);
      const content = validateEnvelope(envelope);
      const current = await backup(config, auth.session.accessToken);
      if (body.baseSha !== current.sha) fail(409, 'CONFLICT', '云备份已被另一台设备更新，请先检查云端版本。');
      if (envelope.parentRevisionId !== (current.envelope?.revisionId || null)) fail(409, 'CONFLICT', '备份版本链不一致，请重新读取云端版本。');
      const response = await github(config, auth.session.accessToken, `/repos/${config.owner}/${config.repo}/contents/latest.json`, {
        method: 'PUT', body: JSON.stringify({ message: 'Update private dictation backup', branch: 'main',
          content: Buffer.from(content, 'utf8').toString('base64'), ...(body.baseSha ? { sha: body.baseSha } : {}) }),
      });
      if ([409, 422].includes(response.status)) fail(409, 'CONFLICT', '云备份发生版本冲突，请先检查云端版本。');
      const saved = requireGithub(response, [200, 201]);
      if (!SHA.test(saved?.content?.sha || '')) fail(502, 'UPSTREAM_INVALID', 'GitHub 未返回有效保存版本，请检查云端备份。');
      json(res, 200, { sha: saved.content.sha, ...authExtra });
    } catch (error) {
      const safe = sanitizeError(error);
      const details = { code: safe.code, message: safe.message };
      if (route === 'auth-callback' && config && oauthNonce) popup(res, config, { type: 'wanglu-auth', nonce: oauthNonce, error: details }, safe.status);
      else json(res, safe.status, { error: details, ...authExtra });
    }
  };
}
