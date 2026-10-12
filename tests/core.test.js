import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { allWords, chapters, sections, getAllWords } from '../data.js';
import {
  answerVariants, computeStats, createInitialState, gradeAnswer, localDateKey,
  migrateLegacy, normalizeAnswer, parseBackup, updateReview, validateBackup,
} from '../core.js';

const now = new Date(2026, 9, 11, 12, 0, 0);
const word = allWords[0];
const result = (ok = true) => ({ wordId: word.id, text: word.text, meaning: word.meaning,
  phonetic: word.phonetic, typed: ok ? word.text : 'bananna', ok, sectionId: word.sectionId });
const session = (overrides = {}) => ({ id: 'session-1', sectionId: word.sectionId,
  title: '小节 3.2', mode: 'normal', date: now.toISOString(), duration: 10,
  total: 1, correct: 1, results: [result()], ...overrides });

test('corpus preserves every upstream occurrence, section and all text fields', () => {
  assert.equal(chapters.length, 4);
  assert.equal(sections.length, 32);
  assert.equal(allWords.length, 5873);
  assert.equal(new Set(allWords.map(word => word.id)).size, 5873);
  const digest = createHash('sha256')
    .update(JSON.stringify(allWords.map(word => [word.sectionId, word.text, word.phonetic, word.meaning])))
    .digest('hex');
  assert.equal(digest, '2800b9aa269cdfc02cac7d32846e63b41f19bd4740eaf315c06d555566c84a52');
  assert.deepEqual(sections.map(section => section.words.length), [358,112,143,113,112,145,113,104,
    152,142,58,104,104,126,12,378,114,111,114,105,100,108,130,144,140,142,127,235,366,396,349,916]);
  const copy = getAllWords();
  copy.pop();
  assert.equal(allWords.length, 5873);
});

test('grading tolerates typography and whole-token regional spelling in phrases', () => {
  assert.ok(gradeAnswer('  COLOUR   CENTRE! ', 'color center'));
  assert.ok(gradeAnswer('well known', 'well-known'));
  assert.ok(gradeAnswer('students union', 'students’ union'));
  assert.ok(gradeAnswer('ＮＥＩＧＨＢＯＵＲ', 'neighbor'));
  assert.equal(normalizeAnswer(' organization '), normalizeAnswer('organisation'));
});

test('grading rejects empty answers, misspellings and missing phrase words', () => {
  for (const value of ['', ' ', '...']) assert.equal(gradeAnswer(value, 'bananas'), false);
  assert.equal(gradeAnswer('', ''), false);
  assert.equal(gradeAnswer('bananna', 'bananas'), false);
  assert.equal(gradeAnswer('medical', 'medical history'), false);
  assert.equal(gradeAnswer('less', 'more or less'), false);
});

test('explicit spelling alternatives and original abbreviation annotations are accepted', () => {
  assert.ok(gradeAnswer('archeologist', 'archaeologist=archeologist'));
  assert.ok(gradeAnswer('fertiliser', 'fertiliser=fertilizer'));
  assert.ok(gradeAnswer('colour', 'colour/color'));
  assert.ok(gradeAnswer('theater', 'theatre or theater'));
  assert.ok(gradeAnswer('RA', 'RA(research assistant)'));
  assert.ok(gradeAnswer('research assistant', 'RA(research assistant)'));
  assert.ok(gradeAnswer('books', 'book(s)'));
  assert.ok(gradeAnswer('book', 'book(s)'));
  assert.ok(answerVariants('RA(research assistant)').includes('ra'));
  assert.ok(gradeAnswer(word.text, word));
});

test('date keys describe local calendar days and reject invalid input', () => {
  assert.equal(localDateKey(new Date(2026, 0, 1, 0, 5)), '2026-01-01');
  assert.equal(localDateKey(new Date(2026, 11, 31, 23, 59)), '2026-12-31');
  assert.throws(() => localDateKey('invalid date'));
});

test('review scheduling advances correctly and wrong answers reset the interval', () => {
  const firstWrong = updateReview({}, false, now);
  assert.equal(firstWrong.wrongCount, 1);
  assert.equal(firstWrong.interval, 0);
  assert.equal(firstWrong.due, now.toISOString());
  const firstRight = updateReview(firstWrong, true, now);
  assert.equal(firstRight.interval, 1);
  assert.equal(firstRight.streak, 1);
  assert.equal(firstRight.wrongCount, 1);
  assert.equal(localDateKey(firstRight.due), '2026-10-12');
  const secondRight = updateReview(firstRight, true, now);
  assert.equal(secondRight.interval, 3);
  const wrongAgain = updateReview(secondRight, false, now);
  assert.equal(wrongAgain.streak, 0);
  assert.equal(wrongAgain.interval, 0);
  assert.equal(wrongAgain.wrongCount, 2);
  assert.equal(firstRight.streak, 1, 'the previous record must not be mutated');
});

test('review intervals are calendar days across month boundaries', () => {
  const result = updateReview({ streak: 1 }, true, new Date(2026, 0, 30, 12));
  assert.equal(localDateKey(result.due), '2026-02-02');
});

test('stats weight accuracy by word count and include all modes in daily totals', () => {
  const history = [session({ total: 100, correct: 50, results: [] }),
    session({ id: 'review', total: 10, correct: 10, mode: 'review', results: [] })];
  assert.deepEqual(computeStats(history, now), {
    todayCount: 110, totalWords: 110, totalSessions: 2, accuracy: 55, streak: 1,
  });
  assert.deepEqual(computeStats([], now), {
    todayCount: 0, totalWords: 0, totalSessions: 0, accuracy: 0, streak: 0,
  });
});

test('streak survives an unfinished today, deduplicates days, and breaks on a missed day', () => {
  const day = number => new Date(2026, 9, number, 12).toISOString();
  const history = [session({ date: day(9) }), session({ date: day(10) }), session({ date: day(10) })];
  assert.equal(computeStats(history, now).streak, 2);
  assert.equal(computeStats(history, new Date(2026, 9, 12, 12)).streak, 0);
});

test('new backups round-trip settings, history, review scheduling and in-progress answers', () => {
  const state = createInitialState();
  state.settings.dailyGoal = 70;
  state.history.push(session());
  state.reviews[word.id] = { wordId: word.id, text: word.text, meaning: word.meaning,
    phonetic: word.phonetic, sectionId: word.sectionId, ...updateReview({}, false, now), lastTyped: 'banana' };
  state.draft = { id: 'draft-1', sectionId: word.sectionId, title: '小节 3.2', mode: 'normal',
    wordIds: [word.id], answers: ['bana'], activeIndex: 0, startedAt: now.toISOString(), elapsed: 2 };
  assert.deepEqual(parseBackup(JSON.stringify(state)), state);
  assert.deepEqual(parseBackup(JSON.stringify({ state, exportedAt: now.toISOString() })), state);
  const imported = validateBackup(state);
  imported.history[0].results[0].typed = 'changed';
  assert.equal(state.history[0].results[0].typed, word.text);
});

test('unrecognized, malformed and future-version backups fail without modifying state', () => {
  for (const data of ['{}', '[]', 'bad json', '{"version":2,"history":[],"reviews":{}}']) {
    assert.throws(() => parseBackup(data));
  }
  const original = createInitialState();
  const raw = JSON.stringify(original);
  assert.throws(() => validateBackup({ ...original, history: [session({ correct: 2 })] }));
  assert.equal(JSON.stringify(original), raw);
});

test('backup validation rejects inconsistent scores, duplicate session ids and unsafe keys', () => {
  const state = createInitialState();
  assert.throws(() => validateBackup({ ...state, history: [session({ correct: 0 })] }), /不一致/);
  assert.throws(() => validateBackup({ ...state, history: [session(), session()] }), /重复/);
  assert.throws(() => parseBackup('{"version":1,"history":[],"reviews":{},"__proto__":{}}'), /不安全/);
  assert.throws(() => parseBackup({ hist: '{"__proto__":[]}', wb: {} }), /不安全/);
});

test('backup validation rejects broken draft answer counts and unknown ids without snapshots', () => {
  const state = createInitialState();
  const draft = { id: 'd', sectionId: '3.2', title: '练习', mode: 'normal',
    wordIds: [word.id], answers: [], activeIndex: 0, startedAt: now.toISOString(), elapsed: 0 };
  assert.throws(() => validateBackup({ ...state, draft }), /数量/);
  draft.answers = ['test'];
  draft.wordIds = ['missing'];
  assert.throws(() => validateBackup({ ...state, draft }), /未知/);
});

test('legacy import preserves original full answer details and word identity', () => {
  const legacy = { hist: { '3.2': [{ n: 1, pct: 0, total: 1, correct: 0,
    date: now.toISOString(), mode: 'shuffle', all: [{ w: 'bananas', p: 'p', m: '香蕉', typed: 'banana', ok: false }],
    wrong: [{ w: 'bananas', typed: 'banana' }] }] },
    wb: { bananas: { word: 'bananas', phon: 'p', mean: '香蕉', chap: '3.2', n: 4, d: '2026/10/10' } } };
  const state = migrateLegacy(legacy);
  assert.equal(state.history[0].mode, 'shuffle');
  assert.equal(state.history[0].results[0].wordId, word.id);
  assert.equal(state.history[0].results[0].typed, 'banana');
  assert.equal(state.reviews[word.id].wrongCount, 4);
  assert.equal(state.reviews[word.id].interval, 0);
  assert.equal(localDateKey(state.reviews[word.id].due), '2026-10-10');
});

test('legacy aggregate-only histories retain score totals and available mistakes', () => {
  const state = migrateLegacy({ hist: { '3.2': [{ n: 1, total: 100, correct: 99,
    date: now.toISOString(), wrong: [{ w: 'bananas', typed: 'banana' }] }] }, wb: {} });
  assert.equal(state.history[0].total, 100);
  assert.equal(state.history[0].correct, 99);
  assert.equal(state.history[0].results.length, 1);
  assert.equal(computeStats(state.history, now).accuracy, 99);
});

test('legacy unknown words survive migration and can round-trip', () => {
  const state = migrateLegacy({ hist: {}, wb: { custom: { word: 'my custom word',
    mean: '自定义词条', phon: 'custom', chap: 'other', n: 2, d: '2026/10/10' } } });
  const review = Object.values(state.reviews)[0];
  assert.ok(review.wordId.startsWith('legacy:'));
  assert.equal(review.text, 'my custom word');
  assert.equal(review.meaning, '自定义词条');
  assert.deepEqual(parseBackup(JSON.stringify(state)), state);
});

test('legacy storage snapshots support both generations and preserve audio settings', () => {
  for (const prefix of ['wl2', 'wl3']) {
    const state = parseBackup({ [`${prefix}_hist`]: '{}', [`${prefix}_wb`]: '{}',
      [`${prefix}_audio`]: JSON.stringify({ rate: 0.8, rep: 3, gap: 3, voice: 'real', auto: true }) });
    assert.equal(state.settings.rate, 0.8);
    assert.equal(state.settings.repeat, 3);
    assert.equal(state.settings.interval, 3);
    assert.equal(state.settings.mode, 'dictionary');
    assert.equal(state.settings.autoPlay, true);
  }
});

test('legacy full sessions retain the distinct IDs of repeated words within one section', () => {
  const section = sections[0];
  const legacy = { hist: { [section.id]: [{ n: 1, total: section.words.length,
    correct: section.words.length, date: now.toISOString(), all: section.words.map(word => ({
      w: word.text, p: word.phonetic, m: word.meaning, typed: word.text, ok: true,
    })) }] }, wb: {} };
  const migrated = migrateLegacy(legacy);
  assert.deepEqual(migrated.history[0].results.map(row => row.wordId), section.words.map(word => word.id));
  assert.equal(new Set(migrated.history[0].results.map(row => row.wordId)).size, section.words.length);
});

test('app-style review snapshots round-trip for both corpus and imported custom words', () => {
  const state = migrateLegacy({ hist: {}, wb: { x: {
    word: 'custom phrase', mean: '自定义短语', chap: 'custom', n: 1,
  } } });
  state.reviews[word.id] = { ...result(false), ...updateReview(undefined, false, now), lastTyped: 'banana' };
  const words = Object.values(state.reviews).map(review => ({ ...review, id: review.wordId }));
  state.draft = { id: 'review-session', sectionId: 'review', title: '今日到期复习', mode: 'review',
    words, wordIds: words.map(word => word.id), answers: words.map(word => word.text),
    activeIndex: 1, startedAt: now.toISOString(), elapsed: 12 };
  const reloaded = parseBackup(JSON.stringify(state));
  assert.equal(reloaded.draft.words.length, 2);
  assert.equal(reloaded.draft.words[0].text, 'custom phrase');
  const results = reloaded.draft.words.map((word, index) => ({ wordId: word.id,
    text: word.text, meaning: word.meaning, phonetic: word.phonetic, sectionId: word.sectionId,
    typed: reloaded.draft.answers[index], ok: gradeAnswer(reloaded.draft.answers[index], word.text) }));
  reloaded.history.push(session({ id: reloaded.draft.id, sectionId: 'review', mode: 'review',
    total: results.length, correct: results.length, results }));
  for (const row of results) {
    const previous = reloaded.reviews[row.wordId];
    reloaded.reviews[row.wordId] = { ...previous, ...row, ...updateReview(previous, row.ok, now), lastTyped: row.typed };
  }
  reloaded.draft = null;
  const final = parseBackup(JSON.stringify(reloaded));
  assert.equal(final.history[0].correct, 2);
  assert.equal(final.reviews[word.id].streak, 1);
  assert.equal(final.reviews[word.id].wrongCount, 1);
  assert.equal(final.reviews[word.id].lastTyped, word.text);
});

test('malformed legacy records are rejected rather than silently discarded', () => {
  assert.throws(() => migrateLegacy({ hist: { '3.2': 'wrong' }, wb: {} }));
  assert.throws(() => migrateLegacy({ hist: { '3.2': [{ total: 1, correct: 2, date: now.toISOString() }] }, wb: {} }));
  assert.throws(() => migrateLegacy({ hist: {}, wb: { x: { word: '', n: 1 } } }));
  assert.deepEqual(migrateLegacy({ hist: {}, wb: {} }), createInitialState());
});
