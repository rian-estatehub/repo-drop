import { buildPlan, captureDrop, readCaptured, readFileInput, sanitizeName, nextFreeName, formatSize } from './lib/intake.js';
import { createClient, resolveBase, uploadProject } from './lib/github.js';

const TOKEN_KEY = 'rd_token';
const card = document.querySelector('#card');
const inner = document.querySelector('#card-inner');
const pill = document.querySelector('#pill');
const notice = document.querySelector('#notice');
const pickFiles = document.querySelector('#pick-files');
const pickFolder = document.querySelector('#pick-folder');

const app = {
  token: null,
  user: null,
  client: null,
  plan: null,
  name: '',
  pages: true,
  view: 'boot',
  busy: false,
  checkId: 0,
  taken: false,
  empty: false,
  popup: null,
  tabReady: false
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const esc = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const $ = (selector) => document.querySelector(selector);

const GH_PATH =
  'M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56v-2c-3.2.7-3.87-1.54-3.87-1.54-.52-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.78 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.42-2.69 5.39-5.25 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z';

function readToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY) || app.token;
  } catch (err) {
    return app.token;
  }
}

function storeToken(token) {
  app.token = token;
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch (err) {
    return;
  }
}

function takeHash() {
  const raw = location.hash.slice(1);
  if (!raw) return {};
  const params = new URLSearchParams(raw);
  const token = params.get('token');
  const error = params.get('error');
  if (token || error) history.replaceState(null, '', location.pathname + location.search);
  if (token) storeToken(token);
  return { error };
}

let noticeTimer = 0;
function notify(text, tone = 'warn', ms = 6500) {
  clearTimeout(noticeTimer);
  if (!text) {
    notice.dataset.show = 'false';
    return;
  }
  notice.textContent = text;
  notice.dataset.tone = tone;
  notice.dataset.show = 'true';
  if (ms) noticeTimer = setTimeout(() => (notice.dataset.show = 'false'), ms);
}

const brandHtml = '<div class="pill-brand"><span class="brand-mark"></span>repo-drop</div>';

function renderPill() {
  if (app.user) {
    pill.innerHTML = `${brandHtml}<div class="pill-slot"><div class="pill-user"><img class="avatar" src="${esc(app.user.avatar_url || '')}" alt=""><span class="pill-login">${esc(app.user.login)}</span></div><button type="button" class="pill-signout" data-act="signout">Sign out</button></div>`;
  } else {
    pill.innerHTML = `${brandHtml}<div class="pill-slot"><span class="pill-hint">Public repos only</span></div>`;
  }
}

const folderSvg =
  '<svg class="folder" viewBox="0 0 84 70" fill="none" aria-hidden="true"><path d="M6 10a6 6 0 0 1 6-6h18.5a6 6 0 0 1 4.6 2.2L40 12h32a6 6 0 0 1 6 6v40a6 6 0 0 1-6 6H12a6 6 0 0 1-6-6Z" fill="#1b1b1f" stroke="rgba(255,255,255,0.14)"/><g class="folder-front"><path d="M6 26a6 6 0 0 1 6-6h60a6 6 0 0 1 6 6v32a6 6 0 0 1-6 6H12a6 6 0 0 1-6-6Z" fill="#26262c" stroke="rgba(255,255,255,0.2)"/><path d="M12 20.5h60" stroke="rgba(255,255,255,0.22)" stroke-linecap="round"/></g></svg>';

const artHtml = `<div class="drop-art" aria-hidden="true"><i class="ring ring-3"></i><i class="ring ring-2"></i><i class="ring ring-1"></i>${folderSvg}</div>`;

function viewBoot() {
  return '<div class="boot" aria-busy="true"><div class="shimmer" style="width:46%"></div><div class="shimmer" style="width:72%"></div><div class="shimmer" style="width:34%"></div></div>';
}

function viewSignedOut() {
  return `<div class="drop"><div class="drop-copy"><p class="drop-lead">Sign in with GitHub to turn a folder, zip, or HTML file into a public repo.</p><div class="signin-actions"><a class="btn-primary" id="signin-btn" href="/api/login"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${GH_PATH}"/></svg>Continue with GitHub</a><p class="signin-note">Public repos only. Your token stays in this tab.</p></div></div>${artHtml}</div>`;
}

function viewIdle() {
  return `<div class="drop"><div class="drop-copy"><p class="drop-lead">Drop a project folder, zip, or HTML file to deploy instantly.</p><p class="drop-sub">Or <button type="button" class="text-link" data-act="browse-files">browse files</button> to upload or <button type="button" class="text-link" data-act="browse-folder">choose a folder</button>.</p></div>${artHtml}</div>`;
}

function pagesSub(name, on) {
  if (!on) return 'Repo only. No website.';
  return `Live at ${esc(app.user.login.toLowerCase())}.github.io/${esc(name)}`;
}

function viewConfirm() {
  const plan = app.plan;
  const count = plan.files.length;
  const skipped = plan.skipped;
  const shown = skipped.slice(0, 200);
  const more = skipped.length - shown.length;
  const skippedHtml = skipped.length
    ? `<div><button type="button" class="skipped-toggle" id="skipped-toggle" data-act="toggle-skipped" aria-expanded="false" aria-controls="skipped-wrap"><svg viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M4 2l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>${skipped.length} ${skipped.length === 1 ? 'item' : 'items'} skipped</button><div class="skipped-wrap" id="skipped-wrap" data-open="false"><div class="skipped-clip"><ul class="skipped-list">${shown.map((s) => `<li><span class="path">${esc(s.path)}</span><span class="why">${esc(s.reason)}</span></li>`).join('')}${more > 0 ? `<li><span class="path">and ${more} more</span><span class="why"></span></li>` : ''}</ul></div></div></div>`
    : '';
  return `<form class="confirm" id="confirm-form" autocomplete="off" novalidate>
<div class="confirm-head"><div class="stack-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="#f3e3c8" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 3 7.5 12 12l9-4.5L12 3Z"/><path d="m3 12 9 4.5 9-4.5"/><path d="m3 16.5 9 4.5 9-4.5"/></svg></div><div class="confirm-meta"><p class="confirm-title" id="confirm-title">${count} ${count === 1 ? 'file' : 'files'}<span class="sep">&middot;</span>${formatSize(plan.total)}</p><p class="confirm-sub">${esc(plan.single ? `${plan.files[0].originalPath} becomes index.html` : plan.label || 'Your project')}</p></div><button type="button" class="btn-change" data-act="cancel">Change</button></div>
<div><label class="field-label" for="name-input">Repository name</label><div class="field-box"><span class="field-prefix">${esc(app.user.login)} /</span><input class="field-input" id="name-input" type="text" value="${esc(app.name)}" spellcheck="false" autocapitalize="off" autocorrect="off" maxlength="100" aria-describedby="name-status"></div><p class="status" id="name-status" data-tone="checking" aria-live="polite"><span class="status-dot"></span><span id="status-text">Checking the name</span></p></div>
<label class="switch-row" for="pages-toggle"><span class="switch-copy"><span class="switch-title">GitHub Pages</span><span class="switch-sub" id="pages-sub">${pagesSub(app.name, app.pages)}</span></span><input class="switch-input" id="pages-toggle" type="checkbox" role="switch" ${app.pages ? 'checked' : ''}><span class="switch-track" aria-hidden="true"></span></label>
${skippedHtml}
<div class="confirm-actions"><button type="submit" class="btn-primary" id="upload-btn">Upload</button></div>
</form>`;
}

function viewProgress(name) {
  return `<div class="progress"><p class="step-label" id="step-label">Starting</p><p class="progress-title">${esc(app.user.login)}/${esc(name)}</p><div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" id="bar"><div class="bar-fill" id="bar-fill"></div></div><p class="progress-detail" id="progress-detail">Opening a tab for the result</p></div>`;
}

function viewDone(result, opened, targetUrl, note) {
  const live = result.pagesStatus === 'built' && result.pagesUrl;
  const count = app.plan.files.length;
  const linkRow = (kind, url) =>
    `<a class="link-row" href="${esc(url)}" target="_blank" rel="noopener"><span class="link-text"><span class="link-kind">${kind}</span><span class="link-url">${esc(url)}</span></span><span class="link-arrow" aria-hidden="true">&#8599;</span></a>`;
  return `<div class="done"><div class="done-head"><div class="done-mark" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></div><div><p class="done-title">${live ? 'It is live.' : 'Repo created.'}</p><p class="done-sub">${count} ${count === 1 ? 'file' : 'files'} &middot; one commit &middot; ${esc(result.owner)}/${esc(result.name)}</p></div></div>${note ? `<p class="done-note">${esc(note)}</p>` : ''}<div class="links">${live ? linkRow('Live site', result.pagesUrl) : ''}${linkRow('Repository', result.repoUrl)}</div><div class="done-actions">${opened ? '' : `<a class="btn-primary btn-primary-big" id="open-btn" href="${esc(targetUrl)}" target="_blank" rel="noopener">Open ${live ? 'site' : 'repo'}</a>`}<button type="button" class="${opened ? 'btn-primary' : 'btn-ghost'}" id="again-btn" data-act="drop-another">Drop another</button></div></div>`;
}

function viewProblem(title, text, actions) {
  return `<div class="problem"><p class="problem-title">${esc(title)}</p><p class="problem-text">${esc(text)}</p><div class="problem-actions">${actions}</div></div>`;
}

let queue = Promise.resolve();
let heightTimer = 0;

function morph(html, state, after) {
  queue = queue.then(() => doMorph(html, state, after)).catch(() => undefined);
  return queue;
}

async function doMorph(html, state, after) {
  const animate = !reduced();
  const from = card.offsetHeight;
  if (animate && inner.innerHTML.trim()) {
    inner.classList.remove('in');
    inner.classList.add('out');
    await wait(160);
  }
  inner.classList.remove('out');
  inner.innerHTML = html;
  card.dataset.state = state;
  app.view = state;
  if (animate) {
    clearTimeout(heightTimer);
    card.style.height = 'auto';
    const to = card.offsetHeight;
    card.style.height = `${from}px`;
    void card.offsetHeight;
    card.style.height = `${to}px`;
    inner.classList.remove('in');
    void inner.offsetWidth;
    inner.classList.add('in');
    heightTimer = setTimeout(() => (card.style.height = ''), 480);
  }
  if (after) after();
}

function accepting() {
  return !app.busy && app.user && (app.view === 'idle' || app.view === 'confirm');
}

function setDrag(on) {
  card.dataset.drag = on && accepting() ? 'true' : 'false';
}

const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
let dragDepth = 0;

document.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth += 1;
  setDrag(true);
});

document.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  try {
    e.dataTransfer.dropEffect = 'copy';
  } catch (err) {
    return;
  }
});

document.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) setDrag(false);
});

document.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  setDrag(false);
  if (!app.user) {
    notify('Sign in with GitHub first.');
    return;
  }
  if (!accepting()) return;
  const captured = captureDrop(e.dataTransfer);
  ingest(() => readCaptured(captured));
});

async function ingest(read) {
  if (app.busy) return;
  app.busy = true;
  try {
    notify('Reading your files', 'info', 0);
    const source = await read();
    const plan = buildPlan(source);
    if (!plan.files.length) {
      notify(plan.skipped.length ? `Nothing to upload. ${plan.skipped.length} items were skipped.` : 'Nothing to upload. That looks empty.');
      return;
    }
    notify('');
    app.plan = plan;
    app.name = plan.name;
    app.taken = false;
    app.empty = false;
    await showConfirm();
  } catch (err) {
    notify(err && err.message ? err.message : 'Could not read those files.');
  } finally {
    app.busy = false;
  }
}

const exists = (name) => app.client.repoExists(app.user.login, name);

function setStatus(tone, text, suggestion) {
  const status = $('#name-status');
  if (!status) return;
  status.dataset.tone = tone;
  status.innerHTML = `<span class="status-dot"></span><span id="status-text">${esc(text)}</span>${suggestion ? `<button type="button" class="chip" data-act="use-name" data-name="${esc(suggestion)}">Use ${esc(suggestion)}</button>` : ''}`;
}

function syncUploadButton() {
  const btn = $('#upload-btn');
  if (btn) btn.disabled = app.taken || app.empty;
}

function updatePagesSub() {
  const sub = $('#pages-sub');
  const input = $('#name-input');
  if (sub && input) sub.innerHTML = pagesSub(input.value.trim() ? sanitizeName(input.value) : app.name, app.pages);
}

async function showConfirm() {
  await morph(viewConfirm(), 'confirm', () => {
    const btn = $('#upload-btn');
    if (btn) btn.focus({ preventScroll: true });
  });
  resolveInitialName();
}

async function resolveInitialName() {
  const id = (app.checkId += 1);
  const wanted = app.name;
  try {
    const free = await nextFreeName(wanted, exists);
    if (id !== app.checkId) return;
    const input = $('#name-input');
    if (!input) return;
    if (free !== wanted) {
      input.value = free;
      app.name = free;
      setStatus('free', `${wanted} is taken on your account, so this starts as ${free}`);
    } else {
      setStatus('free', `${free} is free`);
    }
    app.taken = false;
    syncUploadButton();
    updatePagesSub();
  } catch (err) {
    if (id !== app.checkId) return;
    if (err.status === 401) return expire();
    setStatus('idle', 'Could not check the name. GitHub will tell you if it is taken.');
  }
}

let nameTimer = 0;
function onNameInput() {
  const input = $('#name-input');
  if (!input) return;
  clearTimeout(nameTimer);
  const raw = input.value.trim();
  updatePagesSub();
  if (!raw) {
    app.empty = true;
    app.taken = false;
    syncUploadButton();
    setStatus('idle', 'Give the repository a name');
    return;
  }
  app.empty = false;
  setStatus('checking', 'Checking the name');
  nameTimer = setTimeout(checkTyped, 350);
}

async function checkTyped() {
  const input = $('#name-input');
  if (!input || !input.value.trim()) return;
  const id = (app.checkId += 1);
  const clean = sanitizeName(input.value);
  const changed = clean !== input.value.trim();
  try {
    const taken = await exists(clean);
    if (id !== app.checkId) return;
    if (taken) {
      app.taken = true;
      syncUploadButton();
      setStatus('taken', `${clean} is taken on your account.`);
      const suggestion = await nextFreeName(clean, exists);
      if (id !== app.checkId) return;
      setStatus('taken', `${clean} is taken on your account.`, suggestion);
    } else {
      app.taken = false;
      syncUploadButton();
      setStatus('free', changed ? `${clean} is free, and that is the name it will get` : `${clean} is free`);
    }
  } catch (err) {
    if (id !== app.checkId) return;
    if (err.status === 401) return expire();
    app.taken = false;
    syncUploadButton();
    setStatus('idle', 'Could not check the name. GitHub will tell you if it is taken.');
  }
}

function tabHtml(title) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>repo-drop &middot; ${esc(title)}</title><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500&display=swap"><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#050505;background-image:radial-gradient(800px 420px at 50% -8%,rgba(243,227,200,.07),transparent 70%);color:#f2f2f3;font-family:Outfit,ui-sans-serif,system-ui,sans-serif;-webkit-font-smoothing:antialiased}main{width:min(520px,100% - 32px);animation:rise .7s cubic-bezier(.22,1,.36,1) both}@keyframes rise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}p{margin:0}.eyebrow{font-size:12px;font-weight:500;letter-spacing:.2em;text-transform:uppercase;color:#8e8e93;display:flex;align-items:center;gap:10px}.dot{width:6px;height:6px;border-radius:50%;background:#f3e3c8;box-shadow:0 0 0 3px rgba(243,227,200,.12)}h1{margin:14px 0 22px;font-size:34px;font-weight:500;letter-spacing:-.03em;line-height:1.1;overflow-wrap:anywhere}.bar{height:4px;border-radius:999px;background:#1a1a1d;overflow:hidden}.fill{height:100%;width:0;border-radius:999px;background:linear-gradient(90deg,#cdb78f,#fff);transition:width .5s cubic-bezier(.22,1,.36,1)}.detail{margin-top:14px;font-size:14px;color:#8e8e93}@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}</style></head><body><main><p class="eyebrow"><span class="dot"></span><span id="tab-step">Starting</span></p><h1>${esc(title)}</h1><div class="bar"><div class="fill" id="tab-fill"></div></div><p class="detail" id="tab-detail">Getting ready</p></main></body></html>`;
}

function tabWrite(tab, title) {
  try {
    tab.document.open();
    tab.document.write(tabHtml(title));
    tab.document.close();
    app.tabReady = true;
  } catch (err) {
    app.tabReady = false;
  }
}

function tabUpdate(step, detail, pct) {
  const tab = app.popup;
  if (!tab || tab.closed || !app.tabReady) return;
  try {
    const doc = tab.document;
    const s = doc.getElementById('tab-step');
    const d = doc.getElementById('tab-detail');
    const f = doc.getElementById('tab-fill');
    if (s) s.textContent = step;
    if (d) d.textContent = detail;
    if (f) f.style.width = `${pct}%`;
  } catch (err) {
    app.tabReady = false;
  }
}

function setProgress(step, detail, pct) {
  const rounded = Math.max(0, Math.min(100, Math.round(pct)));
  const label = $('#step-label');
  const text = $('#progress-detail');
  const fill = $('#bar-fill');
  const bar = $('#bar');
  if (label) label.textContent = step;
  if (text) text.textContent = detail;
  if (fill) fill.style.width = `${rounded}%`;
  if (bar) bar.setAttribute('aria-valuenow', String(rounded));
  tabUpdate(step, detail, rounded);
}

const STAGES = {
  repo: ['Creating the repository', 'Making a new public repo on your account', 4],
  tree: ['Building the file tree', 'Laying out every path', 82],
  commit: ['Writing the commit', 'One commit, Initial upload', 87],
  ref: ['Pointing main at it', 'Replacing the starter commit', 91],
  pages: ['Publishing to GitHub Pages', 'Waiting for the first build', 93]
};

function startUpload() {
  if (app.busy || !app.user || app.view !== 'confirm') return;
  const input = $('#name-input');
  const raw = input ? input.value.trim() : '';
  if (!raw || app.taken) return;
  const name = sanitizeName(raw);
  let tab = null;
  try {
    tab = window.open('', '_blank');
  } catch (err) {
    tab = null;
  }
  app.busy = true;
  app.name = name;
  app.popup = tab;
  app.tabReady = false;
  if (tab) tabWrite(tab, `${app.user.login}/${name}`);
  runUpload(name);
}

async function runUpload(name) {
  await morph(viewProgress(name), 'progress');
  setProgress(...STAGES.repo);
  try {
    const result = await uploadProject({
      client: app.client,
      name,
      files: app.plan.files,
      pages: app.pages,
      onStage: (stage) => {
        if (STAGES[stage]) setProgress(...STAGES[stage]);
      },
      onProgress: (done, total) => {
        setProgress('Uploading files', `${done} of ${total} files`, 8 + (done / Math.max(1, total)) * 70);
      },
      onPagesTick: (elapsed, limit) => {
        setProgress('Publishing to GitHub Pages', `Building the site, ${Math.round(elapsed / 1000)} s`, 93 + (elapsed / limit) * 6);
      }
    });
    await finish(result);
  } catch (err) {
    fail(err);
  }
}

async function finish(result) {
  setProgress('Done', 'Opening the result', 100);
  await wait(reduced() ? 0 : 520);
  const live = result.pagesStatus === 'built' && result.pagesUrl;
  const target = live ? result.pagesUrl : result.repoUrl;
  let note = '';
  if (result.pagesStatus === 'timeout') note = `Pages is still building. Your site will appear at ${result.pagesUrl} in a minute or two.`;
  if (result.pagesStatus === 'errored') note = 'GitHub Pages reported a build error. Check the Pages settings of the repo.';
  if (result.pagesStatus === 'failed') note = `Pages could not be switched on: ${result.pagesError}`;
  let opened = false;
  const tab = app.popup;
  if (tab && !tab.closed) {
    try {
      tab.location.href = target;
      opened = true;
    } catch (err) {
      opened = false;
    }
  }
  app.popup = null;
  app.busy = false;
  await morph(viewDone(result, opened, target, note), 'done', () => {
    const el = $('#open-btn') || $('#again-btn');
    if (el) el.focus({ preventScroll: true });
  });
}

function fail(err) {
  app.busy = false;
  if (err && err.status === 401) return expire();
  const message = err && err.message ? err.message : 'Something went wrong.';
  tabUpdate('Stopped', message, 0);
  app.popup = null;
  const nameTaken = err && err.status === 422;
  morph(
    viewProblem(
      nameTaken ? 'That name is taken' : 'That did not go through',
      nameTaken ? `${app.name} already exists on your account. Pick another name.` : message,
      '<button type="button" class="btn-primary" data-act="retry">Back to the name</button><button type="button" class="btn-ghost" data-act="drop-another">Start over</button>'
    ),
    'problem'
  );
}

function expire() {
  storeToken(null);
  app.user = null;
  app.client = null;
  app.busy = false;
  renderPill();
  morph(viewSignedOut(), 'signedout');
  notify('Your GitHub session expired. Sign in again.');
}

function showIdle() {
  app.plan = null;
  app.taken = false;
  app.empty = false;
  app.busy = false;
  return morph(viewIdle(), 'idle');
}

function signOut() {
  storeToken(null);
  app.user = null;
  app.client = null;
  app.plan = null;
  app.busy = false;
  notify('');
  renderPill();
  morph(viewSignedOut(), 'signedout');
}

card.addEventListener('click', (e) => {
  const target = e.target.closest('[data-act]');
  if (!target) return;
  const act = target.dataset.act;
  if (act === 'reload') location.reload();
  if (act === 'browse-files') pickFiles.click();
  if (act === 'browse-folder') pickFolder.click();
  if (act === 'cancel' || act === 'drop-another') showIdle();
  if (act === 'retry') {
    if (app.plan) showConfirm();
    else showIdle();
  }
  if (act === 'toggle-skipped') {
    const wrap = $('#skipped-wrap');
    const open = wrap.dataset.open !== 'true';
    wrap.dataset.open = String(open);
    target.setAttribute('aria-expanded', String(open));
  }
  if (act === 'use-name') {
    const input = $('#name-input');
    input.value = target.dataset.name;
    app.taken = false;
    syncUploadButton();
    updatePagesSub();
    setStatus('free', `${target.dataset.name} is free`);
    const btn = $('#upload-btn');
    if (btn) btn.focus({ preventScroll: true });
  }
});

card.addEventListener('input', (e) => {
  if (e.target.id === 'name-input') onNameInput();
});

card.addEventListener('focusout', (e) => {
  if (e.target.id === 'name-input' && e.target.value.trim()) {
    const clean = sanitizeName(e.target.value);
    if (clean !== e.target.value) {
      e.target.value = clean;
      onNameInput();
    }
  }
});

card.addEventListener('change', (e) => {
  if (e.target.id === 'pages-toggle') {
    app.pages = e.target.checked;
    updatePagesSub();
  }
});

card.addEventListener('submit', (e) => {
  e.preventDefault();
  startUpload();
});

pill.addEventListener('click', (e) => {
  if (e.target.closest('[data-act="signout"]')) signOut();
});

pickFiles.addEventListener('change', () => {
  const files = pickFiles.files;
  if (files && files.length) ingest(() => readFileInput(files)).finally(() => (pickFiles.value = ''));
});

pickFolder.addEventListener('change', () => {
  const files = pickFolder.files;
  if (files && files.length) ingest(() => readFileInput(files)).finally(() => (pickFolder.value = ''));
});

async function boot() {
  const { error } = takeHash();
  app.token = readToken();
  renderPill();
  const problem = error ? (error === 'access_denied' ? 'GitHub sign in was cancelled.' : `Sign in did not finish (${error}).`) : '';
  if (!app.token) {
    inner.innerHTML = viewSignedOut();
    card.dataset.state = 'signedout';
    app.view = 'signedout';
    if (problem) notify(problem);
    return;
  }
  inner.innerHTML = viewBoot();
  card.dataset.state = 'boot';
  app.client = createClient({ token: app.token, base: resolveBase(window.location) });
  try {
    app.user = await app.client.getUser();
  } catch (err) {
    if (err.status === 401) {
      expire();
      return;
    }
    app.client = null;
    await morph(
      viewProblem('Could not reach GitHub', err.message || 'Check your connection and try again.', '<button type="button" class="btn-primary" data-act="reload">Reload</button>'),
      'problem'
    );
    return;
  }
  renderPill();
  await showIdle();
}

boot();
