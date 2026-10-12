/** Browser speech and dictionary audio. No microphone or recording permission is used. */
const SINGLE_WORD = /^[a-z]+(?:['’-][a-z]+)*$/i;
const sleepTime = 350;

export function normalizeSpeechText(value, weakArticle = false) {
  let text = String(value ?? '').trim();
  const fixes = { OHPEN: 'open', 'give sb. A sack': 'give sb. a sack', '综合测试': 'test' };
  text = fixes[text] || text;
  text = text.split(/[=＝]/)[0];
  // Parenthetical notes and spelling alternatives are annotations, not the prompt.
  for (let i = 0; i < 5; i++) text = text.replace(/\([^()]*\)|（[^（）]*）|\[[^\[\]]*\]/g, ' ');
  text = text
    .replace(/\bsth\b\.?/gi, 'something')
    .replace(/\bsb\b\.?/gi, 'somebody')
    .replace(/,(\S)/g, ', $1')
    .replace(/\.(?!\d)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Retain uppercase A (e.g. A plus), but avoid spelling out the indefinite article.
  return weakArticle ? text.replace(/\ba\b/g, 'uh') : text;
}

function clamp(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function online() {
  return globalThis.navigator?.onLine !== false;
}

function voiceScore(voice, settings) {
  const lang = String(voice.lang || '').toLowerCase().replaceAll('_', '-');
  return (voice.voiceURI === settings.voiceURI ? 1000 : 0)
    + (lang.startsWith(settings.accent.toLowerCase()) ? 150 : 0)
    + (voice.localService !== false ? 70 : 0)
    + (voice.default ? 5 : 0);
}

/**
 * onStatus(message, details): details.state is loading / playing / idle / error.
 * speak(text, {rate, repeat, accent, mode, voiceURI}) resolves true only on completion.
 * stop() and a replacement speak() immediately cancel pending speech, fetches and timers.
 */
export class SpeechPlayer {
  constructor(onStatus = () => {}) {
    this.onStatus = onStatus;
    this._active = null;
    this._sequence = 0;
    this._dictionary = new Map();
    this._dictionaryFailures = new Map();
    this._voiceFailures = new Map();
  }

  listVoices() {
    try {
      return (globalThis.speechSynthesis?.getVoices() || [])
        .filter(voice => /^en(?:[-_]|$)/i.test(voice.lang || ''));
    } catch {
      return [];
    }
  }

  stop() {
    const context = this._active;
    this._active = null;
    this._sequence++;
    if (context) {
      context.cancelled = true;
      for (const cancel of [...context.cancellations]) cancel();
      context.cancellations.clear();
      try { globalThis.speechSynthesis?.cancel(); } catch { /* Unsupported speech engine. */ }
      this._status(null, '已停止播放', { state: 'idle', code: 'cancelled' });
    }
  }

  async speak(value, options = {}) {
    this.stop();
    const context = { id: ++this._sequence, cancelled: false, cancellations: new Set() };
    this._active = context;
    const text = normalizeSpeechText(value);
    const settings = {
      rate: clamp(options.rate, 0.5, 1.5, 1),
      repeat: Math.round(clamp(options.repeat, 1, 3, 1)),
      accent: options.accent === 'en-US' ? 'en-US' : 'en-GB',
      mode: options.mode === 'dictionary' ? 'dictionary' : 'speech',
      voiceURI: options.voiceURI || '',
    };
    try {
      if (!text) {
        this._status(context, '这个词条没有可朗读的内容', { state: 'error', code: 'empty' });
        return false;
      }
      for (let count = 0; count < settings.repeat; count++) {
        if (!this._current(context)) return false;
        const result = await this._playOnce(text, settings, context);
        if (!this._current(context)) return false;
        if (result !== 'ended') {
          const message = result === 'blocked'
            ? '浏览器阻止了发音，请点击播放按钮重试'
            : !online()
              ? '当前离线，未找到可用的本地英语语音；请安装英语语音或联网重试'
              : result === 'timeout'
                ? '发音连接超时，请检查网络后重试'
                : '发音暂不可用，请检查英语语音、音量或网络后重试';
          this._status(context, message, { state: 'error', code: result });
          return false;
        }
        if (count < settings.repeat - 1 && !await this._delay(sleepTime, context)) return false;
      }
      this._status(context, '播放完成', { state: 'idle', code: 'ended' });
      return true;
    } catch {
      if (this._current(context)) this._status(context, '发音暂不可用，请点击播放按钮重试', { state: 'error', code: 'error' });
      return false;
    } finally {
      if (this._active === context) this._active = null;
    }
  }

  _current(context) {
    return this._active === context && !context.cancelled;
  }

  _status(context, message, details) {
    if (context && !this._current(context)) return;
    try { this.onStatus(message, details); } catch { /* Presentation must not interrupt playback. */ }
  }

  _delay(milliseconds, context) {
    return new Promise(resolve => {
      if (!this._current(context)) { resolve(false); return; }
      const finish = value => {
        clearTimeout(timer);
        context.cancellations.delete(cancel);
        resolve(value);
      };
      const cancel = () => finish(false);
      const timer = setTimeout(() => finish(this._current(context)), milliseconds);
      context.cancellations.add(cancel);
    });
  }

  async _playOnce(text, settings, context) {
    if (settings.mode === 'dictionary' && SINGLE_WORD.test(text) && online()) {
      const url = await this._dictionaryUrl(text, settings.accent, context);
      if (!this._current(context)) return 'cancelled';
      if (url) {
        const result = await this._audio(url, '词典发音', settings.rate, context);
        if (['ended', 'blocked', 'cancelled'].includes(result)) return result;
        this._dictionary.delete(`${settings.accent}:${text.toLowerCase()}`);
      }
      this._status(context, '词典发音不可用，正在切换合成语音', { state: 'loading' });
    } else if (settings.mode === 'dictionary' && !SINGLE_WORD.test(text)) {
      this._status(context, '短语使用合成语音', { state: 'loading' });
    }
    const nativeResult = await this._browserSpeech(text, settings, context);
    if (['ended', 'blocked', 'cancelled'].includes(nativeResult)) return nativeResult;
    if (!online()) return 'offline';
    if (!this._current(context)) return 'cancelled';
    this._status(context, '正在切换在线发音', { state: 'loading' });
    return this._remoteSpeech(text, settings, context);
  }

  async _browserSpeech(text, settings, context) {
    const synth = globalThis.speechSynthesis;
    const Utterance = globalThis.SpeechSynthesisUtterance;
    if (!synth || !Utterance) return 'unavailable';
    // Some engines populate getVoices after page load. Polling is bounded and cancellable.
    let voices = this.listVoices();
    for (let attempt = 0; !voices.length && attempt < 5; attempt++) {
      if (!await this._delay(120, context)) return 'cancelled';
      voices = this.listVoices();
    }
    const candidates = voices
      .filter(voice => online() || voice.localService !== false)
      .filter(voice => Date.now() - (this._voiceFailures.get(voice.voiceURI || voice.name) || 0) > 60000)
      .sort((left, right) => voiceScore(right, settings) - voiceScore(left, settings))
      .slice(0, 3);
    // A default utterance is useful on Safari even when getVoices() remains empty.
    if (!voices.length) candidates.push(null);
    let result = 'unavailable';
    for (const voice of candidates) {
      if (!this._current(context)) return 'cancelled';
      result = await this._utterance(normalizeSpeechText(text, true), voice, settings, context);
      if (['ended', 'blocked', 'cancelled'].includes(result)) return result;
      if (voice) this._voiceFailures.set(voice.voiceURI || voice.name, Date.now());
    }
    return result;
  }

  _utterance(text, voice, settings, context) {
    return new Promise(resolve => {
      if (!this._current(context)) { resolve('cancelled'); return; }
      const synth = globalThis.speechSynthesis;
      const utterance = new globalThis.SpeechSynthesisUtterance(text);
      let settled = false;
      let timer;
      const finish = result => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        utterance.onstart = utterance.onend = utterance.onerror = null;
        context.cancellations.delete(cancel);
        if (result !== 'ended') { try { synth.cancel(); } catch { /* Engine failure. */ } }
        resolve(result);
      };
      const cancel = () => finish('cancelled');
      context.cancellations.add(cancel);
      utterance.voice = voice;
      utterance.lang = voice?.lang || settings.accent;
      utterance.rate = settings.rate;
      utterance.onstart = () => {
        if (settled) return;
        if (!this._current(context)) { finish('cancelled'); return; }
        clearTimeout(timer);
        timer = setTimeout(() => finish('timeout'), clamp(text.length * 260 / settings.rate + 8000, 12000, 60000, 30000));
        const source = voice?.localService === false ? '浏览器在线语音' : voice ? '本地英语语音' : '浏览器英语语音';
        this._status(context, `正在播放 · ${source}`, { state: 'playing', source });
      };
      utterance.onend = () => finish('ended');
      utterance.onerror = event => finish(event.error === 'not-allowed' ? 'blocked' : 'error');
      timer = setTimeout(() => finish('timeout'), 3000);
      try {
        if (synth.paused) synth.resume();
        synth.speak(utterance);
      } catch { finish('error'); }
    });
  }

  async _dictionaryUrl(text, accent, context) {
    const key = `${accent}:${text.toLowerCase()}`;
    if (this._dictionary.has(key)) return this._dictionary.get(key);
    if (Date.now() - (this._dictionaryFailures.get(key) || 0) < 60000) return null;
    if (typeof globalThis.fetch !== 'function') return null;
    this._status(context, '正在获取词典发音…', { state: 'loading', source: 'dictionary' });
    if (!this._current(context)) return null;
    // Explicit race ensures stop() settles even if a browser ignores fetch abort.
    const data = await new Promise(resolve => {
      const controller = new AbortController();
      let settled = false;
      const finish = data => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        context.cancellations.delete(cancel);
        controller.abort();
        resolve(data);
      };
      const cancel = () => finish(null);
      const timer = setTimeout(cancel, 4500);
      context.cancellations.add(cancel);
      fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(text.toLowerCase())}`, { signal: controller.signal })
        .then(response => response.ok ? response.json() : null)
        .then(finish, () => finish(null));
    });
    if (!this._current(context)) return null;
    const urls = Array.isArray(data)
      ? data.flatMap(entry => Array.isArray(entry.phonetics) ? entry.phonetics : [])
        .map(phonetic => phonetic.audio).filter(url => typeof url === 'string' && /^https:\/\//i.test(url))
      : [];
    const preferred = accent === 'en-US' ? /(?:-|_|\/)us(?:[./_-]|$)/i : /(?:-|_|\/)(?:uk|gb)(?:[./_-]|$)/i;
    const url = urls.find(candidate => preferred.test(candidate)) || urls[0] || null;
    if (url) this._dictionary.set(key, url);
    else this._dictionaryFailures.set(key, Date.now());
    return url;
  }

  async _remoteSpeech(text, settings, context) {
    const type = settings.accent === 'en-US' ? 2 : 1;
    const label = settings.accent === 'en-US' ? '有道美音' : '有道英音';
    const youdao = word => `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(word)}&type=${type}`;
    let result = await this._audio(youdao(text), label, settings.rate, context);
    if (['ended', 'blocked', 'cancelled'].includes(result)) return result;
    if (!this._current(context)) return 'cancelled';
    this._status(context, '正在尝试其他在线语音…', { state: 'loading' });
    const google = `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${settings.accent.toLowerCase()}&q=${encodeURIComponent(text)}`;
    result = await this._audio(google, 'Google 在线语音', settings.rate, context);
    if (['ended', 'blocked', 'cancelled'].includes(result)) return result;
    const tokens = text.match(/[a-z]+(?:['’-][a-z]+)*/gi) || [];
    if (tokens.length > 1 && tokens.length <= 16) {
      this._status(context, '整句音频不可用，正在逐词播放', { state: 'loading' });
      for (const token of tokens) {
        result = await this._audio(youdao(token), `${label}（逐词）`, settings.rate, context);
        if (result !== 'ended') return result;
      }
      return 'ended';
    }
    return result;
  }

  _audio(url, label, rate, context) {
    return new Promise(resolve => {
      if (!this._current(context)) { resolve('cancelled'); return; }
      if (!online()) { resolve('offline'); return; }
      if (typeof globalThis.Audio !== 'function') { resolve('unavailable'); return; }
      const audio = new globalThis.Audio();
      let settled = false;
      let timer;
      const finish = result => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        audio.onplaying = audio.onended = audio.onerror = null;
        context.cancellations.delete(cancel);
        try { audio.pause(); audio.removeAttribute('src'); audio.load(); } catch { /* Already disposed. */ }
        resolve(result);
      };
      const cancel = () => finish('cancelled');
      context.cancellations.add(cancel);
      audio.preload = 'auto';
      audio.playbackRate = rate;
      audio.onplaying = () => {
        if (settled) return;
        if (!this._current(context)) { finish('cancelled'); return; }
        clearTimeout(timer);
        const expected = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration / rate * 1000 + 5000 : 30000;
        timer = setTimeout(() => finish('timeout'), clamp(expected, 12000, 60000, 30000));
        this._status(context, `正在播放 · ${label}`, { state: 'playing', source: label });
      };
      audio.onended = () => finish('ended');
      audio.onerror = () => finish('error');
      this._status(context, `正在连接${label}…`, { state: 'loading', source: label });
      if (settled) return;
      timer = setTimeout(() => finish('timeout'), 6500);
      try {
        audio.src = url;
        const pending = audio.play();
        if (pending?.catch) pending.catch(error => finish(error.name === 'NotAllowedError' ? 'blocked' : 'error'));
      } catch { finish('error'); }
    });
  }
}
