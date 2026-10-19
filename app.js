import { chapters, sections, allWords, wordById } from "./data.js";
import {
  gradeAnswer,
  localDateKey,
  studyDateKey,
  updateReview,
  computeStats,
  createInitialState,
  parseBackup,
  getSectionProgress,
  nextSectionBatch,
  createStudyDraft,
  advanceStudyDraft,
  computeIndependentStats,
} from "./core.js";
import { SpeechPlayer } from "./audio.js";
import { BackupClient } from "./backup.js";
import { BACKUP_SERVICE_URL } from "./backup-config.js";

const KEY = "wanglu-personal-v1";
let backupClient = null;
let backupStatus = { configured: Boolean(BACKUP_SERVICE_URL), connected: false, status: "disconnected", message: "本地保存 · 尚未连接 GitHub" };
let visibleStudyDay = studyDateKey();
const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const icons = {
  home: "M3 10 12 3l9 7M5 9v12h5v-7h4v7h5V9",
  book: "M4 3h7a3 3 0 0 1 3 3v15a4 4 0 0 0-4-2H4V3zm10 3a3 3 0 0 1 3-3h4v16h-4a3 3 0 0 0-3 2",
  review: "M8 3H5v18h14V3h-3M8 2h8v4H8zM8 11h8M8 15h5",
  chart: "M4 3v18h17M8 16l4-5 4 2 5-7",
  settings:
    "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z",
  play: "m8 4 12 8-12 8V4z",
  sound: "M3 9h4l5-4v14l-5-4H3V9zm13-1a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14",
  arrow: "M4 12h16m-6-6 6 6-6 6",
  target: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18m0 5a4 4 0 1 0 0 8 4 4 0 0 0 0-8",
  flame: "M12 2c2 6 7 7 7 13a7 7 0 0 1-14 0c0-4 3-6 4-8 0 4 3 5 3-5z",
  check: "m5 12 4 4L20 5",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18m0 5v5l4 2",
  download: "M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5",
  upload: "M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5",
  shuffle: "M3 6h3l12 12h3m-4-4 4 4-4 4M3 18h3l4-4m4-4 4-4h3m-4-4 4 4-4 4",
  pause: "M8 4v16M16 4v16",
  close: "m6 6 12 12M6 18 18 6",
  back: "M20 12H4m6-6-6 6 6 6",
  search: "M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14m5 12 6 6",
  sun: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1",
  save: "M5 3h12l4 4v14H3V3h2m2 0v6h10V3M7 21v-8h10v8",
  info: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18m0 7v6m0-9v.1",
};
const icon = (n) =>
  `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${icons[n] || icons.book}"/></svg>`;
const button = (label, action, cls = "", attrs = "") =>
  `<button class="button ${cls}" data-action="${action}" ${attrs}>${label}</button>`;
const modeLabel = (m) =>
  ({ normal: "顺序听写", shuffle: "乱序测试", review: "专项复习" })[m] ||
  "听写";
const dateText = (d) =>
  new Date(d).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
let state = createInitialState(),
  storageBlocked = false,
  storageMessage = "";
try {
  const raw = localStorage.getItem(KEY);
  if (raw) state = parseBackup(raw, allWords);
} catch (e) {
  storageBlocked = true;
  storageMessage =
    "本地数据暂时无法读取。请在「设置与备份」导出原始数据后检查，当前不会覆盖已有数据。";
}
let page = "home",
  chapterFilter = "3",
  reviewFilter = "all",
  reviewSort = "count",
  reviewSearch = "",
  reviewChapter = "",
  historySection = "",
  currentSection = null,
  session = null,
  lastResult = null,
  resultFilter = "wrong",
  alignment = [],
  blockToken = 0,
  rowPlayToken = 0,
  blockPlaying = false,
  studyPlaying = false,
  activeIndex = 0,
  suppressFocusAudio = false,
  startedSegment = 0,
  toastTimer;
const speech = new SpeechPlayer((message, detail) => {
  const els = document.querySelectorAll(
    "#audio-status, #dialog[open] .audio-settings-status, #main .audio-settings-status",
  );
  if (els.length) {
    els.forEach((el) => {
      el.textContent = message;
      el.dataset.state = detail?.state || "";
    });
  } else if (detail?.state === "error") toast(message);
});
function persist({ skipBackup = false } = {}) {
  if (storageBlocked) return false;
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
    if (!skipBackup) backupClient?.notifyChanged();
    return true;
  } catch (e) {
    toast("浏览器未能保存数据，请立即导出备份。可能是存储已满或隐私模式限制。");
    return false;
  }
}
function toast(message) {
  $("#toast").textContent = message;
  $("#toast").classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("#toast").classList.remove("show"), 5000);
}
function stop() {
  blockToken++;
  rowPlayToken++;
  blockPlaying = false;
  studyPlaying = false;
  speech.stop();
  document
    .querySelectorAll(".dict-row.playing")
    .forEach((e) => e.classList.remove("playing"));
  const b = $('[data-action="block"]');
  if (b) b.innerHTML = icon("play") + " 连播";
  const studyButton = $('[data-action="study-block"]');
  if (studyButton) studyButton.innerHTML = icon("play") + " 连续听读";
}
function elapsed() {
  return (
    (session?.elapsed || 0) +
    (startedSegment ? Math.max(0, (Date.now() - startedSegment) / 1000) : 0)
  );
}
function saveDraft() {
  if (!session) return;
  state.draft = { ...session, elapsed: Math.round(elapsed()), activeIndex };
  persist();
}
function suspend() {
  if (session) {
    saveDraft();
    session = null;
    startedSegment = 0;
  }
  stop();
}
function navigate(next) {
  suspend();
  page = next;
  render();
  window.scrollTo(0, 0);
}
function wordsForDraft(d) {
  if (!d || !Array.isArray(d.wordIds) || !Array.isArray(d.answers)) return [];
  return d.wordIds
    .map((id, i) => wordById.get(id) || d.words?.[i])
    .filter((w) => w && typeof w.text === "string");
}
function reviewWords(filter = reviewFilter) {
  const now = Date.now();
  return Object.values(state.reviews)
    .filter(r => r.wrongCount > 0 || r.uncertain || r.uncertainCount > 0)
    .filter(r => filter === "all"
      || (filter === "wrong" && r.wrongCount > 0)
      || (filter === "uncertain" && r.uncertain)
      || (filter === "due" && new Date(r.due).getTime() <= now)
      || (filter === "active" && r.streak < 3)
      || (filter === "mastered" && r.streak >= 3 && !r.uncertain))
    .map(r => ({ ...r, id: r.wordId, ...wordById.get(r.wordId) }));
}
function dueCount() {
  return reviewWords("due").length;
}
function sectionHistory(id) {
  return state.history.filter((h) => h.sectionId === id);
}
function shell(content) {
  const navs = [
    ["home", "home", "学习概览"],
    ["library", "book", "语料练习"],
    ["review", "review", "错词与模糊"],
    ["history", "chart", "学习记录"],
    ["settings", "settings", "设置与备份"],
  ];
  const active =
    page === "section" || page === "practice" || page === "result" || page === "study"
      ? "library"
      : page;
  return `<aside class="sidebar"><a class="brand" href="#home" data-nav="home"><img src="./icon.svg" alt=""><div><strong>听见进步</strong><small>MY DICTATION SPACE</small></div></a><div class="nav-label">我的学习空间</div><nav class="nav" aria-label="主要导航">${navs.map(([id, ic, label]) => `<button data-nav="${id}" class="${active === id ? "active" : ""}" ${active === id ? 'aria-current="page"' : ""}>${icon(ic)}<span>${label}</span>${id === "review" && dueCount() ? `<span class="nav-badge">${dueCount()}</span>` : ""}</button>`).join("")}</nav><div class="sidebar-bottom"><div class="side-note">${icon("sound")}<b>每天一点，听见改变。</b>把听得懂的，变成写得对的。</div><div class="side-foot"><span class="dot"></span> 个人学习 · 本地保存</div></div></aside><div class="main-shell"><header class="topbar"><div class="mobile-logo"><img src="./icon.svg" alt="">听见进步</div><div class="breadcrumbs">我的学习空间 <span style="margin:0 10px">/</span> <strong>${navs.find((n) => n[0] === active)?.[2]}</strong></div><div class="top-actions"><button class="backup-header" data-action="backup-settings" title="查看 GitHub 备份状态"><span class="dot"></span><span data-backup-status>${esc(backupStatus.message)}</span></button>${button(icon("download") + " 备份数据", "export", "small")}<div class="avatar" title="我的听写空间">ME</div></div></header><main id="main" class="main">${storageMessage ? `<div class="notice warning">${esc(storageMessage)}</div>` : ""}${content}<footer class="footer">每一次认真听写，都算数。<br>语料来源：王陆语料库 · 仅供个人学习 &nbsp; / &nbsp; <a href="https://github.com/PipiTang233/wanglu-dictation-app" target="_blank" rel="noopener">原项目</a> · <a href="https://github.com/zyxlele/wanglu-dictation" target="_blank" rel="noopener">初始项目</a> · <a href="https://github.com/ielts-wanglu-dictation/ielts-wanglu-dictation.github.io" target="_blank" rel="noopener">本站源码</a></footer></main></div>`;
}
function heading(kicker, title, subtitle, extra = "") {
  return `<div class="page-heading"><div><div class="eyebrow">${kicker}</div><h1>${title}</h1><p>${subtitle}</p></div>${extra}</div>`;
}
function metrics(items) {
  return `<div class="metrics">${items.map(([ic, n, unit, label]) => `<div class="metric"><div class="metric-icon">${icon(ic)}</div><div><b>${n}<small>${unit}</small></b><span>${label}</span></div></div>`).join("")}</div>`;
}
function chapterTabs() {
  return `<div class="tabs" aria-label="章节筛选">${chapters.map((c) => `<button class="${chapterFilter === c.id ? "active" : ""}" data-chapter="${esc(c.id)}">${esc(c.title)}</button>`).join("")}</div>`;
}
function sectionCards(limit) {
  const secs = sections.filter((s) => s.chapterId === chapterFilter);
  return `<div class="chapter-grid">${secs
    .slice(0, limit || secs.length)
    .map((s) => {
      const hs = sectionHistory(s.id),
        last = hs.at(-1),
        progress = getSectionProgress(state.history, s),
        done = progress.completedCount;
      return `<article class="chapter-card"><div class="card-top"><div class="book-icon">${icon("book")}</div><span class="chip ${last ? "green" : ""}">${last ? Math.round((last.correct / last.total) * 100) + (last.assisted ? "% 巩固" : "% 独立") : "待开始"}</span></div><h3>第 ${esc(s.id)} 节 · ${s.chapterId === "5" || s.chapterId === "11" ? "短语听写" : "词汇听写"}</h3><p>${s.words.length} 个词条 · ${hs.length ? hs.length + " 次练习" : "开启你的第一遍练习"}</p><div class="progress-track"><span style="width:${Math.min(100, (done / s.words.length) * 100)}%"></span></div><div class="card-bottom"><span>已练 ${Math.min(done, s.words.length)} / ${s.words.length} 词</span>${progress.hasProgress && progress.nextIndex !== null ? button("设置", "section", "small text", `data-id="${esc(s.id)}"`) : ""}${button((progress.hasProgress && progress.nextIndex !== null ? "继续练习 " : "开始练习 ") + icon("arrow"), progress.hasProgress && progress.nextIndex !== null ? "continue-section" : "section", "small text", `data-id="${esc(s.id)}"`)}</div></article>`;
    })
    .join("")}</div>`;
}
function recentTable(history, compact = false) {
  if (!history.length)
    return `<div class="empty">${icon("chart")}<p>还没有练习记录</p>完成一次听写，你的进步就会出现在这里。</div>`;
  return `<div class="table-wrap"><table><thead><tr><th>练习内容</th><th>正确率</th>${compact ? "" : "<th>答对 / 总数</th>"}<th>时间</th><th><span class="sr-only">详情</span></th></tr></thead><tbody>${[
    ...history,
  ]
    .reverse()
    .map(
      (h) =>
        `<tr><td>${esc(h.title || h.sectionId || "复习")}<span class="sub">${modeLabel(h.mode)} · ${h.assisted ? "巩固练习" : "独立听写"}</span></td><td><span class="chip ${h.correct / h.total >= 0.8 ? "green" : "purple"}">${h.total ? Math.round((h.correct / h.total) * 100) : 0}%</span></td>${compact ? "" : `<td>${h.correct} / ${h.total}</td>`}<td class="muted">${dateText(h.date)}</td><td>${button("详情", "history-detail", "small text", `data-id="${esc(h.id)}"`)}</td></tr>`,
    )
    .join("")}</tbody></table></div>`;
}
function home() {
  const s = computeStats(state.history),
    independent = computeIndependentStats(state.history),
    goal = state.settings.dailyGoal || 50,
    progress = Math.min(100, (s.todayCount / goal) * 100);
  const recentSection = [...state.history].reverse()
    .filter(h => h.mode !== 'review')
    .map(h => sections.find(section => section.id === h.sectionId))
    .find(section => section && getSectionProgress(state.history, section).nextIndex !== null);
  return (
    heading(
      "A LITTLE PRACTICE, EVERY DAY",
      "今天，也听见一点进步。",
      "从一个单词开始，让每一次练习都有迹可循。",
      `<span class="date-pill">${studyDateKey()} 学习日 · 北京时间 06:00 换日</span>`,
    ) +
    `${studyResumeStrip()}${state.draft ? `<div class="resume-strip"><span>${icon("save")} 上次练习已保存：${esc(state.draft.title)} · 已填写 ${state.draft.answers.filter(Boolean).length} / ${state.draft.wordIds.length}</span>${button("继续听写 " + icon("arrow"), "resume", "small")}</div>` : recentSection ? continuationPanel(recentSection, true) : ""}<div class="hero-grid"><section class="hero"><div class="hero-copy"><span class="tag">YOUR DAILY LISTENING RITUAL</span><h2>让熟悉的单词，<br>成为听力里的确定感。</h2><p>先看词听音，再回忆拼写。<br>学过的词，留到之后再独立听写。</p>${button(icon("play") + " 开始今日练习", "daily", "primary")}${button("浏览语料", "library-link", "text")}</div><div class="wave-art" aria-hidden="true">${"<i></i>".repeat(9)}</div></section><section class="panel goal-panel"><div class="panel-top"><h3>今日听写目标</h3>${button("调整目标", "goal", "text small")}</div><div class="goal-body"><div class="goal-ring" style="--progress:${progress}%"><div><strong>${s.todayCount}</strong><span>/ ${goal} 个词</span></div></div><div class="goal-info"><b>${progress >= 100 ? "今日目标已完成" : "给专注留一点时间"}</b><p>${progress >= 100 ? "做得不错，明天继续。" : `再练 ${Math.max(0, goal - s.todayCount)} 个，完成今日目标`}</p><span class="mini">${icon("check")} 每一步都在积累</span></div></div></section></div>` +
    metrics([
      ["book", s.totalWords || 0, "词", "累计听写"],
      ["flame", s.streak || 0, "天", "连续练习"],
      [
        "target",
        independent.accuracy ?? "—",
        independent.totalWords ? "%" : "",
        "独立听写正确率",
      ],
      ["review", dueCount(), "词", "待复习词条"],
    ]) +
    `<section><div class="section-header"><div><h2>回到语料，继续积累</h2><p>4 个章节 · 32 个小节 · 5,873 个词条</p></div>${chapterTabs()}</div>${sectionCards(6)}<div style="text-align:center;margin-top:14px">${button("查看全部语料 " + icon("arrow"), "library-link", "text")}</div></section><div class="lower-grid"><section class="panel"><div class="section-header"><h2>最近的练习</h2>${button("全部记录 " + icon("arrow"), "history-link", "text small")}</div>${recentTable(state.history.slice(-3), true)}</section><section class="panel tip-card"><div class="eyebrow">A SMALL REMINDER</div>${icon("info")}<h3>比一遍全对更重要的，<br>是把错词再听一遍。</h3><p>答错或标记“模糊”的词都会进入复习。模糊不计作错误；清晰答对后，逐步延长复习间隔。</p>${button("去复习 " + icon("arrow"), "review-link", "text small")}</section></div>`
  );
}
function library() {
  return (
    heading(
      "YOUR WORD COLLECTION",
      "每个小节，都是一个小目标。",
      "按章节练习，或搜索词条；支持整节、分组和自选词序范围。",
    ) +
    `<div class="toolbar"><label class="sr-only" for="corpus-search">搜索语料</label><input id="corpus-search" type="search" placeholder="搜索英文单词或中文释义…"><span class="muted">共 5,873 词</span></div><div id="search-results"></div><div class="section-header">${chapterTabs()}</div>${sectionCards()}`
  );
}
function chart(history) {
  const data = history.filter(h => !h.assisted).slice(-20);
  if (!data.length)
    return '<div class="empty">完成独立听写后，将在这里显示正确率变化。</div>';
  const points = data.map((h, i) => [
    45 + (data.length === 1 ? 225 : (i * 450) / (data.length - 1)),
    148 - (h.correct / h.total) * 120,
  ]);
  return `<svg class="chart" viewBox="0 0 530 180" role="img" aria-label="最近 ${data.length} 次练习正确率趋势">${[0, 50, 100].map((n) => `<line x1="40" y1="${148 - n * 1.2}" x2="505" y2="${148 - n * 1.2}" stroke="var(--line)"/><text x="4" y="${152 - n * 1.2}">${n}%</text>`).join("")}<polyline points="${points.map((p) => p.join(",")).join(" ")}" fill="none" stroke="currentColor" stroke-width="2.5"/>${points.map(([x, y], i) => `<circle cx="${x}" cy="${y}" r="4" fill="currentColor"><title>${dateText(data[i].date)}：${Math.round((data[i].correct / data[i].total) * 100)}%</title></circle>`).join("")}<text x="40" y="174">${dateText(data[0].date)}</text><text x="505" y="174" text-anchor="end">${dateText(data.at(-1).date)}</text></svg>`;
}

function continuationPanel(section, compact = false) {
  const progress = getSectionProgress(state.history, section);
  if (!progress.hasProgress) return '';
  const batch = nextSectionBatch(state.history, section, progress.suggestedSize);
  if (batch) return `<div class="resume-strip continuation-strip"><span>${icon('arrow')}<strong>接着上一组 · 第 ${esc(section.id)} 节</strong><br>已练 ${progress.completedCount} / ${progress.total} 词 · 下一组第 ${batch.startIndex + 1}–${batch.endIndex} 词${compact ? '' : progress.lastMode === 'shuffle' ? ' · 保留乱序模式，已完成的词不会重复' : ' · 按原词序接着练，已完成的词不会重复'}</span><div class="flex">${button('先学下一组', 'continue-study', 'primary small', `data-id="${esc(section.id)}"`)}${button('继续听写 ' + icon('play'), 'continue-section', 'small', `data-id="${esc(section.id)}"`)}</div></div>`;
  const next = sections[sections.findIndex(s => s.id === section.id) + 1];
  return `<div class="resume-strip continuation-strip"><span>${icon('check')}<strong>本节已练完 · ${progress.total} / ${progress.total} 词</strong><br>可以复习错词与模糊词，或继续下一小节。</span>${next ? button('下一小节 · ' + esc(next.id), 'continue-section', 'primary small', `data-id="${esc(next.id)}"`) : button('浏览全部语料', 'library-link', 'small')}</div>`;
}
function continueSection(id, study = false) {
  const section = sections.find(s => s.id === id);
  if (!section) return;
  const progress = getSectionProgress(state.history, section);
  const batch = nextSectionBatch(state.history, section, progress.suggestedSize);
  if (!batch) { openSection(id); return; }
  (study ? beginStudy : begin)(batch.words, `第 ${id} 节 · ${batch.startIndex + 1}–${batch.endIndex} 词`, id, study ? 'normal' : progress.lastMode || 'normal');
}

function sectionPage() {
  const s = sections.find((x) => x.id === currentSection),
    hs = sectionHistory(s.id),
    independent = hs.filter(h => !h.assisted),
    last = independent.at(-1),
    best = independent.length
      ? Math.max(...independent.map((h) => (h.correct / h.total) * 100))
      : 0,
    avg = independent.length
      ? independent.reduce((a, h) => a + (h.correct / h.total) * 100, 0) / independent.length
      : 0;
  const progress = getSectionProgress(state.history, s);
  const start = progress.nextIndex === null ? 1 : progress.nextIndex + 1;
  const size = progress.suggestedSize;
  return (
    heading(
      "ONE SECTION AT A TIME",
      `第 ${esc(s.id)} 节`,
      `${s.words.length} 个词条 · ${hs.length} 次练习`,
      button(icon("back") + " 返回语料", "library-link"),
    ) +
    studyResumeStrip() + continuationPanel(s) +
    metrics([
      [
        "target",
        last ? Math.round((last.correct / last.total) * 100) : "—",
        last ? "%" : "",
        "最近独立听写",
      ],
      [
        "chart",
        independent.length ? Math.round(best) : "—",
        independent.length ? "%" : "",
        "独立听写最高",
      ],
      [
        "check",
        independent.length ? Math.round(avg) : "—",
        independent.length ? "%" : "",
        "独立听写平均",
      ],
      ["book", hs.length, "次", "本节练习"],
    ]) +
    `<div class="section-detail-grid"><section class="panel"><h2>设置这次练习</h2><p class="muted">按原始语料顺序，选择适合今天的练习量。</p><div class="field"><label for="batch-size">练习数量</label><select id="batch-size">${[...new Set([20, 50, 100, size])].sort((a,b)=>a-b).map(n=>`<option value="${n}" ${n===size?"selected":""}>${n===20?"轻量一组":n===50?"标准一组":n===100?"集中练习":"上次分组"} · ${n} 词</option>`).join("")}<option value="all">本节全部 · ${s.words.length} 词</option><option value="range">自选词序范围</option></select></div><div class="form-row"><div class="field"><label for="range-start">起始词序</label><input id="range-start" type="number" min="1" max="${s.words.length}" value="${start}"></div><div class="field"><label for="range-end">结束词序（自选范围时）</label><input id="range-end" type="number" min="1" max="${s.words.length}" value="${Math.min(start + size - 1, s.words.length)}"></div></div><div class="flex" style="margin-top:24px">${button(icon("book") + " 看词听音", "start-study", "primary")}${button(icon("play") + " 直接听写", "start-section")}${button(icon("shuffle") + " 乱序测试", "start-shuffle")}</div><p class="muted" style="font-size:11px;margin-top:12px">乱序仅打乱本次选定范围；Enter 下一题并播放，F2 重听，F4 标记模糊。</p></section><section class="panel"><h2>独立听写趋势</h2><p class="muted">不含学后或看答案后的巩固练习</p>${chart(hs)}${independent.length > 1 ? `<p class="muted">较上次：${Math.round((last.correct / last.total) * 100 - (independent.at(-2).correct / independent.at(-2).total) * 100)} 个百分点</p>` : ""}</section></div><section style="margin-top:26px"><div class="section-header"><h2>本节练习记录</h2>${button("查看本节词表", "preview-words", "small")}</div>${recentTable(hs)}</section>` + learningGuide()
  );
}
function learningGuide() {
  return `<details class="panel learning-guide"><summary>怎样用语料库学习？</summary><p>初次接触时，可以先看词听音、跟读抄写，再遮词回忆；已有基础时，也可以直接听写找出薄弱词。</p><p>王陆在 2017 年的官方说明中建议：集中听写 → 订正并整理错词 → 分天看词、抄写、跟录音朗读 → 下周复测。不要把刚记住答案后的高分当作长期掌握。</p><p>本站的“先学后测”是按你的需要做的适配。学习不计听写成绩；学后巩固单独标记，独立听写只在提交后批改。每日目标统计已提交的听写词数。</p><p class="muted">当前使用合成语音 / 词典发音，还没有教材原录音。原录音的横向、纵向和倍速训练不能与本站乱序、合成语音速度直接等同。</p><a href="https://ielts.guixue.com/article/2258.shtml" target="_blank" rel="noopener">查看王陆官方学习方法（2017 年） ↗</a></details>`;
}
function studyResumeStrip() {
  const d = state.studyDraft;
  return d ? `<div class="resume-strip continuation-strip study-resume"><span>${icon('book')} <strong>看词听音 · ${esc(d.title)}</strong><br>第 ${d.round} 轮 · ${d.completed ? '本轮已完成，可再次学习或进入听写' : `本轮已过 ${d.seen.filter(Boolean).length} / ${d.wordIds.length} 词 · 停在第 ${d.activeIndex + 1} 词`}</span>${button('继续学习 ' + icon('arrow'), 'study-resume', 'small soft')}</div>` : '';
}
function beginStudy(words, title, sectionId, mode = 'normal', force = false) {
  if (!words.length) { toast('当前没有可学习的词条。'); return; }
  if (state.studyDraft && !force) {
    modal('开始新的学习？', `<p>已有「${esc(state.studyDraft.title)}」的学习进度。新学习会替换这份学习草稿；听写草稿仍会保留。</p>`, [
      { label: '继续原学习', action: () => { closeModal(); resumeStudy(); } },
      { label: '开始新学习', primary: true, action: () => { closeModal(); beginStudy(words, title, sectionId, mode, true); } },
    ]);
    return;
  }
  suspend();
  state.studyDraft = createStudyDraft(words, title, sectionId, mode);
  state.studyDraft.uncertain = words.map(w => Boolean(state.reviews[w.id]?.uncertain));
  persist();
  resumeStudy();
}
function resumeStudy() {
  if (!state.studyDraft) return;
  suspend();
  page = 'study'; render(); window.scrollTo(0, 0);
  if (!state.studyDraft.completed) { focusStudy(); void playStudy(); }
}
function focusStudy() { $('#study-copy')?.focus({ preventScroll: true }); }
function studyPage() {
  const d = state.studyDraft, words = wordsForDraft(d), w = words[d.activeIndex];
  const uncertain = d.uncertain.filter(Boolean).length;
  const head = `<div class="session-head"><div><div class="eyebrow">LOOK. LISTEN. RECALL.</div><h1>${esc(d.title)}</h1><p>看词听音 · 第 ${d.round} 轮 · ${words.length} 词 · 学习进度自动保存</p></div>${button(icon('save') + ' 保存并退出', 'save-exit')}</div>`;
  if (d.completed) return head + `<section class="panel study-complete"><span class="chip green">第 ${d.round} 轮已完成</span><h2>再回忆一次，然后给记忆一点时间。</h2><p>本组 ${words.length} 词 · 模糊 ${uncertain} 词。看过和听过不等于掌握，隔天再独立听写检查。</p><div class="flex">${button(icon('play') + ' 进入听写巩固', 'study-test', 'primary')}${button('整组再学一轮', 'study-restart')}${button('只学模糊词', 'study-uncertain-only', '', uncertain ? '' : 'disabled')}${nextStudyBatch() ? button('学习下一组', 'study-next-batch') : ''}${button('稍后再测', 'save-exit', 'text')}</div><p class="muted">本轮学习没有增加听写成绩或已掌握词数。进入听写后不带入抄写答案，成绩标记为“巩固练习”。</p></section>` + learningGuide();
  return head + `<div class="study-layout"><section class="panel study-card ${d.uncertain[d.activeIndex] ? 'study-uncertain' : ''}"><div class="flex space"><span class="chip">第 ${d.activeIndex + 1} / ${words.length} 词</span>${button(d.uncertain[d.activeIndex] ? '已标记模糊' : '标记模糊', 'study-uncertain', 'uncertain-toggle', `aria-pressed="${d.uncertain[d.activeIndex]}"`)}</div><div class="study-word-area" aria-live="polite">${d.hidden ? '<h2 class="study-word">答案已遮住</h2><p class="muted">先听发音，试着回忆并拼写，再展开核对。</p>' : `<h2 id="study-word" class="study-word">${esc(w.text)}</h2><p class="study-phonetic">${esc(w.phonetic)}</p><p class="study-meaning">${esc(w.meaning)}</p>`}</div><div class="flex study-play">${button(icon('sound') + ' 重听 / 跟读', 'study-replay', 'primary')}${button(d.hidden ? '显示答案核对' : '遮词回忆', 'study-hide', '', `aria-pressed="${d.hidden}"`)}</div><label for="study-copy">${d.hidden ? '凭听音回忆拼写' : '边听边抄写（可选）'}</label><input id="study-copy" value="${esc(d.answers[d.activeIndex])}" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="${d.hidden ? '试着拼写，再展开核对…' : '跟读后抄写，或在纸上写…'}" enterkeyhint="next"><p class="study-copy-help muted">${d.hidden ? '只用于自查，不计成绩。' : '遮词时会清空当前抄写，便于重新回忆；再看答案后可自行核对。'}</p><div class="study-navigation">${button(icon('back') + ' 上一个', 'study-prev', '', d.activeIndex === 0 ? 'disabled' : '')}<span>${d.seen.filter(Boolean).length} / ${words.length} 已过</span>${button((d.activeIndex === words.length - 1 ? '完成本轮' : '下一个') + ' ' + icon('arrow'), 'study-next', 'primary')}</div><div class="progress-track"><span style="width:${100 * d.seen.filter(Boolean).length / words.length}%"></span></div></section><aside class="stack"><section class="panel"><h2>连接声音与拼写</h2><ol class="study-steps"><li>看词听音，留意重音和词尾。</li><li>跟读一遍，再抄写或默写。</li><li>遮词回忆；仍不熟悉就标记模糊。</li></ol><div class="flex">${button(icon(studyPlaying ? 'pause' : 'play') + (studyPlaying ? ' 停止听读' : ' 连续听读'), 'study-block')}${button(icon('settings') + ' 发音设置', 'audio-settings')}</div><div id="audio-status" class="audio-status" aria-live="polite">当前为合成语音 / 词典发音，不是教材原录音。</div><p class="muted">连续听读按发音设置中的重复次数与间隔播放，到本轮结束即停止。模糊词立即加入复习，不增加错误次数。</p></section><section class="panel study-shortcuts"><h3>流畅学习</h3><p><kbd>Enter</kbd> 从抄写框进入下一词并播放<br><kbd>Shift</kbd> + <kbd>Enter</kbd> 上一词<br><kbd>F2</kbd> / <kbd>Alt</kbd> + <kbd>R</kbd> 重听<br><kbd>F4</kbd> 模糊标记 · <kbd>Esc</kbd> 停止</p>${button('直接进入听写巩固', 'study-test', 'small text')}</section></aside></div>` + learningGuide();
}
async function playStudy() {
  if (page !== 'study' || !state.studyDraft || state.studyDraft.completed) return false;
  const d = state.studyDraft;
  return speech.speak(wordsForDraft(d)[d.activeIndex].text, state.settings);
}
function moveStudy(action) {
  stop();
  state.studyDraft = advanceStudyDraft(state.studyDraft, action);
  persist(); render(); focusStudy();
  if (!state.studyDraft.completed) void playStudy();
}
function toggleStudyUncertain() {
  const d = state.studyDraft, i = d.activeIndex, w = wordsForDraft(d)[i];
  d.uncertain[i] = !d.uncertain[i];
  const old = state.reviews[w.id];
  if (d.uncertain[i]) {
    state.reviews[w.id] = { wordId: w.id, text: w.text, meaning: w.meaning || '', phonetic: w.phonetic || '', sectionId: w.sectionId || '', lastTyped: old?.lastTyped || '', ...old, ...updateReview(old, true, new Date(), true) };
  } else if (old) old.uncertain = false;
  persist(); render(); focusStudy();
}
async function studyBlock() {
  if (studyPlaying) { stop(); return; }
  stop(); studyPlaying = true;
  const token = blockToken;
  render();
  while (page === 'study' && studyPlaying && !state.studyDraft.completed && token === blockToken) {
    const ok = await playStudy();
    if (!ok || token !== blockToken) break;
    await new Promise(resolve => setTimeout(resolve, Number(state.settings.interval) * 1000));
    if (token !== blockToken || page !== 'study') return;
    state.studyDraft = advanceStudyDraft(state.studyDraft, 'next');
    persist(); render();
  }
  if (token === blockToken) stop();
}
function studyTest() {
  const d = state.studyDraft;
  begin(wordsForDraft(d), d.title, d.sectionId, d.mode, false, { assisted: true, uncertain: [...d.uncertain] });
}
function nextStudyBatch() {
  const d = state.studyDraft;
  if (!d || d.mode === 'review') return null;
  const section = sections.find(s => s.id === d.sectionId);
  if (!section) return null;
  const selected = new Set(d.wordIds);
  const start = section.words.reduce((last, w, i) => selected.has(w.id) ? i + 1 : last, 0);
  if (!start || start >= section.words.length) return null;
  const words = section.words.slice(start, start + d.wordIds.length);
  return { words, title: `第 ${section.id} 节 · ${start + 1}–${start + words.length} 词`, sectionId: section.id };
}
function begin(words, title, sectionId, mode = "normal", force = false, options = {}) {
  if (!words.length) {
    toast("当前没有可练习的词条。");
    return;
  }
  if (state.draft && !force) {
    modal(
      "开始新的练习？",
      `<p>还有一份未完成的「${esc(state.draft.title)}」。开始新练习会替换这份草稿，历史记录不受影响。</p>`,
      [
        {
          label: "继续原练习",
          action: () => {
            closeModal();
            resume();
          },
        },
        {
          label: "开始新练习",
          primary: true,
          action: () => {
            closeModal();
            begin(words, title, sectionId, mode, true, options);
          },
        },
      ],
    );
    return;
  }
  stop();
  const ordered = mode === "shuffle" ? shuffle(words) : words;
  session = {
    id: crypto.randomUUID(),
    sectionId,
    title,
    mode,
    wordIds: ordered.map((w) => w.id),
    words: ordered,
    answers: ordered.map(() => ""),
    uncertain: ordered.map((w) => Boolean(options.uncertain?.[words.indexOf(w)])),
    activeIndex: 0,
    startedAt: new Date().toISOString(),
    elapsed: 0,
  };
  if (options.assisted) session.assisted = true;
  startedSegment = Date.now();
  activeIndex = 0;
  alignment = [];
  saveDraft();
  page = "practice";
  render();
  window.scrollTo(0, 0);
  focusAnswer(0, { play: true });
}
function shuffle(words) {
  const a = [...words];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function resume() {
  const d = state.draft,
    words = wordsForDraft(d);
  if (!d || words.length !== d.wordIds.length) {
    toast("这份草稿词条不完整，请导出备份后重新开始。");
    return;
  }
  session = {
    ...d,
    words,
    answers: words.map((_, i) => String(d.answers[i] || "")),
    uncertain: words.map((_, i) => Boolean(d.uncertain?.[i])),
  };
  activeIndex = Math.max(0, Math.min(words.length - 1, d.activeIndex || 0));
  startedSegment = Date.now();
  page = "practice";
  alignment = [];
  render();
  focusAnswer(activeIndex, { play: true });
}
function practicePage() {
  return `<div class="session-head"><div><div class="eyebrow">LISTEN. TYPE. REPEAT.</div><h1>${esc(session.title)}</h1><p>${modeLabel(session.mode)} · ${session.assisted ? "巩固练习（不计独立正确率）" : "独立听写"} · ${session.words.length} 词 · <span id="answered-count">${session.answers.filter(a => a.trim()).length}</span> 已填写 · <span id="uncertain-count">${session.uncertain.filter(Boolean).length}</span> 模糊 · 草稿自动保存</p></div>${button(icon('save') + ' 保存并退出', 'save-exit')}</div>
  <div class="practice-toolbar"><div class="toolbar">${button(icon('sound') + ' 重听当前词', 'replay', 'primary')}${button(icon('play') + ' 连播', 'block')}${button('聚焦播放：' + (state.settings.autoPlay ? '开' : '关'), 'auto', state.settings.autoPlay ? 'soft' : '')}${button(icon('settings') + ' 发音设置', 'audio-settings')}</div>
  <div class="shortcut-help"><span><kbd>Enter</kbd> 下一题并播放</span><span><kbd>Shift</kbd> + <kbd>Enter</kbd> 上一题</span><span><kbd>F2</kbd> / <kbd>Alt</kbd> + <kbd>R</kbd> 重听</span><span><kbd>F4</kbd> 模糊标记</span><span><kbd>Esc</kbd> 停止</span></div>
  <div id="audio-status" class="audio-status" aria-live="polite">Enter 自动播放下一词；“聚焦播放”控制鼠标或 Tab 进入答案框时是否播放。</div></div>
  <div class="flex space" style="margin:14px 0"><span class="muted" style="font-size:11px">答案填错行？先选中需要调整的输入框。模糊标记跟随词条保存。</span><div class="flex">${button('插入空行 ↓', 'align-down', 'small')}${button('答案上移 ↑', 'align-up', 'small')}${button('撤销调整', 'align-undo', 'small')}</div></div>
  <div class="practice-list">${session.words.map((w,i) => `<div class="dict-row ${session.uncertain[i] ? 'uncertain-row' : ''}" id="row-${i}"><span class="num">${i + 1}</span>${button(icon('sound'), 'speak', 'text', `data-index="${i}" aria-label="播放第 ${i + 1} 词"`)}<label class="sr-only" for="answer-${i}">第 ${i + 1} 题答案</label><input id="answer-${i}" data-answer="${i}" value="${esc(session.answers[i])}" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="听音后输入…" enterkeyhint="${i === session.words.length - 1 ? 'done' : 'next'}">${button('模糊', 'toggle-uncertain', 'uncertain-toggle', `data-index="${i}" aria-label="标记第 ${i + 1} 词为模糊" aria-pressed="${session.uncertain[i]}" title="不确定就标记，答对也会加入复习（F4）"`)}<div class="answer-feedback" hidden></div></div>`).join('')}</div>
  <div class="practice-end"><span>支持常见英美拼写；忽略大小写和首尾空格。<br>模糊与对错独立记录；提交后计入统计；提前看答案会转为巩固练习。</span><div class="flex">${button('看答案转巩固', 'check')}${button('提交听写 ' + icon('check'), 'finish', 'primary')}</div></div>`;
}
function toggleUncertain(index = activeIndex) {
  if (!session || !session.words[index]) return;
  session.uncertain[index] = !session.uncertain[index];
  const row = $(`#row-${index}`), marked = session.uncertain[index];
  row?.classList.toggle('uncertain-row', marked);
  row?.querySelector('[data-action="toggle-uncertain"]')?.setAttribute('aria-pressed', String(marked));
  $('#uncertain-count').textContent = session.uncertain.filter(Boolean).length;
  focusAnswer(index);
}
function getResults() {
  return session.words.map((w, i) => ({
    wordId: w.id,
    text: w.text,
    meaning: w.meaning || "",
    phonetic: w.phonetic || "",
    sectionId: w.sectionId,
    typed: session.answers[i] || "",
    ok: gradeAnswer(session.answers[i] || "", w.text),
    uncertain: Boolean(session.uncertain[i]),
  }));
}
function check(confirmed = false) {
  if (!session.assisted && !confirmed) {
    modal("提前看答案？", "<p>看答案后，本次将标记为巩固练习，不计入独立听写正确率。想检验真实听辨能力，请直接提交听写。</p>", [
      { label: "继续独立作答", action: closeModal },
      { label: "看答案并转为巩固", primary: true, action: () => { closeModal(); check(true); } },
    ]);
    return;
  }
  stop();
  session.assisted = true;
  saveDraft(); render();
  getResults().forEach((r, i) => {
    const row = $(`#row-${i}`);
    row.classList.remove("good", "bad");
    row.classList.add(r.ok ? "good" : "bad");
    const el = row.querySelector(".answer-feedback");
    el.hidden = false;
    el.innerHTML = `<span class="${r.ok ? "good-text" : "bad-text"}">${r.ok ? "✓ 正确" : "正确答案：" + esc(r.text)}</span> <span class="muted">${esc(r.meaning)}</span>`;
  });
  toast("已转为巩固练习；提交后保存，不计独立听写正确率。");
}
function finish(confirmed = false) {
  if (!session) return;
  const empty = session.answers.filter((a) => !a.trim()).length;
  if (empty && !confirmed) {
    modal(
      "还有未填写的题目",
      `<p>${empty} 个空白答案将计为错误，并加入错词本。你可以继续作答，也可以直接提交。</p>`,
      [
        { label: "继续作答", action: closeModal },
        {
          label: "确认提交",
          primary: true,
          action: () => {
            closeModal();
            finish(true);
          },
        },
      ],
    );
    return;
  }
  stop();
  const results = getResults(),
    correct = results.filter((r) => r.ok).length,
    h = {
      id: session.id,
      sectionId: session.sectionId,
      title: session.title,
      mode: session.mode,
      date: new Date().toISOString(),
      duration: Math.round(elapsed()),
      total: results.length,
      correct,
      results,
    };
  if (session.assisted) h.assisted = true;
  if (!state.history.some((x) => x.id === h.id)) {
    state.history.push(h);
    for (const r of results) {
      const old = state.reviews[r.wordId];
      // Seeing answers can consolidate memory, but cannot certify independent recall.
      if (h.assisted && r.ok && !r.uncertain) continue;
      if (!r.ok || r.uncertain || old)
        state.reviews[r.wordId] = {
          ...old,
          ...r,
          ...updateReview(old, r.ok, new Date(h.date), r.uncertain),
          lastTyped: r.typed,
        };
    }
  }
  state.draft = null;
  session = null;
  startedSegment = 0;
  persist();
  lastResult = h;
  resultFilter = "wrong";
  page = "result";
  render();
  window.scrollTo(0, 0);
}
function resultList(results) {
  if (!results.length)
    return (
      '<div class="empty">' +
      icon("check") +
      "<p>当前筛选下没有词条，可以切换查看全部。</p></div>"
    );
  return `<div class="panel" style="padding:0">${results.map((r) => `<div class="result-row"><span class="${r.ok ? "good-text" : "bad-text"}">${r.ok ? "✓" : "×"}</span><div><span class="word">${esc(r.text)}</span>${r.uncertain ? ' <span class="chip uncertain-chip">模糊</span>' : ""}<div class="meaning">${esc(r.phonetic)} ${esc(r.meaning)}</div></div><div class="${r.ok ? "correct" : "answer"}">${esc(r.typed || "（未填写）")}</div>${button(icon("sound"), "speak-word", "text", `data-text="${esc(r.text)}" aria-label="播放 ${esc(r.text)}"`)}</div>`).join("")}</div>`;
}
function resultPage() {
  const h = lastResult;
  const section = sections.find(s => s.id === h.sectionId);
  const uncertainCount = h.results.filter(r => r.uncertain).length;
  return (
    heading(
      "EVERY TRY COUNTS",
      "这一遍，完成了。",
      `${esc(h.title || h.sectionId)} · ${modeLabel(h.mode)} · ${h.assisted ? "巩固练习" : "独立听写"} · ${dateText(h.date)}`,
    ) +
    (section ? continuationPanel(section) : "") +
    `${h.assisted ? '<div class="notice">这是学后或看过答案的巩固练习，不计独立听写正确率，也不增加掌握次数。下次可从小节页直接听写，检验是否仍能听出并拼对。</div>' : ""}<section class="panel results-hero"><div><div class="score">${Math.round((h.correct / h.total) * 100)}<small>%</small></div><span class="muted">${h.assisted ? "巩固正确率 · 不计独立成绩" : "本次独立正确率"}</span></div><div><h2>${h.correct === h.total ? "全部答对，记得按时复习。" : "找到错词，就是进步的开始。"}</h2><p class="muted">答对 ${h.correct} / ${h.total} 词 · 模糊 ${uncertainCount} 词 · 用时 ${Math.floor((h.duration || 0) / 60)} 分 ${(h.duration || 0) % 60} 秒</p><div class="flex">${button(icon("book") + " 学习本次错词与模糊词", "study-result", "primary", h.results.some(r => !r.ok || r.uncertain) ? "" : "disabled")}${button("重练本次模糊词", "retry-uncertain", "soft", uncertainCount ? "" : "disabled")}${button(icon("review") + " 重练本次错词", "retry-wrong", "", h.results.some((r) => !r.ok) ? "" : "disabled")}${button(h.results.length < h.total ? "重练已有词条" : "再练一次", "retry", "", h.results.length ? "" : "disabled")}${button(icon("shuffle") + " 乱序重练", "retry-shuffle", "", h.results.length ? "" : "disabled")}</div></div></section><div class="section-header"><h2>逐词批改</h2><div class="tabs"><button data-result-filter="wrong" class="${resultFilter === "wrong" ? "active" : ""}">错词 ${h.results.filter((r) => !r.ok).length}</button><button data-result-filter="uncertain" class="${resultFilter === "uncertain" ? "active" : ""}">模糊 ${uncertainCount}</button><button data-result-filter="all" class="${resultFilter === "all" ? "active" : ""}">全部 ${h.results.length}</button></div></div>${h.results.length < h.total ? '<div class="notice">旧版备份只保留了部分答题明细。总成绩仍按原记录显示，下方仅列出已有词条；重练也仅包含这些词条。</div>' : ""}${h.results.length ? resultList(h.results.filter(r => resultFilter === "all" || (resultFilter === "uncertain" ? r.uncertain : !r.ok))) : '<div class="empty">这是一条旧版汇总记录，没有逐词详情。</div>'}`
  );
}
function reviewPage() {
  return (
    heading(
      "MAKE THE WORDS STICK",
      "错词与模糊词，再听一遍。",
      "答对但模糊的词也会进入复习，不增加错误次数；连续清晰答对 3 次标记为已掌握。",
      button(icon("download") + " 导出复习 CSV", "export-words"),
    ) +
    `<div class="section-header"><div class="tabs">${[
      ["all", "全部词条"],
      ["wrong", "有过错误"],
      ["uncertain", "模糊词"],
      ["due", "到期复习"],
      ["active", "巩固中"],
      ["mastered", "已掌握"],
    ]
      .map(
        ([id, l]) =>
          `<button data-review-filter="${id}" class="${reviewFilter === id ? "active" : ""}">${l} ${reviewWords(id).length}</button>`,
      )
      .join(
        "",
      )}</div><div class="flex">${button(icon("book") + " 学习当前筛选", "study-review", "primary")}${button(icon("play") + " 听写当前筛选", "review-selected")}${button("复习今日到期词", "review-due")}</div></div><div class="toolbar"><label class="sr-only" for="review-search">搜索错词</label><input id="review-search" type="search" value="${esc(reviewSearch)}" placeholder="搜索错词或释义…"><label class="sr-only" for="review-chapter">错词小节</label><select id="review-chapter"><option value="">全部小节</option>${sections.map((s) => `<option value="${s.id}" ${reviewChapter === s.id ? "selected" : ""}>第 ${s.id} 节</option>`).join("")}</select><label class="sr-only" for="review-sort">错词排序</label><select id="review-sort"><option value="count" ${reviewSort === "count" ? "selected" : ""}>错误次数最多</option><option value="uncertain" ${reviewSort === "uncertain" ? "selected" : ""}>模糊次数最多</option><option value="date" ${reviewSort === "date" ? "selected" : ""}>最近练习优先</option><option value="chapter" ${reviewSort === "chapter" ? "selected" : ""}>按小节分组</option></select></div><div id="review-table">${reviewTable()}</div>`
  );
}
function filteredReviews() {
  const q = reviewSearch.trim().toLowerCase();
  return reviewWords()
    .filter(
      (w) =>
        (!reviewChapter || w.sectionId === reviewChapter) &&
        (!q || `${w.text} ${w.meaning}`.toLowerCase().includes(q)),
    )
    .sort((a, b) =>
      reviewSort === "uncertain"
        ? (b.uncertainCount || 0) - (a.uncertainCount || 0)
        : reviewSort === "date"
        ? new Date(b.date) - new Date(a.date)
        : reviewSort === "chapter"
          ? String(a.sectionId).localeCompare(String(b.sectionId), undefined, {
              numeric: true,
            })
          : b.wrongCount - a.wrongCount,
    );
}
function reviewTable() {
  const words = filteredReviews();
  if (!words.length)
    return `<section class="panel empty">${icon("review")}<p>${Object.keys(state.reviews).length ? "这个筛选下没有词条。" : "还没有错词或模糊词，开始一次练习吧。"}</p>${button("去语料库练习", "library-link", "soft")}</section>`;
  return `<div class="muted" style="font-size:11px;margin-bottom:10px">当前 ${words.length} 词 · 点击小节可打开练习设置</div><div class="table-wrap"><table><thead><tr><th>单词 / 短语</th><th>上次填写</th><th>小节</th><th>错误次数</th><th>模糊记录</th><th>复习状态</th><th>发音</th></tr></thead><tbody>${words.map((w) => `<tr><td><span class="word">${esc(w.text)}</span><span class="sub">${esc(w.phonetic)} ${esc(w.meaning)}</span></td><td>${esc(w.lastTyped || "—")}</td><td>${button(esc(w.sectionId || "旧版"), "section", "text small", `data-id="${esc(w.sectionId)}"`)}</td><td>${w.wrongCount}</td><td><span class="chip ${w.uncertain ? "uncertain-chip" : ""}">${w.uncertain ? "仍模糊" : "已清晰"}</span><span class="sub">累计 ${w.uncertainCount || 0} 次</span>${w.uncertain ? button("取消模糊", "clear-uncertain", "text small", `data-id="${esc(w.wordId)}"`) : ""}</td><td><span class="chip ${w.streak >= 3 ? "green" : new Date(w.due) <= new Date() ? "red" : "purple"}">${new Date(w.due) <= new Date() ? "待复习" : w.streak >= 3 ? "已掌握" : "巩固中"}</span><span class="sub">${new Date(w.due).toLocaleDateString("zh-CN")}</span></td><td>${button(icon("sound"), "speak-word", "text small", `data-text="${esc(w.text)}" aria-label="播放 ${esc(w.text)}"`)}</td></tr>`).join("")}</tbody></table></div>`;
}
function historyPage() {
  const hs = state.history.filter(
      (h) => !historySection || h.sectionId === historySection,
    ),
    stats = computeStats(hs), independent = computeIndependentStats(hs);
  return (
    heading(
      "YOUR PROGRESS, MADE VISIBLE",
      "进步，有迹可循。",
      "每次提交都保留原始答案，回看正确率，也回看那些终于写对的词。",
    ) +
    metrics([
      ["book", stats.totalSessions || 0, "次", "累计练习"],
      ["check", stats.totalWords || 0, "词", "累计听写"],
      [
        "target",
        independent.accuracy ?? "—",
        independent.totalWords ? "%" : "",
        "独立听写正确率",
      ],
      [
        "clock",
        Math.round(hs.reduce((n, h) => n + (h.duration || 0), 0) / 60),
        "分钟",
        "累计用时",
      ],
    ]) +
    `<section class="panel"><h2>最近 20 次独立听写正确率</h2><p class="muted">巩固练习在下方单独标记，不进入趋势或增加掌握次数。</p>${chart(hs)}</section><div class="toolbar"><h2 style="margin-right:auto">练习记录</h2><label class="sr-only" for="history-section">按小节筛选历史</label><select id="history-section"><option value="">全部小节</option>${sections.map((s) => `<option value="${s.id}" ${historySection === s.id ? "selected" : ""}>第 ${s.id} 节</option>`).join("")}</select></div>${recentTable(hs)}`
  );
}
function audioFields() {
  const s = state.settings;
  return `<div class="form-row"><div class="field"><label for="set-accent">发音口音</label><select id="set-accent" data-setting="accent"><option value="en-GB" ${s.accent === "en-GB" ? "selected" : ""}>英式英语</option><option value="en-US" ${s.accent === "en-US" ? "selected" : ""}>美式英语</option></select></div><div class="field"><label for="set-mode">发音方式</label><select id="set-mode" data-setting="mode"><option value="speech" ${s.mode === "speech" ? "selected" : ""}>合成语音（优先本机）</option><option value="dictionary" ${s.mode === "dictionary" ? "selected" : ""}>词典发音（需要联网）</option></select></div></div><div class="form-row"><div class="field"><label for="set-rate">语速</label><select id="set-rate" data-setting="rate">${[
    [0.65, "很慢 · 0.65×"],
    [0.85, "慢速 · 0.85×"],
    [1, "正常 · 1×"],
    [1.2, "快速 · 1.2×"],
  ]
    .map(
      ([v, l]) =>
        `<option value="${v}" ${s.rate === v ? "selected" : ""}>${l}</option>`,
    )
    .join(
      "",
    )}</select></div><div class="field"><label for="set-repeat">每词重复</label><select id="set-repeat" data-setting="repeat">${[1, 2, 3].map((v) => `<option value="${v}" ${s.repeat === v ? "selected" : ""}>${v} 次</option>`).join("")}</select></div></div><div class="form-row"><div class="field"><label for="set-interval">连播间隔</label><select id="set-interval" data-setting="interval">${[1, 2, 3, 5, 8].map((v) => `<option value="${v}" ${s.interval === v ? "selected" : ""}>${v} 秒</option>`).join("")}</select></div><div class="field"><label for="set-voiceURI">本机英语语音</label><select id="set-voiceURI" data-setting="voiceURI"><option value="">自动选择</option>${speech
    .listVoices()
    .map(
      (v) =>
        `<option value="${esc(v.voiceURI)}" ${s.voiceURI === v.voiceURI ? "selected" : ""}>${esc(v.name)} (${esc(v.lang)})</option>`,
    )
    .join(
      "",
    )}</select></div></div><div class="field row"><input id="set-autoPlay" type="checkbox" data-setting="autoPlay" ${s.autoPlay ? "checked" : ""}><label for="set-autoPlay">鼠标或 Tab 进入答案框时自动朗读（Enter 始终播放下一词）</label></div><div class="flex" style="margin-top:15px">${button(icon("sound") + " 测试语音", "test-voice", "soft")}<small class="muted">播放 accommodation</small></div><div class="audio-status audio-settings-status" role="status" aria-live="polite">点击测试可检查此设备的发音。</div>`;
}
function backupPanel() {
  const b = backupStatus;
  return `<div class="flex space"><h2>GitHub 私有备份</h2><span class="chip ${b.connected ? 'green' : ''}">${b.connected ? '已连接' : '未连接'}</span></div>
  <p class="backup-status-line" data-backup-status role="status">${esc(b.message)}</p>
  <p class="muted" style="font-size:12px">练习时自动上传；每天北京时间 04:00 留存快照。学习日从 06:00 开始，午夜不中断。首次打开会检查仓库，新进度不会被旧备份覆盖。</p>
  ${b.lastUploadedAt ? `<p class="muted" style="font-size:11px">最近上传：${dateText(b.lastUploadedAt)}（北京时间）</p>` : ''}
  <div class="flex">${b.connected ? button(icon('upload')+' 立即备份','backup-now','primary') + button('检查仓库进度','backup-check') + button('退出登录','backup-logout','text small') : button('使用 GitHub 登录','backup-login','primary', b.configured ? '' : 'disabled')}
  ${b.conflict ? button('处理进度冲突','backup-conflict','danger') : ''}</div>
  ${!b.configured ? '<div class="notice">GitHub 登录服务尚未完成配置。现有记录继续保存在本机，文件备份可正常使用。</div>' : ''}
  <p class="muted" style="font-size:11px;margin-top:14px">备份保存在独立私有仓库，仅授权的个人账号可访问。离线时先保存本机，恢复网络后补传。04:00 定时归档可能因 GitHub 排队延迟。</p>`;
}
function updateBackupStatus(next) {
  backupStatus = next;
  document.querySelectorAll('[data-backup-status]').forEach(el => { el.textContent = next.message; });
  const panel = $('#github-backup-panel');
  if (panel) panel.innerHTML = backupPanel();
}
function backupConflictDialog() {
  const conflict = backupClient?.pendingConflict;
  if (!conflict) { toast('当前没有需要处理的进度冲突。'); return; }
  modal('发现两份不同的进度', '<p>本机与仓库都有各自的新修改，已暂停自动上传。两份数据都保留着。</p><p>选择前会下载本机与仓库两份备份，避免丢失。不会自动合并或静默覆盖。</p>', [
    {label:'暂不处理',action:closeModal},
    {label:'保留本机并上传',action:()=>resolveBackupConflict('local')},
    {label:'恢复仓库进度',primary:true,action:()=>resolveBackupConflict('remote')},
  ]);
}
async function resolveBackupConflict(choice) {
  const c=backupClient?.pendingConflict;
  if(!c)return;
  download(JSON.stringify({app:'wanglu-personal',state},null,2),`wanglu-before-conflict-${localDateKey()}.json`);
  if(c.remote) download(JSON.stringify(c.remote,null,2),`wanglu-conflict-github-${localDateKey()}.json`);
  closeModal();
  const result=await backupClient.resolveConflict(choice);
  if(result.status==='conflict')toast('仓库又有新修改，请重新比较两份进度。');
}

function settingsPage() {
  return (
    heading(
      "MAKE IT YOURS",
      "按自己的节奏，练习。",
      "先保存到本机，连接 GitHub 后自动备份到你的私有仓库。",
    ) +
    `<div class="settings-grid"><section class="panel"><h2>听写与发音</h2>${audioFields()}<p class="muted" style="font-size:11px;margin-top:18px">本机语音由浏览器和系统提供；若未安装英语语音，将尝试在线备用源。短语优先合成语音。这里的发音不是原书配套录音。</p></section><div class="stack"><section id="github-backup-panel" class="panel">${backupPanel()}</section><section class="panel"><h2>我的学习偏好</h2><div class="form-row"><div class="field"><label for="set-dailyGoal">每日目标（词）</label><input id="set-dailyGoal" data-setting="dailyGoal" type="number" min="1" max="1000" value="${state.settings.dailyGoal}"></div><div class="field"><label for="set-theme">界面主题</label><select id="set-theme" data-setting="theme"><option value="light" ${state.settings.theme === "light" ? "selected" : ""}>浅色 · 安静书桌</option><option value="dark" ${state.settings.theme === "dark" ? "selected" : ""}>深色 · 夜间练习</option><option value="system" ${state.settings.theme === "system" ? "selected" : ""}>跟随系统</option></select></div></div></section><section class="panel"><h2>备份与迁移</h2><p class="muted" style="font-size:12px;margin-top:9px">文件备份包含练习历史、错词、设置、学习进度和听写草稿。即使未连接 GitHub，也可以随时导出或手动恢复。</p><div class="flex">${button(icon("download") + " 导出全部数据", "export", "primary")}${button(icon("upload") + " 导入数据", "import")}${button("导出错词 CSV", "export-words", "small")}</div><p class="muted" style="font-size:11px;margin-top:14px">兼容原项目 wl2 / wl3 的 {hist, wb} 备份；导入前自动下载当前数据备份。文件先在本地校验；连接 GitHub 后，导入的进度也会自动备份。</p></section><section class="panel"><h2>离线使用</h2><p class="muted" style="font-size:12px;margin-top:9px">首次联网打开后会缓存页面和全部语料。支持的浏览器可将本站添加到主屏幕。本机英语语音可离线使用；词典及在线备用发音仍需联网。</p>${button("刷新离线缓存", "update-cache", "small")}</section></div></div><section class="panel danger-zone"><h3>清空本机学习数据</h3><p class="muted" style="font-size:12px">仅清除此浏览器的数据，并断开 GitHub 备份连接；仓库中的备份保留。请先导出文件备份。</p>${button("清空数据…", "clear", "danger small")}</section>`
  );
}
function render() {
  // A paused test is no longer independent after its answer is shown in study.
  const studying = state.studyDraft;
  if (page === 'study' && studying && !studying.completed && !studying.hidden
      && state.draft && !state.draft.assisted
      && state.draft.wordIds.includes(studying.wordIds[studying.activeIndex])) {
    state.draft.assisted = true;
    persist();
    toast('已看到未完成听写中的答案，那份听写已转为巩固；已填答案仍保留。');
  }
  document.body.dataset.theme =
    state.settings.theme === "system"
      ? matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : state.settings.theme;
  const content = (
    {
      home,
      library,
      section: sectionPage,
      practice: practicePage,
      study: studyPage,
      result: resultPage,
      review: reviewPage,
      history: historyPage,
      settings: settingsPage,
    }[page] || home
  )();
  $("#app").innerHTML = shell(content);
  document.title = `${page === "practice" ? session.title + " · " : ""}听见进步 · 王陆语料库`;
}
function modal(title, body, actions = []) {
  stop();
  $("#dialog-body").innerHTML =
    `<div class="dialog-head"><h2>${title}</h2>${button(icon("close"), "close-modal", "text", 'aria-label="关闭弹窗"')}</div>${body}<div id="dialog-error" class="dialog-error" role="alert"></div><div class="dialog-actions">${actions.map((a, i) => `<button class="button ${a.primary ? "primary" : ""}" data-modal-action="${i}">${a.label}</button>`).join("")}</div>`;
  $("#dialog").showModal();
  actions.forEach((a, i) =>
    $(`[data-modal-action="${i}"]`).addEventListener("click", a.action),
  );
}
function closeModal() {
  stop();
  suppressFocusAudio = true;
  try { $("#dialog").close(); }
  finally { suppressFocusAudio = false; }
}
function download(data, name, type = "application/json") {
  const url = URL.createObjectURL(new Blob([data], { type })),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
function exportData() {
  if (session) saveDraft();
  if (storageBlocked) {
    try {
      download(
        localStorage.getItem(KEY) || "{}",
        `wanglu-original-${localDateKey()}.json`,
      );
    } catch {
      toast("浏览器禁止读取存储。");
    }
    return;
  }
  download(
    JSON.stringify(
      { app: "wanglu-personal", exportedAt: new Date().toISOString(), state },
      null,
      2,
    ),
    `wanglu-backup-${localDateKey()}.json`,
  );
  toast("备份文件已生成。");
}
function exportWords() {
  const rows = [
    [
      "单词",
      "音标",
      "释义",
      "小节",
      "错误次数",
      "模糊标记",
      "模糊次数",
      "连续答对",
      "下次复习",
      "上次填写",
    ],
    ...reviewWords("all").map((w) => [
      w.text,
      w.phonetic,
      w.meaning,
      w.sectionId,
      w.wrongCount,
      w.uncertain ? "模糊" : "清晰",
      w.uncertainCount || 0,
      w.streak,
      w.due,
      w.lastTyped,
    ]),
  ];
  const cell = (v) =>
    '"' +
    String(v ?? "")
      .replace(/^[=+@-]/, "'$&")
      .replace(/"/g, '""') +
    '"';
  download(
    "\uFEFF" + rows.map((r) => r.map(cell).join(",")).join("\r\n"),
    `wanglu-wrong-words-${localDateKey()}.csv`,
    "text/csv;charset=utf-8",
  );
}
function importDialog() {
  modal(
    "导入学习数据",
    `<p class="muted">选择本站备份文件，或粘贴原版导出的 {hist, wb} JSON。成功校验后再确认替换。</p><div class="field"><label for="import-file">JSON 备份文件（最多 20 MB）</label><input type="file" id="import-file" accept=".json,application/json"></div><div class="field"><label for="import-text">或粘贴备份内容</label><textarea id="import-text" rows="6" placeholder='{"hist":{},"wb":{}}'></textarea></div><details style="font-size:11px;margin-top:12px"><summary>如何从原项目导出？</summary><p>在原项目页面打开浏览器开发者工具的 Console，执行以下代码，然后将复制的 JSON 粘贴到上方：</p><code style="overflow-wrap:anywhere">copy(JSON.stringify({hist:JSON.parse(localStorage.getItem('wl3_hist')||localStorage.getItem('wl2_hist')||'{}'),wb:JSON.parse(localStorage.getItem('wl3_wb')||localStorage.getItem('wl2_wb')||'{}')}))</code></details>`,
    [
      { label: "取消", action: closeModal },
      {
        label: "校验并继续",
        primary: true,
        action: async () => {
          try {
            const f = $("#import-file").files[0];
            if (f && f.size > 20 * 1024 * 1024) throw Error("文件超过 20 MB。");
            const raw = f ? await f.text() : $("#import-text").value,
              next = parseBackup(raw, allWords);
            modal(
              "备份校验通过",
              `<p>将导入 ${next.history.length} 条历史记录、${Object.keys(next.reviews).length} 个错词${next.draft ? "，以及未完成草稿" : ""}。</p><p>确认后会先下载当前数据备份，再用导入数据替换本机数据。</p>`,
              [
                { label: "取消", action: closeModal },
                {
                  label: "备份并导入",
                  primary: true,
                  action: () => {
                    exportData();
                    const prior = state;
                    state = next;
                    storageBlocked = false;
                    if (!persist()) {
                      state = prior;
                      return;
                    }
                    storageMessage = "";
                    closeModal();
                    navigate("home");
                    toast("数据导入成功。");
                  },
                },
              ],
            );
          } catch (e) {
            $("#dialog-error").textContent = "无法导入：" + e.message;
          }
        },
      },
    ],
  );
}
function focusAnswer(index, { play = false, scroll = false } = {}) {
  if (!session?.words[index]) return;
  if (play) stop();
  activeIndex = index;
  suppressFocusAudio = true;
  try { $(`#answer-${index}`)?.focus({ preventScroll: true }); }
  finally { suppressFocusAudio = false; }
  if (scroll) $(`#row-${index}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  saveDraft();
  if (play) void speakRow(index);
}
async function speakRow(i) {
  if (!session || !Number.isInteger(i) || i < 0 || i >= session.words.length) return false;
  const token = ++rowPlayToken;
  activeIndex = i;
  const w = session.words[i];
  if (!w) return false;
  document
    .querySelectorAll(".dict-row.playing")
    .forEach((e) => e.classList.remove("playing"));
  const row = $(`#row-${i}`);
  row?.classList.add("playing");
  const ok = await speech.speak(w.text, state.settings);
  if (token === rowPlayToken) row?.classList.remove("playing");
  return ok;
}
async function block() {
  if (blockPlaying) {
    stop();
    return;
  }
  stop();
  blockPlaying = true;
  const token = blockToken;
  const b = $('[data-action="block"]');
  if (b) b.innerHTML = icon("pause") + " 停止连播";
  let start = session.answers.findIndex(
    (a, i) => i >= activeIndex && !a.trim(),
  );
  if (start < 0) start = session.answers.findIndex((a) => !a.trim());
  if (start < 0) start = activeIndex;
  for (
    let i = start;
    session && i < session.words.length && token === blockToken;
    i++
  ) {
    focusAnswer(i, { scroll: true });
    const ok = await speakRow(i);
    if (!ok || token !== blockToken) break;
    await new Promise((r) =>
      setTimeout(r, Number(state.settings.interval) * 1000),
    );
  }
  if (token === blockToken) {
    blockPlaying = false;
    const el = $('[data-action="block"]');
    if (el) el.innerHTML = icon("play") + " 连播";
  }
}
function align(direction) {
  if (!session) return;
  if (direction === "undo") {
    const old = alignment.pop();
    if (!old) {
      toast("没有可撤销的调整。");
      return;
    }
    session.answers = old;
  } else {
    if (direction === "down" && session.answers.at(-1)?.trim()) {
      toast("末题已有答案，插入会挤掉末题。请先复制或移走末题答案。");
      return;
    }
    alignment.push([...session.answers]);
    if (alignment.length > 20) alignment.shift();
    if (direction === "down") {
      session.answers.splice(activeIndex, 0, "");
      session.answers.pop();
    } else {
      session.answers.splice(activeIndex, 1);
      session.answers.push("");
    }
  }
  stop();
  saveDraft();
  render();
  $(`#answer-${activeIndex}`)?.focus();
}
function openSection(id) {
  if (!sections.some((s) => s.id === id)) {
    toast("这是旧版自定义词条，可以从错词本直接复习。");
    return;
  }
  currentSection = id;
  navigate("section");
}
function startSection(mode, study = false) {
  const s = sections.find((s) => s.id === currentSection),
    size = $("#batch-size").value,
    start = size === "all" ? 1 : Number($("#range-start").value),
    end =
      size === "all"
        ? s.words.length
        : size === "range"
          ? Number($("#range-end").value)
          : Math.min(s.words.length, start + Number(size) - 1);
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 1 ||
    end < start ||
    end > s.words.length
  ) {
    toast("请填写有效的词序范围。");
    return;
  }
  (study ? beginStudy : begin)(
    s.words.slice(start - 1, end),
    `第 ${s.id} 节 · ${start}–${end} 词`,
    s.id,
    mode,
  );
}
function resultWords(results) {
  return results
    .map(
      (r) =>
        wordById.get(r.wordId) || {
          id: r.wordId,
          text: r.text,
          meaning: r.meaning,
          phonetic: r.phonetic,
          sectionId: r.sectionId,
        },
    )
    .filter((w) => w.text);
}
const actions = {
  "library-link": () => navigate("library"),
  "review-link": () => navigate("review"),
  "history-link": () => navigate("history"),
  section: (el) => openSection(el.dataset.id),
  daily: () => {
    if (state.draft) { resume(); return; }
    if (state.studyDraft) { resumeStudy(); return; }
    const today = computeStats(state.history).todayCount,
      count = Math.max(20, Math.min(50, state.settings.dailyGoal - today)),
      seen = new Set(
        state.history.flatMap((h) => h.results.map((r) => r.wordId)),
      ),
      s =
        sections.find((s) => s.words.some((w) => !seen.has(w.id))) ||
        sections[0],
      words = s.words.filter((w) => !seen.has(w.id));
    beginStudy(
      (words.length ? words : s.words).slice(0, count),
      `今日练习 · 第 ${s.id} 节`,
      s.id,
    );
  },
  resume,
  "continue-section": el => continueSection(el.dataset.id),
  "continue-study": el => continueSection(el.dataset.id, true),
  "toggle-uncertain": el => toggleUncertain(Number(el.dataset.index)),
  "clear-uncertain": el => {
    const entry = state.reviews[el.dataset.id];
    if (!entry) return;
    entry.uncertain = false;
    persist();
    render();
    toast("已取消当前模糊标记，历史模糊次数保留。");
  },
  "retry-uncertain": () => begin(resultWords(lastResult.results.filter(r => r.uncertain)), lastResult.title + " · 模糊词复练", lastResult.sectionId, "review", false, { assisted: true }),
  "start-section": () => startSection("normal"),
  "start-study": () => startSection("normal", true),
  "study-resume": resumeStudy,
  "study-next": () => moveStudy('next'),
  "study-prev": () => moveStudy('prev'),
  "study-restart": () => moveStudy('restart'),
  "study-replay": () => { stop(); focusStudy(); return playStudy(); },
  "study-uncertain": () => { stop(); toggleStudyUncertain(); },
  "study-hide": () => {
    stop(); const d = state.studyDraft; d.hidden = !d.hidden;
    if (d.hidden) d.answers[d.activeIndex] = '';
    persist(); render(); focusStudy();
  },
  "study-block": studyBlock,
  "study-test": studyTest,
  "study-next-batch": () => {
    const batch = nextStudyBatch();
    if (batch) beginStudy(batch.words, batch.title, batch.sectionId, 'normal', true);
  },
  "study-uncertain-only": () => {
    const d = state.studyDraft;
    beginStudy(wordsForDraft(d).filter((_, i) => d.uncertain[i]), d.title + ' · 模糊词', d.sectionId, 'review', true);
  },
  "study-review": () => beginStudy(filteredReviews(), '错词与模糊词学习', reviewChapter || 'review', 'review'),
  "study-result": () => beginStudy(resultWords(lastResult.results.filter(r => !r.ok || r.uncertain)), lastResult.title + ' · 错词与模糊词', lastResult.sectionId, 'review'),
  "start-shuffle": () => startSection("shuffle"),
  "save-exit": () => navigate("home"),
  replay: () => focusAnswer(activeIndex, { play: true }),
  speak: el => focusAnswer(Number(el.dataset.index), { play: true }),
  "speak-word": (el) => {
    stop();
    speech.speak(el.dataset.text, state.settings);
  },
  block,
  auto: () => {
    state.settings.autoPlay = !state.settings.autoPlay;
    persist();
    const b = $('[data-action="auto"]');
    b.textContent = "聚焦播放：" + (state.settings.autoPlay ? "开" : "关");
    b.classList.toggle("soft", state.settings.autoPlay);
  },
  "audio-settings": () =>
    modal("发音设置", audioFields(), [
      { label: "完成", primary: true, action: closeModal },
    ]),
  "test-voice": () => speech.speak("accommodation", state.settings),
  "align-down": () => align("down"),
  "align-up": () => align("up"),
  "align-undo": () => align("undo"),
  check: () => check(),
  finish: () => finish(),
  retry: () =>
    begin(
      resultWords(lastResult.results),
      lastResult.title,
      lastResult.sectionId,
      lastResult.mode, false, { assisted: true },
    ),
  "retry-shuffle": () =>
    begin(
      resultWords(lastResult.results),
      lastResult.title,
      lastResult.sectionId,
      "shuffle", false, { assisted: true },
    ),
  "retry-wrong": () =>
    begin(
      resultWords(lastResult.results.filter((r) => !r.ok)),
      lastResult.title + " · 错词复练",
      lastResult.sectionId,
      "review", false, { assisted: true },
    ),
  "history-detail": (el) => {
    lastResult = state.history.find((h) => h.id === el.dataset.id);
    resultFilter = "wrong";
    navigate("result");
  },
  "review-selected": () =>
    begin(
      filteredReviews(),
      reviewFilter === "uncertain" ? "模糊词专项复习" : "错词与模糊词复习",
      reviewChapter || "review",
      "review",
    ),
  "review-due": () =>
    begin(reviewWords("due"), "今日到期复习", "review", "review"),
  "preview-words": () => {
    const s = sections.find((s) => s.id === currentSection);
    modal(
      `第 ${esc(s.id)} 节词表`,
      `<div class="word-preview">${s.words.map((w, i) => `<div class="flex space" style="border-bottom:1px solid var(--line);padding:9px 0"><span>${i + 1}. <b>${esc(w.text)}</b> <span class="muted">${esc(w.meaning)}</span></span>${button(icon("sound"), "speak-word", "text small", `data-text="${esc(w.text)}" aria-label="播放 ${esc(w.text)}"`)}</div>`).join("")}</div>`,
      [{ label: "关闭", action: closeModal }],
    );
  },
  goal: () =>
    modal(
      "给今天定一个小目标",
      `<div class="field"><label for="goal-input">每日目标（1–1000 词）</label><input id="goal-input" type="number" min="1" max="1000" value="${state.settings.dailyGoal}"></div>`,
      [
        {
          label: "保存目标",
          primary: true,
          action: () => {
            const n = Number($("#goal-input").value);
            if (!Number.isInteger(n) || n < 1 || n > 1000) {
              $("#dialog-error").textContent = "请输入 1–1000 的整数。";
              return;
            }
            state.settings.dailyGoal = n;
            persist();
            closeModal();
            render();
          },
        },
      ],
    ),
  'backup-settings': () => navigate('settings'),
  'backup-login': () => {
    if(storageBlocked){toast('请先导出无法读取的本地数据，再连接备份。');return;}
    return backupClient.login();
  },
  'backup-now': () => {if(session)saveDraft();return backupClient.flush();},
  'backup-check': () => backupClient.checkRemote(),
  'backup-logout': () => {backupClient.logout();toast('已退出 GitHub 登录，本机练习记录保留。');},
  'backup-conflict': backupConflictDialog,
  export: exportData,
  "export-words": exportWords,
  import: importDialog,
  "close-modal": closeModal,
  clear: () =>
    modal(
      "清空本机学习数据",
      `<p>此操作会移除全部历史、错词、草稿和偏好。请先导出备份。</p><label class="field" for="clear-confirm">输入「清空」以继续<input id="clear-confirm" placeholder="清空" autocomplete="off"></label>`,
      [
        { label: "取消", action: closeModal },
        { label: "导出备份", action: exportData },
        {
          label: "确认清空",
          action: () => {
            if ($("#clear-confirm").value !== "清空") {
              $("#dialog-error").textContent = "请输入「清空」。";
              return;
            }
            backupClient?.logout();
            const previous = state;
            state = createInitialState();
            storageBlocked = false;
            if (!persist()) {
              state = previous;
              return;
            }
            storageMessage = "";
            closeModal();
            navigate("home");
            toast("本机学习数据已清空。");
          },
        },
      ],
    ),
  "update-cache": async () => {
    const r = await navigator.serviceWorker?.getRegistration();
    if (!r) {
      toast("离线缓存尚未就绪，请联网刷新页面。");
      return;
    }
    await r.update();
    toast("已检查更新；新版本将在所有本站标签页关闭后启用。");
  },
};
document.addEventListener("click", (e) => {
  const el = e.target.closest("button,a");
  if (!el) return;
  if (el.dataset.nav) {
    e.preventDefault();
    navigate(el.dataset.nav);
    return;
  }
  if (el.dataset.chapter) {
    chapterFilter = el.dataset.chapter;
    render();
    return;
  }
  if (el.dataset.reviewFilter) {
    reviewFilter = el.dataset.reviewFilter;
    render();
    return;
  }
  if (el.dataset.resultFilter) {
    resultFilter = el.dataset.resultFilter;
    render();
    return;
  }
  if (el.dataset.action && actions[el.dataset.action]) {
    e.preventDefault();
    Promise.resolve(actions[el.dataset.action](el)).catch((err) => {
      console.error(err);
      toast("操作未完成：" + err.message);
    });
  }
});
document.addEventListener("input", (e) => {
  const el = e.target;
  if (el.id === "study-copy" && page === 'study') {
    if (studyPlaying) stop();
    state.studyDraft.answers[state.studyDraft.activeIndex] = el.value;
    persist();
  }
  if (el.dataset.answer !== undefined && session) {
    const i = Number(el.dataset.answer);
    session.answers[i] = el.value;
    activeIndex = i;
    const row = $(`#row-${i}`);
    row.classList.remove("good", "bad");
    row.querySelector(".answer-feedback").hidden = true;
    $("#answered-count").textContent = session.answers.filter((a) =>
      a.trim(),
    ).length;
    saveDraft();
  }
  if (el.id === "corpus-search") {
    const q = el.value.trim().toLowerCase(),
      matches = q
        ? allWords.filter((w) =>
            `${w.text} ${w.meaning}`.toLowerCase().includes(q),
          )
        : [];
    $("#search-results").innerHTML = q
      ? `<div class="search-results"><p class="muted">找到 ${matches.length} 条${matches.length > 60 ? "，显示前 60 条" : ""}</p>${
          matches.length
            ? `<div class="table-wrap"><table><tbody>${matches
                .slice(0, 60)
                .map(
                  (w) =>
                    `<tr><td><b>${esc(w.text)}</b><span class="sub">${esc(w.meaning)}</span></td><td>第 ${w.sectionId} 节 · ${w.index}</td><td>${button(icon("sound"), "speak-word", "text small", `data-text="${esc(w.text)}" aria-label="播放 ${esc(w.text)}"`)}</td><td>${button("练习本节", "section", "small", `data-id="${w.sectionId}"`)}</td></tr>`,
                )
                .join("")}</tbody></table></div>`
            : '<div class="empty">没有找到匹配的词条。</div>'
        }</div>`
      : "";
  }
  if (el.id === "review-search") {
    reviewSearch = el.value;
    $("#review-table").innerHTML = reviewTable();
  }
});
document.addEventListener("change", (e) => {
  const el = e.target,
    key = el.dataset.setting;
  if (key) {
    let value = el.type === "checkbox" ? el.checked : el.value;
    if (["rate", "repeat", "interval", "dailyGoal"].includes(key))
      value = Number(value);
    if (
      key === "dailyGoal" &&
      (!Number.isInteger(value) || value < 1 || value > 1000)
    ) {
      el.value = state.settings.dailyGoal;
      toast("每日目标应为 1–1000 的整数。");
      return;
    }
    state.settings[key] = value;
    persist();
    if (key === "theme") render();
  }
  if (el.id === "review-sort") {
    reviewSort = el.value;
    $("#review-table").innerHTML = reviewTable();
  }
  if (el.id === "review-chapter") {
    reviewChapter = el.value;
    $("#review-table").innerHTML = reviewTable();
  }
  if (el.id === "history-section") {
    historySection = el.value;
    render();
  }
});
document.addEventListener("focusin", (e) => {
  if (e.target.dataset.answer !== undefined && session) {
    activeIndex = Number(e.target.dataset.answer);
    if (blockPlaying && !suppressFocusAudio) stop();
    if (state.settings.autoPlay && !blockPlaying && !suppressFocusAudio) {
      stop();
      speakRow(activeIndex);
    }
    if (!suppressFocusAudio) saveDraft();
  }
});
document.addEventListener("keydown", e => {
  if (page === 'study' && state.studyDraft && !state.studyDraft.completed && !$('#dialog').open && !e.isComposing && e.keyCode !== 229) {
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
    const replay = (e.key === 'F2' && plain) || (e.code === 'KeyR' && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey);
    const mark = e.key === 'F4' && plain;
    const next = e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey && e.target.id === 'study-copy';
    if (e.key === 'Escape') { stop(); return; }
    if (replay || mark || next) {
      e.preventDefault(); if (e.repeat) return;
      if (replay) { stop(); void playStudy(); }
      else if (mark) { stop(); toggleStudyUncertain(); }
      else moveStudy(e.shiftKey ? 'prev' : 'next');
    }
    return;
  }
  if (!session || $('#dialog').open || e.isComposing || e.keyCode === 229) return;
  const plain = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
  const answer = e.target.dataset.answer !== undefined;
  const replay = (e.key === 'F2' && plain)
    || (e.code === 'KeyR' && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey);
  const mark = e.key === 'F4' && plain;
  const advance = e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey;
  if (e.key === 'Escape') { stop(); return; }
  if ((replay || mark || advance) && e.repeat) { e.preventDefault(); return; }
  if (replay) { e.preventDefault(); focusAnswer(activeIndex, { play: true }); return; }
  if (mark) { e.preventDefault(); toggleUncertain(); return; }
  if (advance && answer) {
    e.preventDefault();
    stop();
    const next = Number(e.target.dataset.answer) + (e.shiftKey ? -1 : 1);
    if (next >= 0 && next < session.words.length) focusAnswer(next, { play: true, scroll: true });
    else if (next < 0) toast('已经是第一题。');
    else {
      $('[data-action="finish"]')?.focus();
      toast('已到最后一题，可以检查或提交听写。');
    }
  }
});
$("#dialog").addEventListener("cancel", e => {
  e.preventDefault();
  closeModal();
});
window.addEventListener("beforeunload", () => {
  saveDraft();
  speech.stop();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    saveDraft();
    stop();
  }
});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (state.settings.theme === "system")
    document.body.dataset.theme = matchMedia("(prefers-color-scheme: dark)")
      .matches
      ? "dark"
      : "light";
});
window.speechSynthesis?.addEventListener("voiceschanged", () => {
  const el = $("#set-voiceURI");
  if (el) {
    const selected = state.settings.voiceURI;
    el.innerHTML =
      '<option value="">自动选择</option>' +
      speech
        .listVoices()
        .map(
          (v) =>
            `<option value="${esc(v.voiceURI)}" ${selected === v.voiceURI ? "selected" : ""}>${esc(v.name)} (${esc(v.lang)})</option>`,
        )
        .join("");
  }
});
backupClient = new BackupClient({
  serviceUrl: BACKUP_SERVICE_URL,
  getState: () => structuredClone(state),
  applyState: next => {
    if (storageBlocked) throw new Error('本地数据不可读，请先导出原始数据。');
    const validated = parseBackup(next, allWords);
    // Persist before replacing in-memory progress so a quota error never loses it.
    localStorage.setItem(KEY, JSON.stringify(validated));
    stop(); session = null; startedSegment = 0;
    state = validated; page = 'home'; render();
    toast('已从 GitHub 恢复进度。');
  },
  onStatus: updateBackupStatus,
});
render();
if (!storageBlocked) backupClient.init();
function checkStudyDay() {
  const next=studyDateKey();
  if(next!==visibleStudyDay){
    visibleStudyDay=next;
    if(page==='home'||page==='history')render();
    if(!storageBlocked)backupClient.checkRemote();
  }
}
setInterval(checkStudyDay,60000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)checkStudyDay();});
if ("serviceWorker" in navigator)
  navigator.serviceWorker.register("./sw.js").catch(() => {});
