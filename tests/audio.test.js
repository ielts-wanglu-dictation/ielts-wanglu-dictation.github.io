import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { SpeechPlayer, normalizeSpeechText } from '../audio.js';

const names = ['speechSynthesis', 'SpeechSynthesisUtterance', 'Audio', 'navigator', 'fetch'];
let descriptors;
const players = [];

beforeEach(() => {
  descriptors = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  setGlobal('navigator', { onLine: true });
});
afterEach(() => {
  for (const player of players.splice(0)) player.stop();
  for (const [name, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
});

function setGlobal(name, value) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
function player(statuses = []) {
  const result = new SpeechPlayer((message, details) => statuses.push({ message, ...details }));
  players.push(result);
  return result;
}
function speech({ automatic = true, error = null } = {}) {
  const calls = [];
  let cancelled = 0;
  const voices = [
    { voiceURI: 'zh', lang: 'zh-CN', localService: true },
    { voiceURI: 'uk', name: 'UK local', lang: 'en-GB', localService: true },
    { voiceURI: 'us', name: 'US local', lang: 'en-US', localService: true },
  ];
  setGlobal('SpeechSynthesisUtterance', class { constructor(text) { this.text = text; } });
  setGlobal('speechSynthesis', {
    getVoices: () => voices,
    cancel: () => { cancelled++; },
    speak(utterance) {
      calls.push(utterance);
      if (automatic) queueMicrotask(() => {
        if (error) utterance.onerror?.({ error });
        else { utterance.onstart?.(); utterance.onend?.(); }
      });
    },
  });
  return { calls, get cancelled() { return cancelled; } };
}
function audio({ blocked = false } = {}) {
  const calls = [];
  setGlobal('Audio', class {
    constructor() { this.duration = 1; calls.push(this); }
    play() {
      if (blocked) return Promise.reject(Object.assign(new Error('Blocked'), { name: 'NotAllowedError' }));
      queueMicrotask(() => { this.onplaying?.(); this.onended?.(); });
      return Promise.resolve();
    }
    pause() { this.paused = true; }
    removeAttribute() {}
    load() {}
  });
  return calls;
}

test('normalization handles annotations, aliases, shorthand and uppercase A', () => {
  assert.equal(normalizeSpeechText('RA(research assistant)'), 'RA');
  assert.equal(normalizeSpeechText('archaeologist=archeologist'), 'archaeologist');
  assert.equal(normalizeSpeechText("give sb. sth."), 'give somebody something');
  assert.equal(normalizeSpeechText("sb.'s address"), "somebody's address");
  assert.equal(normalizeSpeechText('a great variety of', true), 'uh great variety of');
  assert.equal(normalizeSpeechText('A plus', true), 'A plus');
  assert.equal(normalizeSpeechText('OHPEN'), 'open');
  assert.equal(normalizeSpeechText('give sb. A sack'), 'give somebody a sack');
});

test('speech honours accent, rate and repeat while listing only English voices', async () => {
  const engine = speech();
  const p = player();
  assert.deepEqual(p.listVoices().map(voice => voice.voiceURI), ['uk', 'us']);
  assert.equal(await p.speak('a good example', { accent: 'en-US', rate: 0.8, repeat: 2 }), true);
  assert.equal(engine.calls.length, 2);
  assert.equal(engine.calls[0].voice.voiceURI, 'us');
  assert.equal(engine.calls[0].rate, 0.8);
  assert.equal(engine.calls[0].text, 'uh good example');
});

test('a new word cancels prior playback and ignores stale engine callbacks', async () => {
  const engine = speech({ automatic: false });
  const statuses = [];
  const p = player(statuses);
  const first = p.speak('first');
  const staleEnd = engine.calls[0].onend;
  const staleStart = engine.calls[0].onstart;
  const second = p.speak('second');
  assert.equal(await first, false);
  const statusCount = statuses.length;
  staleStart();
  staleEnd();
  assert.equal(statuses.length, statusCount);
  assert.ok(engine.cancelled >= 1);
  engine.calls[1].onstart();
  engine.calls[1].onend();
  assert.equal(await second, true);
  assert.equal(statuses.at(-1).code, 'ended');
});

test('stop resolves a pending dictionary fetch even when fetch ignores abort', async () => {
  let signal;
  setGlobal('fetch', (_url, options) => {
    signal = options.signal;
    return new Promise(() => {});
  });
  const p = player();
  const pending = p.speak('dictionary', { mode: 'dictionary' });
  p.stop();
  assert.equal(await pending, false);
  assert.equal(signal.aborted, true);
});

test('without browser speech, online fallback uses the requested accent', async () => {
  setGlobal('speechSynthesis', undefined);
  const calls = audio();
  assert.equal(await player().speak('hello', { accent: 'en-US', rate: 0.9 }), true);
  assert.match(calls[0].src, /dictvoice\?audio=hello&type=2$/);
  assert.equal(calls[0].playbackRate, 0.9);
});

test('autoplay rejection is reported rather than silently skipping through providers', async () => {
  setGlobal('speechSynthesis', undefined);
  const calls = audio({ blocked: true });
  const statuses = [];
  assert.equal(await player(statuses).speak('hello'), false);
  assert.equal(calls.length, 1);
  assert.equal(statuses.at(-1).state, 'error');
  assert.equal(statuses.at(-1).code, 'blocked');
});

test('offline playback failure makes no network attempt and reports the limitation', async () => {
  speech({ error: 'synthesis-failed' });
  setGlobal('navigator', { onLine: false });
  const calls = audio();
  const statuses = [];
  assert.equal(await player(statuses).speak('hello'), false);
  assert.equal(calls.length, 0);
  assert.equal(statuses.at(-1).code, 'offline');
});

test('dictionary mode chooses UK phonetics and caches the URL for repeat requests', async () => {
  let fetched = 0;
  setGlobal('fetch', async () => {
    fetched++;
    return { ok: true, json: async () => [{ phonetics: [
      { audio: 'https://example.test/word-us.mp3' },
      { audio: 'https://example.test/word-uk.mp3' },
    ] }] };
  });
  const calls = audio();
  const p = player();
  assert.equal(await p.speak('word', { mode: 'dictionary', accent: 'en-GB' }), true);
  assert.equal(await p.speak('word', { mode: 'dictionary', accent: 'en-GB' }), true);
  assert.equal(fetched, 1);
  assert.equal(calls[0].src, 'https://example.test/word-uk.mp3');
});

test('rapid next-word requests settle all replaced speech and keep only the last playback active', async () => {
  const engine = speech({ automatic: false });
  const statuses = [];
  const p = player(statuses);
  const old = [], stale = [];
  for (let index = 0; index < 8; index++) {
    old.push(p.speak(`word ${index}`));
    stale.push({ start: engine.calls.at(-1).onstart, end: engine.calls.at(-1).onend });
  }
  const latest = p.speak('last word');
  assert.deepEqual(await Promise.all(old), Array(8).fill(false));
  const before = statuses.length;
  for (const callbacks of stale) { callbacks.start(); callbacks.end(); }
  assert.equal(statuses.length, before);
  engine.calls.at(-1).onstart();
  engine.calls.at(-1).onend();
  assert.equal(await latest, true);
  assert.equal(statuses.filter(status => status.code === 'ended').length, 1);
});

test('moving to the next word during a repeat gap prevents old-word repeats', async () => {
  const engine = speech();
  const p = player();
  const old = p.speak('previous', { repeat: 3 });
  // Let the first utterance finish and enter its cancellable repetition delay.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(engine.calls.length, 1);
  const latest = p.speak('next');
  assert.equal(await old, false);
  assert.equal(await latest, true);
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.deepEqual(engine.calls.map(call => call.text), ['previous', 'next']);
});
