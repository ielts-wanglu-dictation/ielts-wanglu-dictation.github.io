import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { sections } from '../data.js';
import { activateStudyDraft, archiveStudyDraft, computeStats, createInitialState, createStudyDraft,
  findStudyDraft, getSectionProgress, getStudyDrafts, nextStudyBatchForSection,
  nextStudyDayStart, parseBackup, sameStudyWords, studyDateKey } from '../core.js';
import { BACKUP_FORMAT, hashState, validateEnvelope } from '../backup.js';

const now = new Date('2026-10-18T02:00:00.000Z');
const section = sections[0], words = section.words;
function draft(id, start = 0, end = 3, mode = 'normal') {
  return createStudyDraft(words.slice(start, end), id, section.id, mode, now, id);
}
function dictation(selected, mode = 'normal') {
  return { id: randomUUID(), sectionId: section.id, title: '听写', mode,
    wordIds: selected.map(word => word.id), answers: selected.map(() => ''), activeIndex: 0,
    startedAt: now.toISOString(), elapsed: 0 };
}
function history(selected, mode = 'normal') {
  return { id: randomUUID(), sectionId: section.id, title: '听写', mode, date: now.toISOString(),
    duration: 1, total: selected.length, correct: selected.length,
    results: selected.map(word => ({ wordId: word.id, text: word.text, meaning: word.meaning,
      phonetic: word.phonetic, sectionId: word.sectionId, typed: word.text, ok: true })) };
}
async function cloud(state) {
  return validateEnvelope({ format: BACKUP_FORMAT, version: 1, revisionId: randomUUID(), parentRevisionId: null,
    updatedAt: now.toISOString(), studyDay: studyDateKey(now), state, stateHash: await hashState(state) });
}

test('existing initial and single-study backup hashes stay unchanged without new optional fields', async () => {
  for (const active of [false, true]) {
    const state = createInitialState();
    state.draft = dictation(words.slice(0, 2));
    state.history = [history(words.slice(3, 5))];
    if (active) state.studyDraft = draft('old-task');
    const parsed = parseBackup(JSON.stringify(state));
    assert.deepEqual(parsed, state);
    assert.equal(Object.hasOwn(parsed, 'savedStudyDrafts'), false);
    assert.equal(Object.hasOwn(parsed.draft, 'studyId'), false);
    assert.equal(Object.hasOwn(parsed.history[0], 'studyRound'), false);
    if (active) assert.equal(Object.hasOwn(parsed.studyDraft, 'parentStudyId'), false);
    assert.deepEqual((await cloud(state)).state, state);
  }
});

test('matching a study task ignores order but preserves mode, section and duplicate ID counts', () => {
  const active = draft('active'), saved = draft('saved', 5, 8);
  const state = { ...createInitialState(), studyDraft: active, savedStudyDrafts: [saved] };
  assert.deepEqual(getStudyDrafts(state), [active, saved]);
  assert.equal(sameStudyWords(active, [...active.wordIds].reverse(), section.id, 'normal'), true);
  assert.equal(sameStudyWords(active, [...active.words].reverse(), section.id, 'normal'), true);
  assert.equal(sameStudyWords(active, active.words, section.id, 'review'), false);
  assert.equal(sameStudyWords(active, active.words, 'other', 'normal'), false);
  assert.equal(sameStudyWords(active, [active.wordIds[0], active.wordIds[0], active.wordIds[2]], section.id), false);
  const repeated = { ...active, wordIds: ['a', 'a', 'b'] };
  assert.equal(sameStudyWords(repeated, ['b', 'a', 'a'], section.id), true);
  assert.equal(sameStudyWords(repeated, ['a', 'b', 'b'], section.id), false);
  assert.equal(findStudyDraft(state, saved.words, section.id), saved);
  assert.equal(findStudyDraft(state, active.wordIds, section.id), active);
  assert.equal(findStudyDraft(state, [words[10]], section.id), null);
});

test('switching multiple groups repeatedly keeps every saved answer, round and parent context', () => {
  const a = draft('a'), b = draft('b', 3, 6), c = draft('c', 6, 8, 'review');
  a.answers[1] = 'saved answer'; a.seen[0] = true; a.activeIndex = 1; a.uncertain[1] = true;
  b.round = 2;
  c.parentStudyId = b.id;
  let state = activateStudyDraft(createInitialState(), a);
  assert.equal(Object.hasOwn(state, 'savedStudyDrafts'), false);
  const original = structuredClone(state);
  state = activateStudyDraft(state, b);
  assert.deepEqual(original.studyDraft, a);
  assert.deepEqual(getStudyDrafts(state).map(draft => draft.id), ['b', 'a']);
  state = activateStudyDraft(state, c);
  assert.deepEqual(getStudyDrafts(state).map(draft => draft.id), ['c', 'b', 'a']);
  for (const selected of [a, c, b, a]) state = activateStudyDraft(state, findStudyDraft(state, selected.words, section.id, selected.mode));
  assert.deepEqual(getStudyDrafts(state).map(draft => draft.id), ['a', 'b', 'c']);
  assert.deepEqual(state.studyDraft, a);
  assert.deepEqual(state.savedStudyDrafts, [b, c]);
  const before = structuredClone(state);
  assert.deepEqual(activateStudyDraft(state, state.studyDraft), state);
  assert.deepEqual(state, before);
  assert.throws(() => activateStudyDraft(state, { ...b, id: 'a' }), /编号已用于/);
  assert.deepEqual(state, before);
});

test('archiving removes only the active slot and leaves both unfinished and completed work resumable', () => {
  let state = activateStudyDraft(createInitialState(), draft('a'));
  state = activateStudyDraft(state, draft('b', 3, 6));
  state.studyDraft.completed = true; state.studyDraft.seen.fill(true);
  const before = structuredClone(state), archived = archiveStudyDraft(state);
  assert.equal(Object.hasOwn(archived, 'studyDraft'), false);
  assert.deepEqual(archived.savedStudyDrafts.map(draft => draft.id), ['b', 'a']);
  assert.deepEqual(state, before);
  assert.deepEqual(archiveStudyDraft(archived), archived);
  const resumed = activateStudyDraft(archived, archived.savedStudyDrafts[1]);
  assert.equal(resumed.studyDraft.id, 'a');
  assert.equal(resumed.savedStudyDrafts[0].completed, true);
  assert.deepEqual(getStudyDrafts(createInitialState()), []);
});

test('study collections, parent references and paired test links survive exact local and cloud backups', async () => {
  const parent = draft('parent'), child = draft('child', 1, 2, 'review');
  child.parentStudyId = parent.id;
  let state = activateStudyDraft(createInitialState(), parent);
  state = activateStudyDraft(state, child);
  state.draft = { ...dictation(parent.words), studyId: parent.id, studyRound: 2, assisted: true };
  state.history = [{ ...history(child.words, 'review'), studyId: child.id, studyRound: 1, assisted: true }];
  assert.deepEqual(parseBackup(JSON.stringify(state)), state);
  assert.deepEqual((await cloud(state)).state, state);
  const parsed = parseBackup(state);
  parsed.savedStudyDrafts[0].answers[0] = 'changed';
  assert.equal(state.savedStudyDrafts[0].answers[0], '');
  const empty = { ...createInitialState(), savedStudyDrafts: [] };
  assert.deepEqual((await cloud(empty)).state, empty);
});

test('invalid collections, duplicate IDs, bad parent references and incomplete test links are rejected', () => {
  for (const value of [null, {}, false, [null], [draft('same'), draft('same')], new Array(1), Array(10001).fill(draft('too-many'))]) {
    assert.throws(() => parseBackup({ ...createInitialState(), savedStudyDrafts: value }));
  }
  assert.throws(() => parseBackup({ ...createInitialState(), studyDraft: draft('same'), savedStudyDrafts: [draft('same')] }), /编号重复/);
  for (const value of ['', ' ', null, 3, [], 'x'.repeat(501), 'self']) {
    const active = draft('self'); active.parentStudyId = value;
    assert.throws(() => parseBackup({ ...createInitialState(), studyDraft: active }));
  }
  const invalidLinks = [{ studyId: 'parent' }, { studyRound: 1 }, { studyId: '', studyRound: 1 },
    { studyId: null, studyRound: 1 }, { studyId: 'parent', studyRound: 0 },
    { studyId: 'parent', studyRound: 1.5 }, { studyId: 'parent', studyRound: '1' },
    { studyId: 'parent', studyRound: 1000001 }];
  for (const link of invalidLinks) {
    assert.throws(() => parseBackup({ ...createInitialState(), draft: { ...dictation(words.slice(0, 1)), ...link } }));
    assert.throws(() => parseBackup({ ...createInitialState(), history: [{ ...history(words.slice(0, 1)), ...link }] }));
  }
});

test('reaching the saved-task limit rejects a switch without evicting any work', () => {
  const saved = Array.from({ length: 10000 }, (_, index) => ({ ...draft('saved'), id: `saved-${index}` }));
  const state = { ...createInitialState(), studyDraft: draft('active'), savedStudyDrafts: saved };
  assert.throws(() => activateStudyDraft(state, draft('new', 5, 8)), /10000/);
  assert.throws(() => archiveStudyDraft(state), /10000/);
  assert.equal(state.studyDraft.id, 'active');
  assert.equal(state.savedStudyDrafts.length, 10000);
  const switched = activateStudyDraft(state, saved[0]);
  assert.equal(switched.savedStudyDrafts.length, 10000);
  assert.equal(switched.studyDraft.id, 'saved-0');
});

test('new study batches fill the first gap and reserve all active, saved and submitted normal work', () => {
  const state = { ...createInitialState(), studyDraft: draft('active', 0, 20),
    savedStudyDrafts: [draft('saved', 40, 60)], history: [history(words.slice(80, 100), 'shuffle')],
    draft: dictation(words.slice(20, 25), 'normal') };
  state.savedStudyDrafts[0].completed = true; state.savedStudyDrafts[0].seen.fill(true);
  const before = structuredClone(state), batch = nextStudyBatchForSection(state, section, 50);
  assert.deepEqual(batch, { startIndex: 25, endIndex: 40, size: 15, words: words.slice(25, 40) });
  assert.deepEqual(state, before);
  const next = activateStudyDraft(state, createStudyDraft(batch.words, 'gap', section.id, 'normal', now, 'gap'));
  assert.equal(nextStudyBatchForSection(next, section, 50).startIndex, 60);
  assert.equal(nextStudyBatchForSection(next, section, 50).endIndex, 80);
  assert.equal(nextStudyBatchForSection(next, section, 5).endIndex, 65);
});

test('review tasks and review submissions never reserve normal learning ranges', () => {
  const state = { ...createInitialState(), studyDraft: draft('review', 0, 20, 'review'),
    savedStudyDrafts: [draft('saved-review', 20, 40, 'review')],
    draft: dictation(words.slice(40, 60), 'review'), history: [history(words.slice(60, 80), 'review')] };
  assert.deepEqual(nextStudyBatchForSection(state, section, 80), {
    startIndex: 0, endIndex: 80, size: 80, words: words.slice(0, 80),
  });
  state.draft.mode = 'shuffle';
  assert.equal(nextStudyBatchForSection(state, section, 80).endIndex, 40);
  const legacy = { ...createInitialState(), history: [{ ...history([words[30]]), total: 100, correct: 100 }] };
  assert.equal(nextStudyBatchForSection(legacy, section).endIndex, 30, 'legacy totals cannot invent IDs');
});

test('studying reserves new groups without inflating listening scores or submitted section coverage', () => {
  const state = activateStudyDraft(createInitialState(), draft('whole', 0, words.length));
  assert.equal(nextStudyBatchForSection(state, section), null);
  assert.equal(nextStudyBatchForSection(state, { id: 'empty', words: [] }), null);
  assert.equal(nextStudyBatchForSection(createInitialState(), sections[1], 20).startIndex, 0);
  assert.equal(getSectionProgress(state.history, section).completedCount, 0);
  assert.deepEqual(computeStats(state.history, now), { todayCount: 0, totalWords: 0, totalSessions: 0, accuracy: 0, streak: 0 });
  assert.throws(() => nextStudyBatchForSection(state, section, 0));
  assert.throws(() => nextStudyBatchForSection(state, section, 1.5));
});

test('the next study-day boundary is the next Beijing 06:00, including exact rollover', () => {
  const cases = [
    ['2026-10-18T05:00:00+08:00', '2026-10-17T22:00:00.000Z'],
    ['2026-10-18T05:59:59.999+08:00', '2026-10-17T22:00:00.000Z'],
    ['2026-10-18T06:00:00+08:00', '2026-10-18T22:00:00.000Z'],
    ['2026-10-18T07:00:00+08:00', '2026-10-18T22:00:00.000Z'],
    ['2026-10-18T00:00:00+08:00', '2026-10-17T22:00:00.000Z'],
    ['2026-12-31T23:59:59+08:00', '2026-12-31T22:00:00.000Z'],
  ];
  for (const [input, expected] of cases) {
    const original = new Date(input), before = original.toISOString(), next = nextStudyDayStart(original);
    assert.equal(next instanceof Date, true);
    assert.equal(next.toISOString(), expected);
    assert.equal(original.toISOString(), before);
    assert.ok(next > original);
  }
  assert.throws(() => nextStudyDayStart('invalid'), /日期/);
});

test('next Beijing study day is unaffected by device timezone or local daylight-saving changes', () => {
  const moduleURL = new URL('../core.js', import.meta.url).href;
  const source = `import { nextStudyDayStart } from ${JSON.stringify(moduleURL)};
    process.stdout.write(JSON.stringify(['2026-03-08T09:30:00Z','2026-11-01T08:30:00Z'].map(x=>nextStudyDayStart(x).toISOString())));`;
  for (const TZ of ['UTC', 'America/Los_Angeles', 'Asia/Shanghai', 'Europe/Berlin']) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { env: { ...process.env, TZ }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), ['2026-03-08T22:00:00.000Z', '2026-11-01T22:00:00.000Z']);
  }
});
