export const DEFAULT_BASE = 'https://api.github.com';
export const COMMIT_MESSAGE = 'Initial upload';

export function resolveBase(loc) {
  try {
    if (loc && (loc.hostname === 'localhost' || loc.hostname === '127.0.0.1')) {
      const value = new URLSearchParams(loc.search).get('api');
      if (value && /^https?:\/\//.test(value)) return value.replace(/\/+$/, '');
    }
  } catch (err) {
    return DEFAULT_BASE;
  }
  return DEFAULT_BASE;
}

export class GitHubError extends Error {
  constructor(status, message, data) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.data = data;
  }
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result);
      resolve(text.slice(text.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const RATE = [403, 429];
const SETTLE = [403, 429, 404, 409];

export function createClient({ token, base = DEFAULT_BASE, fetchImpl, sleep = defaultSleep, encode = blobToBase64 }) {
  const doFetch = fetchImpl || ((...args) => globalThis.fetch(...args));

  async function request(method, path, body, opts = {}) {
    const retryOn = opts.retryOn || [];
    const tries = opts.tries || 3;
    const allow = opts.allow || [];
    let attempt = 0;
    for (;;) {
      const res = await doFetch(base + path, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      let data = null;
      try {
        data = await res.json();
      } catch (err) {
        data = null;
      }
      if (res.ok || allow.includes(res.status)) return { status: res.status, data };
      if (res.status === 401) throw new GitHubError(401, 'Your GitHub session expired. Sign in again.', data);
      if (retryOn.includes(res.status) && attempt < tries - 1) {
        const header = res.headers && res.headers.get ? Number(res.headers.get('retry-after')) : 0;
        const wait = header > 0 ? header * 1000 : 500 * 2 ** attempt;
        attempt += 1;
        await sleep(wait);
        continue;
      }
      const message = (data && data.message) || `GitHub answered ${res.status}`;
      throw new GitHubError(res.status, message, data);
    }
  }

  const repoPath = (owner, repo) => `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  return {
    base,
    request,
    async getUser() {
      return (await request('GET', '/user')).data;
    },
    async repoExists(owner, repo) {
      const res = await request('GET', repoPath(owner, repo), undefined, { allow: [404] });
      return res.status === 200;
    },
    async createRepo(name) {
      return (await request('POST', '/user/repos', { name, private: false, auto_init: true })).data;
    },
    async createBlob(owner, repo, blob) {
      const content = await encode(blob);
      const res = await request('POST', `${repoPath(owner, repo)}/git/blobs`, { content, encoding: 'base64' }, { retryOn: RATE, tries: 3 });
      return res.data.sha;
    },
    async createTree(owner, repo, tree) {
      const res = await request('POST', `${repoPath(owner, repo)}/git/trees`, { tree }, { retryOn: SETTLE, tries: 4 });
      return res.data.sha;
    },
    async createCommit(owner, repo, tree) {
      const res = await request(
        'POST',
        `${repoPath(owner, repo)}/git/commits`,
        { message: COMMIT_MESSAGE, tree, parents: [] },
        { retryOn: SETTLE, tries: 4 }
      );
      return res.data.sha;
    },
    async updateRef(owner, repo, branch, sha) {
      await request('PATCH', `${repoPath(owner, repo)}/git/refs/heads/${branch}`, { sha, force: true }, { retryOn: SETTLE, tries: 5 });
    },
    async enablePages(owner, repo, branch) {
      const res = await request('POST', `${repoPath(owner, repo)}/pages`, { source: { branch, path: '/' } }, { allow: [409] });
      return res.data;
    },
    async latestBuild(owner, repo) {
      const res = await request('GET', `${repoPath(owner, repo)}/pages/builds/latest`, undefined, { allow: [404] });
      return res.status === 200 ? res.data : null;
    },
    async latestRun(owner, repo) {
      const res = await request('GET', `${repoPath(owner, repo)}/actions/runs?per_page=1`, undefined, { allow: [404] });
      const run = res.status === 200 && res.data && Array.isArray(res.data.workflow_runs) ? res.data.workflow_runs[0] : null;
      return run ? { status: run.status, conclusion: run.conclusion || null } : null;
    }
  };
}

export async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function lane() {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}

export function resolveTiming(loc) {
  const out = {};
  try {
    if (loc && (loc.hostname === 'localhost' || loc.hostname === '127.0.0.1')) {
      const params = new URLSearchParams(loc.search);
      for (const key of ['pollMs', 'timeoutMs', 'holdMs']) {
        const value = Number(params.get(key));
        if (Number.isFinite(value) && value > 0) out[key] = value;
      }
    }
  } catch (err) {
    return {};
  }
  return out;
}

export async function checkPages(client, owner, repo) {
  const build = await client.latestBuild(owner, repo);
  let run = null;
  if (client.latestRun) {
    try {
      run = await client.latestRun(owner, repo);
    } catch (err) {
      if (err && err.status === 401) throw err;
      run = null;
    }
  }
  if ((build && build.status === 'built') || (run && run.conclusion === 'success')) return 'built';
  if (build && build.status === 'errored') return 'errored';
  if ((run && run.status === 'in_progress') || (build && build.status === 'building')) return 'building';
  return 'queued';
}

export function previewPath(paths) {
  if (paths.includes('index.html')) return 'index.html';
  const html = paths.filter((p) => /\.html$/i.test(p));
  if (!html.length) return null;
  html.sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
  return html[0];
}

export function previewUrl(owner, repo, sha, path) {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  return `https://rawcdn.githack.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${sha}/${encoded}`;
}

export async function waitForPages(client, owner, repo, { sleep = defaultSleep, intervalMs = 3000, timeoutMs = 600000, onTick, cancelled = () => false } = {}) {
  let elapsed = 0;
  while (elapsed < timeoutMs) {
    await sleep(intervalMs);
    if (cancelled()) return 'cancelled';
    elapsed += intervalMs;
    const phase = await checkPages(client, owner, repo);
    if (onTick) onTick(elapsed, timeoutMs, phase);
    if (phase === 'built') return 'built';
    if (phase === 'errored') return 'errored';
  }
  return 'timeout';
}

export async function uploadProject({ client, name, files, pages, onStage = () => {}, onProgress = () => {}, onPagesTick, onPreview = () => {}, deferPages = false, sleep = defaultSleep, pollMs = 3000, timeoutMs }) {
  onStage('repo');
  const repo = await client.createRepo(name);
  const owner = repo.owner.login;
  const repoName = repo.name;
  const branch = repo.default_branch || 'main';
  const repoUrl = repo.html_url;

  const list = files.slice();
  if (pages && !list.some((f) => f.path === '.nojekyll')) {
    list.push({ path: '.nojekyll', size: 0, read: () => Promise.resolve(new Blob([])) });
  }

  onStage('blobs');
  let done = 0;
  onProgress(0, list.length);
  const shas = await pool(list, 6, async (file) => {
    const blob = await file.read();
    const sha = await client.createBlob(owner, repoName, blob);
    done += 1;
    onProgress(done, list.length);
    return sha;
  });

  onStage('tree');
  const treeSha = await client.createTree(
    owner,
    repoName,
    list.map((file, i) => ({ path: file.path, mode: '100644', type: 'blob', sha: shas[i] }))
  );

  onStage('commit');
  const commitSha = await client.createCommit(owner, repoName, treeSha);

  onStage('ref');
  await client.updateRef(owner, repoName, branch, commitSha);

  const htmlPath = previewPath(files.map((f) => f.path));
  const preview = htmlPath ? { url: previewUrl(owner, repoName, commitSha, htmlPath), sha: commitSha, path: htmlPath } : null;
  const result = { owner, name: repoName, repoUrl, preview, pagesUrl: null, pagesStatus: 'off', pagesError: null };
  onPreview({ preview, repoUrl });
  if (!pages) return result;

  onStage('pages');
  const fallbackUrl = repoName.toLowerCase() === `${owner.toLowerCase()}.github.io`
    ? `https://${owner}.github.io/`
    : `https://${owner}.github.io/${repoName}/`;
  try {
    const site = await client.enablePages(owner, repoName, branch);
    result.pagesUrl = (site && site.html_url) || fallbackUrl;
    if (deferPages) {
      result.pagesStatus = 'queued';
      return result;
    }
    result.pagesStatus = await waitForPages(client, owner, repoName, { sleep, intervalMs: pollMs, timeoutMs, onTick: onPagesTick });
  } catch (err) {
    if (err.status === 401) throw err;
    result.pagesUrl = null;
    result.pagesStatus = 'failed';
    result.pagesError = err.message;
  }
  return result;
}
