import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sections } from '../data.js';
import { advanceStudyDraft, computeIndependentStats, computeStats, createInitialState,
  createStudyDraft, getSectionProgress, parseBackup, studyDateKey } from '../core.js';
import { BACKUP_FORMAT, hashState, validateEnvelope } from '../backup.js';

const now = new Date('2026-10-18T02:00:00.000Z');
const section = sections[0], words = section.words.slice(0, 3), word = words[0];
const study = (mode = 'normal') => createStudyDraft(words, '学习小节', section.id, mode, now, 'study-001');
function session(selected = [word], extra = {}) {
  return { id: randomUUID(), sectionId: section.id, title: '听写', mode: 'normal',
    date: now.toISOString(), duration: 30, total: selected.length, correct: selected.length,
    results: selected.map(word => ({ wordId: word.id, text: word.text, meaning: word.meaning,
      phonetic: word.phonetic, sectionId: word.sectionId, typed: word.text, ok: true })), ...extra };
}
function oldState() {
  const state = createInitialState();
  state.history = [session()];
  state.draft = { id: 'dictation-001', sectionId: section.id, title: '继续听写', mode: 'normal',
    wordIds: [word.id], answers: ['bana'], activeIndex: 0, startedAt: now.toISOString(), elapsed: 5 };
  state.reviews[word.id] = { wordId: word.id, text: word.text, meaning: word.meaning,
    phonetic: word.phonetic, sectionId: word.sectionId, wrongCount: 1, streak: 0,
    interval: 0, due: now.toISOString(), date: now.toISOString(), lastTyped: 'banana' };
  return state;
}
async function cloudEnvelope(state) {
  return { format: BACKUP_FORMAT, version: 1, revisionId: randomUUID(), parentRevisionId: null,
    updatedAt: now.toISOString(), studyDay: studyDateKey(now), state, stateHash: await hashState(state) };
}

test('old state and cloud hashes stay unchanged without synthesized study or assisted fields', async () => {
  assert.equal(Object.hasOwn(createInitialState(), 'studyDraft'), false);
  const original = oldState(), parsed = parseBackup(JSON.stringify(original));
  assert.deepEqual(parsed, original);
  assert.equal(Object.hasOwn(parsed, 'studyDraft'), false);
  assert.equal(Object.hasOwn(parsed.draft, 'assisted'), false);
  assert.equal(Object.hasOwn(parsed.history[0], 'assisted'), false);
  assert.equal(await hashState(parsed), await hashState(original));
  assert.deepEqual((await validateEnvelope(await cloudEnvelope(original))).state, original);
});

test('study creation makes canonical snapshots without altering caller words', () => {
  const supplied = words.map(word => ({ ...word, transientUIValue: true }));
  const original = structuredClone(supplied), draft = createStudyDraft(supplied, '学习', section.id, 'normal', now);
  assert.match(draft.id, /^[\da-f-]{36}$/i);
  assert.deepEqual(supplied, original);
  assert.deepEqual(draft.seen, [false, false, false]);
  assert.deepEqual(draft.answers, ['', '', '']);
  assert.deepEqual(draft.uncertain, [false, false, false]);
  assert.equal(draft.round, 1);
  assert.equal(draft.completed, false);
  assert.equal(draft.hidden, false);
  assert.equal(draft.activeIndex, 0);
  assert.equal(draft.startedAt, now.toISOString());
  assert.equal(Object.hasOwn(draft.words[0], 'transientUIValue'), false);
  const state = createInitialState(); state.studyDraft = draft;
  assert.deepEqual(parseBackup(state), state);
  draft.words[0].text = 'changed';
  assert.equal(supplied[0].text, original[0].text);
});

test('normal and review study drafts survive exact local and cloud round trips', async () => {
  for (const mode of ['normal', 'review']) {
    const state = oldState();
    state.studyDraft = advanceStudyDraft(study(mode));
    state.studyDraft.hidden = true;
    state.studyDraft.answers[1] = '抄写 / copying';
    state.studyDraft.uncertain[1] = true;
    state.studyDraft.elapsed = 7.25;
    state.draft.assisted = true;
    state.history[0].assisted = false;
    assert.deepEqual(parseBackup(JSON.stringify(state)), state);
    const validated = (await validateEnvelope(await cloudEnvelope(state))).state;
    assert.deepEqual(validated, state);
    validated.studyDraft.answers[1] = 'changed';
    validated.studyDraft.seen[1] = true;
    validated.studyDraft.uncertain[1] = false;
    assert.equal(state.studyDraft.answers[1], '抄写 / copying');
    assert.equal(state.studyDraft.seen[1], false);
    assert.equal(state.studyDraft.uncertain[1], true);
  }
});

test('explicitly cleared study draft and both assisted boolean values are preserved', async () => {
  for (const assisted of [false, true]) {
    const state = oldState(); state.studyDraft = null;
    state.draft.assisted = assisted;
    state.history[0].assisted = assisted;
    assert.deepEqual(parseBackup(state), state);
    assert.deepEqual((await validateEnvelope(await cloudEnvelope(state))).state, state);
  }
});

test('malformed learning fields and unvisited completed rounds are rejected', () => {
  const invalidFields = {
    round: [0, -1, 1.5, '1', null, 1000001], completed: [0, 'false', null],
    hidden: [1, 'true', null], seen: [[], [false], [true, false, 1], null, 'false'],
    mode: ['shuffle', 'study', null], uncertain: [[], null, {}, false, [false], [false, 'true', false], new Array(3)],
    answers: [[], [1, '', '']], activeIndex: [-1, 3, 0.5],
  };
  for (const [field, values] of Object.entries(invalidFields)) {
    for (const value of values) {
      const state = createInitialState(); state.studyDraft = { ...study(), [field]: value };
      assert.throws(() => parseBackup(state), `must reject ${field}=${JSON.stringify(value)}`);
    }
  }
  for (const field of ['round', 'completed', 'hidden', 'seen', 'uncertain']) {
    const state = createInitialState(); state.studyDraft = study(); delete state.studyDraft[field];
    assert.throws(() => parseBackup(state), `must require ${field}`);
  }
  const state = createInitialState(); state.studyDraft = { ...study(), completed: true };
  assert.throws(() => parseBackup(state), /未过词条/);
  state.studyDraft.seen = [true, true, true];
  assert.equal(parseBackup(state).studyDraft.completed, true);
  for (const value of [false, [], '', 1]) {
    state.studyDraft = value;
    assert.throws(() => parseBackup(state), /学习草稿/);
  }
});

test('assisted markers reject truthy strings and numbers in drafts and historical sessions', () => {
  for (const value of ['true', 1, null, [], {}]) {
    const draftState = oldState(); draftState.draft.assisted = value;
    assert.throws(() => parseBackup(draftState), /辅助/);
    const historyState = oldState(); historyState.history[0].assisted = value;
    assert.throws(() => parseBackup(historyState), /辅助/);
  }
});

test('only active next and complete mark seen; previous browsing is immutable and does not pass a word', () => {
  const initial = study(); initial.hidden = true;
  const initialCopy = structuredClone(initial), next = advanceStudyDraft(initial);
  assert.deepEqual(initial, initialCopy);
  assert.deepEqual(next.seen, [true, false, false]);
  assert.equal(next.activeIndex, 1);
  assert.equal(next.hidden, false);
  next.hidden = true;
  const previous = advanceStudyDraft(next, 'prev');
  assert.equal(previous.activeIndex, 0);
  assert.deepEqual(previous.seen, [true, false, false]);
  assert.equal(previous.hidden, false);
  assert.equal(next.activeIndex, 1);
  assert.equal(next.hidden, true);
  assert.deepEqual(advanceStudyDraft(study(), 'prev').seen, [false, false, false]);
});

test('jumping to the final word cannot complete a round with skipped words', () => {
  for (const action of ['next', 'complete']) {
    const jumped = study(); jumped.activeIndex = 2;
    const attempted = advanceStudyDraft(jumped, action);
    assert.deepEqual(attempted.seen, [false, false, true]);
    assert.equal(attempted.completed, false);
    assert.equal(attempted.activeIndex, 0);
    const firstPassed = advanceStudyDraft(attempted);
    const completed = advanceStudyDraft(firstPassed, 'complete');
    assert.deepEqual(completed.seen, [true, true, true]);
    assert.equal(completed.completed, true);
    assert.deepEqual(advanceStudyDraft(completed), completed, 'finishing must not create another round');
  }
  const singleton = createStudyDraft([word], '单词学习', section.id, 'normal', now);
  assert.equal(advanceStudyDraft(singleton).completed, true);
});

test('restart requires a complete round and resets copying and visit state while retaining uncertainty', () => {
  assert.throws(() => advanceStudyDraft(study(), 'restart'), /先完成/);
  let completed = study();
  for (let index = 0; index < words.length; index++) completed = advanceStudyDraft(completed);
  completed.answers = words.map(word => word.text);
  completed.uncertain = [false, true, false];
  completed.hidden = true;
  completed.elapsed = 38.5;
  const restarted = advanceStudyDraft(completed, 'restart');
  assert.equal(restarted.round, 2);
  assert.equal(restarted.completed, false);
  assert.equal(restarted.activeIndex, 0);
  assert.equal(restarted.hidden, false);
  assert.equal(restarted.elapsed, 38.5);
  assert.equal(restarted.startedAt, completed.startedAt);
  assert.deepEqual(restarted.seen, [false, false, false]);
  assert.deepEqual(restarted.answers, ['', '', '']);
  assert.deepEqual(restarted.uncertain, [false, true, false]);
  assert.equal(completed.completed, true);
  assert.deepEqual(completed.answers, words.map(word => word.text));
  assert.throws(() => advanceStudyDraft({ ...completed, round: 1000000 }, 'restart'), /轮次/);
  assert.throws(() => advanceStudyDraft(completed, 'skip'), /操作/);
});

test('independent accuracy excludes assisted sessions while practice totals and streak include them', () => {
  const history = [session([], { total: 4, correct: 1 }),
    session([], { total: 6, correct: 4, assisted: false }),
    session([], { total: 90, correct: 90, assisted: true })];
  assert.deepEqual(computeIndependentStats(history), {
    totalWords: 10, totalCorrect: 5, sessionCount: 2, accuracy: 50,
  });
  assert.deepEqual(computeStats(history, now), {
    todayCount: 100, totalWords: 100, totalSessions: 3, accuracy: 50, streak: 1,
  });
  assert.deepEqual(computeIndependentStats(history.slice(2)), {
    totalWords: 0, totalCorrect: 0, sessionCount: 0, accuracy: null,
  });
  assert.equal(computeStats(history.slice(2), now).accuracy, 0);
  assert.equal(computeIndependentStats([]).accuracy, null);
});

test('studying and restarting never changes history, reviews, dictation totals or section progress', () => {
  const state = oldState();
  const history = structuredClone(state.history), reviews = structuredClone(state.reviews);
  const stats = computeStats(history, now), progress = getSectionProgress(history, section);
  state.studyDraft = study();
  for (let index = 0; index < words.length; index++) state.studyDraft = advanceStudyDraft(state.studyDraft);
  state.studyDraft = advanceStudyDraft(state.studyDraft, 'restart');
  const restored = parseBackup(JSON.stringify(state));
  assert.deepEqual(restored.history, history);
  assert.deepEqual(restored.reviews, reviews);
  assert.deepEqual(computeStats(restored.history, now), stats);
  assert.deepEqual(getSectionProgress(restored.history, section), progress);
  assert.equal(restored.studyDraft.round, 2);
  assert.deepEqual(restored.draft, state.draft, 'study and dictation may coexist independently');
});
