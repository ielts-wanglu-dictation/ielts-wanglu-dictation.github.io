import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sections } from '../data.js';
import { createInitialState, deriveSectionProgress, getSectionProgress, nextSectionBatch,
  parseBackup, updateReview } from '../core.js';
import { BACKUP_FORMAT, hashState, validateEnvelope } from '../backup.js';

const now = new Date('2026-10-14T01:00:00.000Z');
const section = sections[0], word = section.words[0];
const row = (word, extra = {}) => ({ wordId: word.id, text: word.text, meaning: word.meaning,
  phonetic: word.phonetic, sectionId: word.sectionId, typed: word.text, ok: true, ...extra });
const completed = (words, extra = {}) => ({ id: randomUUID(), sectionId: section.id, title: '练习',
  mode: 'normal', date: now.toISOString(), duration: 10, total: words.length,
  correct: words.length, results: words.map(word => row(word)), ...extra });
function oldState() {
  const state = createInitialState();
  state.history = [completed([word])];
  state.reviews[word.id] = { wordId: word.id, text: word.text, meaning: word.meaning,
    phonetic: word.phonetic, sectionId: word.sectionId, wrongCount: 1, streak: 0,
    interval: 0, due: now.toISOString(), date: now.toISOString(), lastTyped: 'banana' };
  state.draft = { id: 'original-draft', sectionId: section.id, title: '未完成练习', mode: 'normal',
    wordIds: [word.id], answers: ['bana'], activeIndex: 0, startedAt: now.toISOString(), elapsed: 12 };
  return state;
}
async function cloudEnvelope(state) {
  return { format: BACKUP_FORMAT, version: 1, revisionId: randomUUID(), parentRevisionId: null,
    updatedAt: now.toISOString(), studyDay: '2026-10-14', state, stateHash: await hashState(state) };
}

test('old local and cloud backups retain exactly the same state hash without synthesized flags', async () => {
  const old = oldState(), parsed = parseBackup(JSON.stringify(old));
  assert.deepEqual(parsed, old);
  assert.equal(Object.hasOwn(parsed.draft, 'uncertain'), false);
  assert.equal(Object.hasOwn(parsed.history[0].results[0], 'uncertain'), false);
  assert.equal(Object.hasOwn(parsed.reviews[word.id], 'uncertain'), false);
  assert.equal(Object.hasOwn(parsed.reviews[word.id], 'uncertainCount'), false);
  const remote = await cloudEnvelope(old);
  assert.equal(await hashState(parsed), remote.stateHash);
  assert.deepEqual((await validateEnvelope(remote)).state, old);
});

test('new true and false uncertain flags survive draft, result, review and cloud round trips', async () => {
  for (const uncertain of [true, false]) {
    const state = oldState();
    state.draft.uncertain = [uncertain];
    state.history[0].results[0].uncertain = uncertain;
    state.reviews[word.id].uncertain = uncertain;
    state.reviews[word.id].uncertainCount = uncertain ? 2 : 0;
    assert.deepEqual(parseBackup(JSON.stringify(state)), state);
    const verified = await validateEnvelope(await cloudEnvelope(state));
    assert.deepEqual(verified.state, state);
    verified.state.draft.uncertain[0] = !uncertain;
    assert.equal(state.draft.uncertain[0], uncertain, 'validation must not share draft arrays');
  }
});

test('invalid uncertain flags and counts are rejected instead of silently normalized', () => {
  for (const invalid of ['true', 1, null, []]) {
    const resultState = oldState(); resultState.history[0].results[0].uncertain = invalid;
    assert.throws(() => parseBackup(resultState), /模糊/);
    const reviewState = oldState(); reviewState.reviews[word.id].uncertain = invalid;
    assert.throws(() => parseBackup(reviewState), /模糊/);
  }
  for (const invalid of [[], [true, false], ['true'], null, {}]) {
    const state = oldState(); state.draft.uncertain = invalid;
    assert.throws(() => parseBackup(state), /模糊/);
  }
  for (const invalid of [-1, 1.5, '2', null, 10000001]) {
    const state = oldState(); state.reviews[word.id].uncertainCount = invalid;
    assert.throws(() => parseBackup(state), /模糊/);
  }
});

test('a correct but uncertain submission is due now, resets mastery and is not an error', () => {
  const previous = { wrongCount: 2, streak: 5, interval: 30, uncertainCount: 3, uncertain: false };
  const next = updateReview(previous, true, now, true);
  assert.equal(next.wrongCount, 2);
  assert.equal(next.uncertainCount, 4);
  assert.equal(next.uncertain, true);
  assert.equal(next.streak, 0);
  assert.equal(next.interval, 0);
  assert.equal(next.due, now.toISOString());
  assert.equal(previous.uncertainCount, 3);
  const newWord = updateReview(undefined, true, now, true);
  assert.equal(newWord.wrongCount, 0);
  assert.equal(newWord.uncertainCount, 1);
});

test('uncertain status persists after another error and clears only after confident correctness', () => {
  const first = updateReview(undefined, false, now, true);
  assert.equal(first.wrongCount, 1);
  assert.equal(first.uncertainCount, 1);
  const laterError = updateReview(first, false, now, false);
  assert.equal(laterError.uncertain, true);
  assert.equal(laterError.wrongCount, 2);
  assert.equal(laterError.uncertainCount, 1);
  const confident = updateReview(laterError, true, now, false);
  assert.equal(confident.uncertain, false);
  assert.equal(confident.uncertainCount, 1);
  assert.equal(confident.wrongCount, 2);
  assert.equal(confident.streak, 1);
  assert.equal(confident.interval, 1);
});

test('a submitted first batch resumes at word 51 after normal backup reload', () => {
  const state = createInitialState();
  state.history = [completed(section.words.slice(0, 50))];
  const reloaded = parseBackup(JSON.stringify(state));
  const progress = getSectionProgress(reloaded.history, section);
  assert.deepEqual(progress, { completedCount: 50, total: section.words.length, nextIndex: 50,
    suggestedSize: 50, lastMode: 'normal', hasProgress: true });
  const next = nextSectionBatch(reloaded.history, section, 50);
  assert.equal(next.startIndex, 50);
  assert.equal(next.endIndex, 100);
  assert.equal(next.size, 50);
  assert.deepEqual(next.words, section.words.slice(50, 100));
  assert.deepEqual(deriveSectionProgress(reloaded.history, section.words), progress);
});

test('disjoint completion fills the first gap without repeating or skipping known words', () => {
  const history = [completed(section.words.slice(0, 20)), completed(section.words.slice(40, 60))];
  const before = JSON.stringify(history);
  const batch = nextSectionBatch(history, section, 50);
  assert.equal(batch.startIndex, 20);
  assert.equal(batch.endIndex, 40);
  assert.equal(batch.size, 20);
  assert.deepEqual(batch.words, section.words.slice(20, 40));
  assert.equal(JSON.stringify(history), before);
  history.push(completed(batch.words));
  assert.equal(nextSectionBatch(history, section, 50).startIndex, 60);
});

test('shuffle coverage follows actual IDs and repeated attempts do not inflate completion', () => {
  const selected = [section.words[70], section.words[2], section.words[0]];
  const history = [completed(selected, { mode: 'shuffle' }), completed(selected, { mode: 'shuffle' })];
  const progress = getSectionProgress(history, section);
  assert.equal(progress.completedCount, 3);
  assert.equal(progress.nextIndex, 1);
  assert.equal(progress.lastMode, 'shuffle');
  const next = nextSectionBatch(history, section, 50);
  assert.equal(next.startIndex, 1);
  assert.equal(next.endIndex, 2);
});

test('review retries and words belonging to another section do not advance section progress', () => {
  const history = [completed(section.words.slice(0, 50), { mode: 'review' }),
    completed(sections[1].words.slice(0, 20), { sectionId: section.id })];
  assert.equal(getSectionProgress(history, section).completedCount, 0);
  assert.equal(nextSectionBatch(history, section).startIndex, 0);
  assert.equal(nextSectionBatch(history, section).size, 50);
});

test('partial legacy details count known IDs only and never infer unrecorded coverage', () => {
  const history = [completed([], { total: 100, correct: 99, results: [row(section.words[30], { ok: false })] }),
    completed([], { total: 100, correct: 100, results: [] })];
  const progress = getSectionProgress(history, section);
  assert.equal(progress.completedCount, 1);
  assert.equal(progress.nextIndex, 0);
  assert.equal(nextSectionBatch(history, section, 50).endIndex, 30);
});

test('new, exhausted and empty sections have explicit boundaries and never wrap', () => {
  assert.equal(getSectionProgress([], section).hasProgress, false);
  assert.equal(nextSectionBatch([], section, 20).size, 20);
  const history = [completed(section.words)];
  assert.equal(getSectionProgress(history, section).nextIndex, null);
  assert.equal(getSectionProgress(history, section).completedCount, section.words.length);
  assert.equal(nextSectionBatch(history, section), null);
  assert.equal(nextSectionBatch([], { id: 'empty', words: [] }), null);
  assert.throws(() => nextSectionBatch([], section, 0));
  assert.throws(() => nextSectionBatch([], section, 1.5));
});
