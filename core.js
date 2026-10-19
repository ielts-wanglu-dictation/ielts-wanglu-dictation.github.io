import { allWords as corpus } from './data.js';

export const STATE_VERSION = 1;
export const DEFAULT_SETTINGS = Object.freeze({
  dailyGoal: 50, theme: 'light', rate: 0.85, repeat: 1, interval: 2,
  accent: 'en-GB', mode: 'speech', autoPlay: false, voiceURI: '',
});

const SPELLINGS = [
  ['organise', 'organize'], ['organisation', 'organization'], ['colour', 'color'],
  ['licence', 'license'], ['practise', 'practice'], ['defence', 'defense'],
  ['offence', 'offense'], ['labour', 'labor'], ['behaviour', 'behavior'],
  ['favourite', 'favorite'], ['neighbour', 'neighbor'], ['honour', 'honor'],
  ['recognise', 'recognize'], ['specialise', 'specialize'], ['analyse', 'analyze'],
  ['travelled', 'traveled'], ['travelling', 'traveling'], ['catalogue', 'catalog'],
  ['programme', 'program'], ['centre', 'center'], ['theatre', 'theater'],
  ['metre', 'meter'], ['litre', 'liter'], ['grey', 'gray'],
  ['archaeologist', 'archeologist'], ['fertiliser', 'fertilizer'],
  ['enrolment', 'enrollment'], ['fulfil', 'fulfill'], ['jewellery', 'jewelry'],
];
const canonicalSpellings = new Map(SPELLINGS.flatMap(([a, b]) => [[a, a], [b, a]]));

/** Ignore typography and UK/US spelling without correcting a misspelled word. */
export function normalizeAnswer(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase()
    .replace(/[’‘`´']/g, '')
    .replace(/[‐‑‒–—−-]/g, ' ')
    .replace(/[.,!?;:，。！？；："“”()[\]{}]/g, ' ')
    .trim().replace(/\s+/g, ' ')
    .split(' ').map(word => canonicalSpellings.get(word) || word).join(' ');
}

/** Explicit alternatives are valid answers; ordinary phrases containing “or” stay whole. */
export function answerVariants(expected) {
  const raw = typeof expected === 'object' ? expected?.text ?? expected?.w ?? '' : expected;
  const text = String(raw ?? '').trim();
  const candidates = [text];
  if (/[=/]/.test(text) && !/^https?:/i.test(text)) {
    candidates.push(...text.split(/\s*[=/]\s*/));
  }
  const ors = text.split(/\s+or\s+/i);
  // Treat “or” as a spelling annotation only when both sides are equivalent.
  // “more or less” and “sooner or later” must still be written in full.
  if (ors.length > 1 && ors.every(part => normalizeAnswer(part) === normalizeAnswer(ors[0]))) {
    candidates.push(...ors);
  }
  const parenthetical = text.match(/^([^()]*)\(([^()]+)\)([^()]*)$/);
  if (parenthetical) {
    const [, before, inside, after] = parenthetical;
    candidates.push(`${before}${after}`);
    if (/^[A-Z][A-Z\d.]*\s*$/.test(before) && !after.trim()) {
      candidates.push(inside); // RA(research assistant)
    } else if (/^[a-z]{1,3}$/.test(inside)) {
      candidates.push(`${before}${inside}${after}`); // book(s)
    } else if (!after.trim() && normalizeAnswer(before) === normalizeAnswer(inside)) {
      candidates.push(inside);
    }
  }
  return [...new Set(candidates.map(normalizeAnswer).filter(Boolean))];
}

export function gradeAnswer(input, expected) {
  const answer = normalizeAnswer(input);
  return Boolean(answer) && answerVariants(expected).includes(answer);
}

function validDate(value, label = '日期') {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${label}无效`);
  return date;
}

/** Calendar dates intentionally use the user's local timezone, never UTC slicing. */
export function localDateKey(value = new Date()) {
  const date = validDate(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** A study day runs from 06:00 to the next 05:59:59 in Beijing (UTC+08:00). */
export function studyDateKey(value = new Date()) {
  // UTC + 8 hours for Beijing, minus 6 hours for the study-day boundary.
  // Fixed arithmetic keeps device timezones and daylight-saving changes irrelevant.
  return new Date(validDate(value).getTime() + 2 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** The current Beijing study day ends at 22:00 UTC, which is the next Beijing 06:00. */
export function nextStudyDayStart(now = new Date()) {
  return new Date(`${studyDateKey(now)}T22:00:00.000Z`);
}

export function updateReview(previous = {}, isCorrect, now = new Date(), uncertain = false) {
  const date = validDate(now);
  const old = previous || {};
  const confidentCorrect = isCorrect && !uncertain;
  const streak = confidentCorrect ? Math.max(0, Number(old.streak) || 0) + 1 : 0;
  const interval = confidentCorrect ? [0, 1, 3, 7, 14, 30, 60][Math.min(streak, 6)] : 0;
  const due = new Date(date);
  due.setDate(due.getDate() + interval);
  return {
    wrongCount: Math.max(0, Number(old.wrongCount) || 0) + (isCorrect ? 0 : 1),
    streak, interval, due: due.toISOString(), date: date.toISOString(),
    uncertain: Boolean(uncertain || (!isCorrect && old.uncertain)),
    uncertainCount: Math.max(0, Number(old.uncertainCount) || 0) + (uncertain ? 1 : 0),
  };
}

function sectionCoverage(history, section) {
  const words = Array.isArray(section) ? section : section?.words || [];
  const sectionId = Array.isArray(section) ? words[0]?.sectionId : section?.id;
  const indexes = new Map(words.map((word, index) => [word.id, index]));
  const completed = new Set();
  let latest = null, latestDate = -Infinity;
  for (const session of history || []) {
    if (!session || !['normal', 'shuffle'].includes(session.mode)) continue;
    const matched = (Array.isArray(session.results) ? session.results : [])
      .filter(result => indexes.has(result?.wordId));
    for (const result of matched) completed.add(indexes.get(result.wordId));
    // Aggregate-only legacy records can suggest a batch size but never invent coverage.
    if (!matched.length && (!sectionId || session.sectionId !== sectionId)) continue;
    const timestamp = Date.parse(session.date);
    const comparable = Number.isFinite(timestamp) ? timestamp : 0;
    if (comparable >= latestDate) { latest = session; latestDate = comparable; }
  }
  const nextIndex = words.findIndex((_, index) => !completed.has(index));
  const suggestedSize = words.length ? Math.min(words.length,
    Number.isInteger(latest?.total) && latest.total > 0 ? latest.total : 50) : 0;
  return { words, completed, progress: { completedCount: completed.size, total: words.length,
    nextIndex: nextIndex < 0 ? null : nextIndex, suggestedSize,
    lastMode: latest?.mode || 'normal', hasProgress: completed.size > 0 } };
}

/** Coverage is reconstructed from actual submitted answers; review retries never advance it. */
export function getSectionProgress(history, section) {
  return sectionCoverage(history, section).progress;
}

export function deriveSectionProgress(history, sectionWords) {
  return getSectionProgress(history, sectionWords);
}

/** Plan the first unpractised contiguous range. A complete section never wraps implicitly. */
export function nextSectionBatch(history, section, size = 50) {
  integer(size, 1, 100000, '练习分组大小');
  const { words, completed, progress } = sectionCoverage(history, section);
  if (progress.nextIndex === null) return null;
  const startIndex = progress.nextIndex;
  let endIndex = startIndex;
  while (endIndex < words.length && endIndex - startIndex < size && !completed.has(endIndex)) endIndex++;
  return { startIndex, endIndex, words: words.slice(startIndex, endIndex), size: endIndex - startIndex };
}

/** Assisted consolidation counts as practice, but not an independent accuracy sample. */
export function computeIndependentStats(history = []) {
  let totalWords = 0, totalCorrect = 0, sessionCount = 0;
  for (const session of history) {
    if (session.assisted === true) continue;
    const total = Math.max(0, Number(session.total) || 0);
    if (!total) continue;
    totalWords += total;
    totalCorrect += Math.min(total, Math.max(0, Number(session.correct) || 0));
    sessionCount++;
  }
  return { totalWords, totalCorrect, sessionCount,
    accuracy: totalWords ? Math.round(totalCorrect / totalWords * 100) : null };
}

export function computeStats(history = [], now = new Date()) {
  const today = studyDateKey(now);
  const days = new Set();
  let todayCount = 0, totalWords = 0;
  for (const session of history) {
    const total = Math.max(0, Number(session.total) || 0);
    totalWords += total;
    if (total > 0) {
      const day = studyDateKey(session.date);
      days.add(day);
      if (day === today) todayCount += total;
    }
  }
  // The cursor represents a calendar label, not a local timestamp or a review due date.
  const cursor = new Date(`${today}T12:00:00.000Z`);
  const cursorKey = () => cursor.toISOString().slice(0, 10);
  // A streak remains alive until the next Beijing 06:00 if yesterday was completed.
  if (!days.has(cursorKey())) cursor.setUTCDate(cursor.getUTCDate() - 1);
  let streak = 0;
  while (days.has(cursorKey())) {
    streak++;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return { todayCount, totalWords, totalSessions: history.length,
    accuracy: computeIndependentStats(history).accuracy ?? 0, streak };
}

export function createInitialState() {
  return { version: STATE_VERSION, settings: { ...DEFAULT_SETTINGS }, history: [], reviews: {}, draft: null };
}

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function assert(condition, message) { if (!condition) throw new Error(message); }
function integer(value, min, max, label) {
  assert(Number.isInteger(value) && value >= min && value <= max, `${label}无效`);
  return value;
}
function text(value, max = 5000) {
  assert(typeof value === 'string' && value.length <= max, '备份包含无效文本');
  return value;
}
function iso(value) {
  assert(typeof value === 'string' && value.length > 0, '备份缺少有效日期');
  return validDate(value, '备份日期').toISOString();
}
function inspectJSON(value, depth = 0) {
  assert(depth <= 20, '备份嵌套层级过深');
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      assert(!['__proto__', 'prototype', 'constructor'].includes(key), '备份包含不安全的字段');
      inspectJSON(entry, depth + 1);
    }
  } else {
    assert(value === null || ['string', 'number', 'boolean'].includes(typeof value), '备份数据类型无效');
    if (typeof value === 'number') assert(Number.isFinite(value), '备份包含无效数值');
  }
}

function validateSettings(raw = {}) {
  assert(isRecord(raw), '设置格式无效');
  const settings = { ...DEFAULT_SETTINGS };
  if ('dailyGoal' in raw) settings.dailyGoal = integer(raw.dailyGoal, 1, 10000, '每日目标');
  if ('groupSize' in raw) settings.groupSize = integer(raw.groupSize, 1, 10000, '分组大小');
  if ('theme' in raw) {
    assert(['light', 'dark', 'system'].includes(raw.theme), '主题设置无效');
    settings.theme = raw.theme;
  }
  if ('rate' in raw) {
    assert(typeof raw.rate === 'number' && raw.rate >= 0.1 && raw.rate <= 3, '语速设置无效');
    settings.rate = raw.rate;
  }
  if ('repeat' in raw) settings.repeat = integer(raw.repeat, 1, 5, '重复次数');
  if ('interval' in raw) {
    assert(typeof raw.interval === 'number' && raw.interval >= 0 && raw.interval <= 60, '播放间隔无效');
    settings.interval = raw.interval;
  }
  if ('accent' in raw) { settings.accent = text(raw.accent, 30); }
  if ('mode' in raw) {
    assert(['speech', 'dictionary'].includes(raw.mode), '发音模式无效');
    settings.mode = raw.mode;
  }
  if ('autoPlay' in raw) {
    assert(typeof raw.autoPlay === 'boolean', '自动播放设置无效');
    settings.autoPlay = raw.autoPlay;
  }
  if ('voiceURI' in raw) settings.voiceURI = text(raw.voiceURI, 1000);
  return settings;
}

function validateResult(raw, wordMap) {
  assert(isRecord(raw), '答题记录格式无效');
  const wordId = text(raw.wordId, 2000);
  const word = wordMap.get(wordId);
  assert(typeof raw.ok === 'boolean', '答题记录缺少批改结果');
  const result = {
    wordId, text: text(raw.text ?? word?.text ?? ''),
    meaning: text(raw.meaning ?? word?.meaning ?? ''),
    phonetic: text(raw.phonetic ?? word?.phonetic ?? ''),
    typed: text(raw.typed ?? ''), ok: raw.ok,
    sectionId: text(raw.sectionId ?? word?.sectionId ?? '', 200),
  };
  if (Object.hasOwn(raw, 'uncertain')) {
    assert(typeof raw.uncertain === 'boolean', '答题模糊标记格式无效');
    result.uncertain = raw.uncertain;
  }
  return result;
}

function validateStudyLink(raw, target) {
  const hasId = Object.hasOwn(raw, 'studyId'), hasRound = Object.hasOwn(raw, 'studyRound');
  assert(hasId === hasRound, '学习来源编号与轮次必须同时提供');
  if (!hasId) return;
  const id = text(raw.studyId, 500);
  assert(id.trim().length > 0, '学习来源编号无效');
  target.studyId = id;
  target.studyRound = integer(raw.studyRound, 1, 1000000, '学习来源轮次');
}

function validateSession(raw, wordMap) {
  assert(isRecord(raw), '历史记录格式无效');
  const total = integer(raw.total, 1, 100000, '历史题数');
  const correct = integer(raw.correct, 0, total, '历史正确题数');
  assert(Array.isArray(raw.results) && raw.results.length <= total, '历史答题明细格式无效');
  const results = raw.results.map(result => validateResult(result, wordMap));
  const recordedCorrect = results.filter(result => result.ok).length;
  assert(recordedCorrect <= correct && results.length - recordedCorrect <= total - correct,
    '历史正确题数与明细不一致');
  if (results.length === total) {
    assert(recordedCorrect === correct, '历史正确题数与明细不一致');
  }
  assert(['normal', 'shuffle', 'review'].includes(raw.mode), '练习模式无效');
  const duration = raw.duration ?? 0;
  assert(typeof duration === 'number' && duration >= 0 && duration <= 31536000, '练习时长无效');
  const session = { id: text(raw.id, 500), sectionId: text(raw.sectionId ?? '', 200),
    title: text(raw.title ?? '', 500), mode: raw.mode, date: iso(raw.date),
    duration, total, correct, results };
  if (Object.hasOwn(raw, 'assisted')) {
    assert(typeof raw.assisted === 'boolean', '辅助练习标记格式无效');
    session.assisted = raw.assisted;
  }
  validateStudyLink(raw, session);
  return session;
}

function validateDraft(raw, wordMap) {
  if (raw === undefined || raw === null) return null;
  assert(isRecord(raw), '续练记录格式无效');
  assert(Array.isArray(raw.wordIds) && raw.wordIds.length > 0 && raw.wordIds.length <= 100000,
    '续练词条格式无效');
  const wordIds = raw.wordIds.map(id => text(id, 2000));
  assert(Array.isArray(raw.answers) && raw.answers.length === wordIds.length, '续练答案数量与词条不一致');
  const answers = raw.answers.map(answer => text(answer));
  assert(['normal', 'shuffle', 'review'].includes(raw.mode), '续练模式无效');
  const elapsed = raw.elapsed ?? 0;
  assert(typeof elapsed === 'number' && elapsed >= 0 && elapsed <= 31536000, '续练时长无效');
  const draft = { id: text(raw.id, 500), sectionId: text(raw.sectionId ?? '', 200),
    title: text(raw.title ?? '', 500), mode: raw.mode, wordIds, answers,
    activeIndex: integer(raw.activeIndex ?? 0, 0, wordIds.length - 1, '当前答题位置'),
    startedAt: iso(raw.startedAt), elapsed };
  if (Object.hasOwn(raw, 'uncertain')) {
    assert(Array.isArray(raw.uncertain) && raw.uncertain.length === wordIds.length
      && raw.uncertain.every(value => typeof value === 'boolean'), '续练模糊标记格式或数量无效');
    draft.uncertain = [...raw.uncertain];
  }
  if (Object.hasOwn(raw, 'assisted')) {
    assert(typeof raw.assisted === 'boolean', '续练辅助标记格式无效');
    draft.assisted = raw.assisted;
  }
  validateStudyLink(raw, draft);
  if (raw.words !== undefined) {
    assert(Array.isArray(raw.words) && raw.words.length === wordIds.length, '续练词条快照数量不一致');
    draft.words = raw.words.map((word, index) => {
      assert(isRecord(word) && word.id === wordIds[index], '续练词条快照编号不一致');
      return { id: word.id, text: text(word.text), meaning: text(word.meaning ?? ''),
        phonetic: text(word.phonetic ?? ''), sectionId: text(word.sectionId ?? '', 200),
        chapterId: text(word.chapterId ?? '', 200), index: word.index ?? index + 1 };
    });
  } else {
    assert(wordIds.every(id => wordMap.has(id)), '续练中含未知词条，请附带词条快照');
  }
  return draft;
}

function validateStudyDraft(raw, wordMap) {
  if (raw === null) return null;
  assert(isRecord(raw), '学习草稿格式无效');
  assert(['normal', 'review'].includes(raw.mode), '学习模式无效');
  const draft = validateDraft(raw, wordMap);
  assert(Array.isArray(raw.uncertain) && raw.uncertain.length === draft.wordIds.length
    && Array.from(raw.uncertain).every(value => typeof value === 'boolean'), '学习模糊标记格式或数量无效');
  draft.round = integer(raw.round, 1, 1000000, '学习轮次');
  assert(typeof raw.completed === 'boolean', '学习完成标记格式无效');
  assert(typeof raw.hidden === 'boolean', '学习遮挡标记格式无效');
  assert(Array.isArray(raw.seen) && raw.seen.length === draft.wordIds.length
    && Array.from(raw.seen).every(value => typeof value === 'boolean'), '学习过词标记格式或数量无效');
  assert(!raw.completed || raw.seen.every(Boolean), '尚有未过词条，不能标记为完成一轮');
  draft.completed = raw.completed;
  draft.hidden = raw.hidden;
  draft.seen = [...raw.seen];
  if (Object.hasOwn(raw, 'parentStudyId')) {
    const id = text(raw.parentStudyId, 500);
    assert(id.trim().length > 0 && id !== draft.id, '原学习任务编号无效');
    draft.parentStudyId = id;
  }
  return draft;
}

/** A separate draft keeps studying from changing dictation scores or section coverage. */
export function createStudyDraft(words, title, sectionId, mode = 'normal', now = new Date(), id = crypto.randomUUID()) {
  assert(Array.isArray(words) && words.length > 0, '学习词条不能为空');
  const raw = { id, sectionId, title, mode, wordIds: words.map(word => word?.id), words,
    answers: words.map(() => ''), uncertain: words.map(() => false), activeIndex: 0,
    startedAt: validDate(now).toISOString(), elapsed: 0,
    round: 1, completed: false, hidden: false, seen: words.map(() => false) };
  return validateStudyDraft(raw, new Map());
}

/** Only an explicit next/complete action passes a word; browsing backwards never does. */
export function advanceStudyDraft(raw, action = 'next') {
  assert(['next', 'prev', 'complete', 'restart'].includes(action), '学习操作无效');
  const draft = validateStudyDraft(raw, new Map(corpus.map(word => [word.id, word])));
  assert(draft !== null, '没有可继续的学习草稿');
  if (action === 'restart') {
    assert(draft.completed, '请先完成当前学习轮次');
    draft.round = integer(draft.round + 1, 1, 1000000, '学习轮次');
    draft.completed = false;
    draft.seen.fill(false);
    draft.answers.fill('');
    draft.activeIndex = 0;
    draft.hidden = false;
    return draft;
  }
  if (action === 'prev') {
    const previousIndex = draft.activeIndex;
    draft.activeIndex = Math.max(0, draft.activeIndex - 1);
    if (draft.activeIndex !== previousIndex) draft.hidden = false;
    return draft;
  }
  if (draft.completed) return draft;
  draft.seen[draft.activeIndex] = true;
  if (action === 'complete' || draft.activeIndex === draft.wordIds.length - 1) {
    const firstUnseen = draft.seen.indexOf(false);
    draft.completed = firstUnseen === -1;
    if (!draft.completed) { draft.activeIndex = firstUnseen; draft.hidden = false; }
  } else {
    draft.activeIndex++;
    draft.hidden = false;
  }
  return draft;
}

/** Active first, then most recently suspended; records remain available for explicit resume. */
export function getStudyDrafts(state) {
  return [...(state.studyDraft ? [state.studyDraft] : []), ...(state.savedStudyDrafts || [])];
}

/** Compare word IDs as a multiset so sorting never resets a task or loses repeated entries. */
export function sameStudyWords(draft, wordsOrIds, sectionId, mode = 'normal') {
  if (!draft || draft.sectionId !== sectionId || draft.mode !== mode
      || !Array.isArray(draft.wordIds) || !Array.isArray(wordsOrIds)
      || draft.wordIds.length !== wordsOrIds.length) return false;
  const counts = new Map();
  for (const id of draft.wordIds) counts.set(id, (counts.get(id) || 0) + 1);
  for (const word of wordsOrIds) {
    const id = typeof word === 'string' ? word : word?.id;
    if (typeof id !== 'string' || !counts.get(id)) return false;
    counts.set(id, counts.get(id) - 1);
  }
  return true;
}

export function findStudyDraft(state, wordsOrIds, sectionId, mode = 'normal') {
  return getStudyDrafts(state).find(draft => sameStudyWords(draft, wordsOrIds, sectionId, mode)) || null;
}

/** Switch tasks without replacing the work in the previously active task. */
export function activateStudyDraft(state, raw) {
  inspectJSON(raw);
  const draft = validateStudyDraft(raw, new Map(corpus.map(word => [word.id, word])));
  assert(draft, '没有可继续的学习草稿');
  const existing = getStudyDrafts(state).find(entry => entry.id === draft.id);
  assert(!existing || sameStudyWords(existing, draft.wordIds, draft.sectionId, draft.mode),
    '学习任务编号已用于另一组词条');
  const saved = (state.savedStudyDrafts || []).filter(entry => entry.id !== draft.id);
  if (state.studyDraft && state.studyDraft.id !== draft.id) saved.unshift(state.studyDraft);
  assert(saved.length <= 10000, '保存的学习任务超过 10000 份');
  const next = { ...state, studyDraft: draft };
  if (saved.length || Object.hasOwn(state, 'savedStudyDrafts')) next.savedStudyDrafts = saved;
  return next;
}

/** Finishing or transferring a task removes its active slot without deleting its progress. */
export function archiveStudyDraft(state) {
  const next = { ...state };
  if (state.studyDraft) {
    const saved = [state.studyDraft, ...(state.savedStudyDrafts || [])
      .filter(entry => entry.id !== state.studyDraft.id)];
    assert(saved.length <= 10000, '保存的学习任务超过 10000 份');
    next.savedStudyDrafts = saved;
  }
  delete next.studyDraft;
  return next;
}

/** Allocate only unclaimed normal-study words; review tasks never reserve section progress. */
export function nextStudyBatchForSection(state, section, size = 50) {
  integer(size, 1, 100000, '学习分组大小');
  const words = Array.isArray(section) ? section : section?.words || [];
  const claimed = new Set();
  for (const draft of getStudyDrafts(state)) {
    if (draft.mode === 'normal') for (const id of draft.wordIds) claimed.add(id);
  }
  for (const session of state.history || []) {
    if (['normal', 'shuffle'].includes(session.mode)) {
      for (const result of session.results || []) claimed.add(result.wordId);
    }
  }
  if (state.draft && ['normal', 'shuffle'].includes(state.draft.mode)) {
    for (const id of state.draft.wordIds) claimed.add(id);
  }
  const startIndex = words.findIndex(word => !claimed.has(word.id));
  if (startIndex < 0) return null;
  let endIndex = startIndex;
  while (endIndex < words.length && endIndex - startIndex < size && !claimed.has(words[endIndex].id)) endIndex++;
  return { startIndex, endIndex, words: words.slice(startIndex, endIndex), size: endIndex - startIndex };
}

/** Validate first; callers must only replace browser state after this succeeds. */
export function validateBackup(input, words = corpus) {
  inspectJSON(input);
  const raw = isRecord(input?.state) ? input.state : input;
  assert(isRecord(raw) && raw.version === STATE_VERSION, '不是可识别的备份文件，或版本不受支持');
  assert(Array.isArray(raw.history) && raw.history.length <= 100000, '备份缺少有效历史记录');
  assert(isRecord(raw.reviews), '备份缺少有效错词本');
  const wordMap = new Map(words.map(word => [word.id, word]));
  const state = createInitialState();
  state.settings = validateSettings(raw.settings ?? {});
  state.history = raw.history.map(session => validateSession(session, wordMap));
  assert(new Set(state.history.map(session => session.id)).size === state.history.length, '历史记录编号重复');
  for (const [id, entry] of Object.entries(raw.reviews)) {
    assert(isRecord(entry), '错词记录格式无效');
    assert(entry.wordId === id, '错词记录编号不一致');
    const word = wordMap.get(id);
    const interval = entry.interval ?? 0;
    assert(typeof interval === 'number' && interval >= 0 && interval <= 36500, '复习间隔无效');
    state.reviews[id] = {
      wordId: text(id, 2000), text: text(entry.text ?? word?.text ?? ''),
      meaning: text(entry.meaning ?? word?.meaning ?? ''),
      phonetic: text(entry.phonetic ?? word?.phonetic ?? ''),
      sectionId: text(entry.sectionId ?? word?.sectionId ?? '', 200),
      wrongCount: integer(entry.wrongCount, 0, 10000000, '错误次数'),
      streak: integer(entry.streak ?? 0, 0, 10000000, '连续正确次数'),
      interval, due: iso(entry.due), date: iso(entry.date), lastTyped: text(entry.lastTyped ?? ''),
    };
    if (Object.hasOwn(entry, 'uncertain')) {
      assert(typeof entry.uncertain === 'boolean', '复习模糊标记格式无效');
      state.reviews[id].uncertain = entry.uncertain;
    }
    if (Object.hasOwn(entry, 'uncertainCount')) {
      state.reviews[id].uncertainCount = integer(entry.uncertainCount, 0, 10000000, '模糊次数');
    }
  }
  state.draft = validateDraft(raw.draft, wordMap);
  if (Object.hasOwn(raw, 'studyDraft')) state.studyDraft = validateStudyDraft(raw.studyDraft, wordMap);
  if (Object.hasOwn(raw, 'savedStudyDrafts')) {
    assert(Array.isArray(raw.savedStudyDrafts) && raw.savedStudyDrafts.length <= 10000,
      '保存的学习任务格式无效或超过 10000 份');
    state.savedStudyDrafts = Array.from(raw.savedStudyDrafts, draft => {
      assert(isRecord(draft), '保存的学习任务格式无效');
      return validateStudyDraft(draft, wordMap);
    });
    const ids = getStudyDrafts(state).map(draft => draft.id);
    assert(new Set(ids).size === ids.length, '学习任务编号重复');
  }
  return state;
}

function parseStored(value, fallback = {}) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { throw new Error('旧版备份包含无法读取的数据'); }
}

/** Import the upstream {hist,wb} export, or raw wl2_ / wl3_ storage snapshots. */
export function migrateLegacy(input, words = corpus) {
  inspectJSON(input);
  assert(isRecord(input), '旧版备份格式无效');
  const recognizable = ['hist', 'wb', 'wl3_hist', 'wl3_wb', 'wl2_hist', 'wl2_wb'].some(key => key in input);
  assert(recognizable, '不是可识别的旧版备份');
  const hist = parseStored(input.hist ?? input.wl3_hist ?? input.wl2_hist);
  const wb = parseStored(input.wb ?? input.wl3_wb ?? input.wl2_wb);
  assert(isRecord(hist) && isRecord(wb), '旧版历史记录或错词本格式无效');
  inspectJSON(hist);
  inspectJSON(wb);
  const state = createInitialState();
  const exact = new Map();
  const literal = new Map();
  const anywhere = new Map();
  for (const word of words) {
    const normalized = normalizeAnswer(word.text);
    const key = `${word.sectionId}\u0000${normalized}`;
    const literalKey = `${word.sectionId}\u0000${word.text.trim().toLowerCase()}`;
    if (!exact.has(key)) exact.set(key, []);
    exact.get(key).push(word);
    if (!literal.has(literalKey)) literal.set(literalKey, []);
    literal.get(literalKey).push(word);
    if (!anywhere.has(normalized)) anywhere.set(normalized, word);
  }
  function resolveWord(raw, sectionId, usedIds) {
    const wordText = text(raw.w ?? raw.word ?? raw.text ?? '');
    assert(wordText.trim().length > 0, '旧版词条为空');
    const normalized = normalizeAnswer(wordText);
    const matches = literal.get(`${sectionId}\u0000${wordText.trim().toLowerCase()}`)
      || exact.get(`${sectionId}\u0000${normalized}`) || [];
    const match = (usedIds ? matches.find(word => !usedIds.has(word.id)) : matches[0])
      || matches[0] || (!sectionId ? anywhere.get(normalized) : undefined);
    if (match && usedIds) usedIds.add(match.id);
    return match || { id: `legacy:${encodeURIComponent(sectionId)}:${encodeURIComponent(wordText.toLowerCase())}`,
      text: wordText, meaning: raw.m ?? raw.mean ?? raw.meaning ?? '',
      phonetic: raw.p ?? raw.phon ?? raw.phonetic ?? '', sectionId };
  }
  function legacyResult(raw, sectionId, usedIds, defaultOk = false) {
    assert(isRecord(raw), '旧版答题明细格式无效');
    const word = resolveWord(raw, sectionId, usedIds);
    assert(raw.ok === undefined || typeof raw.ok === 'boolean', '旧版批改结果格式无效');
    return { wordId: word.id, text: word.text, meaning: word.meaning, phonetic: word.phonetic,
      typed: text(raw.typed ?? ''), ok: raw.ok ?? defaultOk, sectionId: word.sectionId };
  }
  for (const [sectionId, sessions] of Object.entries(hist)) {
    assert(Array.isArray(sessions), '旧版历史记录格式无效');
    sessions.forEach((session, index) => {
      assert(isRecord(session), '旧版练习记录格式无效');
      const total = integer(session.total, 1, 100000, '旧版历史题数');
      const correct = integer(session.correct, 0, total, '旧版正确题数');
      assert(session.all === undefined || Array.isArray(session.all), '旧版全部答题明细格式无效');
      assert(session.wrong === undefined || Array.isArray(session.wrong), '旧版错题明细格式无效');
      const usedIds = new Set();
      const results = session.all?.length ? session.all.map(row => legacyResult(row, sectionId, usedIds))
        : (session.wrong || []).map(row => legacyResult(row, sectionId, usedIds));
      state.history.push({ id: `legacy-${sectionId}-${index + 1}`, sectionId,
        title: sectionId === '__wb__' ? '旧版错词练习' : `小节 ${sectionId}`,
        mode: sectionId === '__wb__' ? 'review' : session.mode === 'shuffle' ? 'shuffle' : 'normal',
        date: iso(session.date), duration: 0, total, correct, results });
    });
  }
  for (const entry of Object.values(wb)) {
    assert(isRecord(entry), '旧版错词记录格式无效');
    const sectionId = text(entry.chap ?? entry.sectionId ?? '', 200);
    const word = resolveWord(entry, sectionId);
    let date = new Date();
    if (entry.d) {
      const candidate = new Date(String(entry.d).replace(/年|月/g, '/').replace(/日/g, ''));
      if (Number.isFinite(candidate.getTime())) date = candidate;
    }
    const previous = state.reviews[word.id];
    const wrongCount = integer(entry.n ?? 1, 0, 10000000, '旧版错误次数');
    state.reviews[word.id] = { wordId: word.id, text: word.text, meaning: word.meaning,
      phonetic: word.phonetic, sectionId: word.sectionId,
      wrongCount: (previous?.wrongCount || 0) + wrongCount, streak: 0, interval: 0,
      due: date.toISOString(), date: date.toISOString(), lastTyped: '' };
  }
  const audio = parseStored(input.wl3_audio ?? input.wl2_audio);
  if (isRecord(audio)) {
    const settings = {};
    if (audio.rate !== undefined) settings.rate = audio.rate;
    if (audio.rep !== undefined) settings.repeat = audio.rep;
    if (audio.gap !== undefined) settings.interval = audio.gap;
    if (audio.auto !== undefined) settings.autoPlay = audio.auto;
    if (audio.voice !== undefined) settings.mode = audio.voice === 'real' ? 'dictionary' : 'speech';
    state.settings = validateSettings(settings);
  }
  state.history.sort((a, b) => new Date(a.date) - new Date(b.date));
  return validateBackup(state, words);
}

export function parseBackup(raw, words = corpus) {
  let input = raw;
  if (typeof raw === 'string') {
    assert(raw.length <= 50 * 1024 * 1024, '备份文件超过 50 MB');
    try { input = JSON.parse(raw); } catch { throw new Error('无法读取 JSON 备份文件'); }
  }
  assert(isRecord(input), '备份文件必须是 JSON 对象');
  if (input.version !== undefined || input.state !== undefined) return validateBackup(input, words);
  return migrateLegacy(input, words);
}
