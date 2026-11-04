import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, resolveBase, resolveTiming, previewPath, previewUrl, waitForPages, pool, uploadProject, DEFAULT_BASE } from '../lib/github.js';

const reply = (status, data, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  json: async () => data
});

describe('resolveBase', () => {
  test('honours ?api= on localhost', () => {
    assert.equal(resolveBase({ hostname: 'localhost', search: '?api=http://localhost:9/' }), 'http://localhost:9');
  });
  test('honours ?api= on 127.0.0.1', () => {
    assert.equal(resolveBase({ hostname: '127.0.0.1', search: '?x=1&api=http://127.0.0.1:5' }), 'http://127.0.0.1:5');
  });
  test('ignores ?api= on any other host', () => {
    assert.equal(resolveBase({ hostname: 'repo-drop.vercel.app', search: '?api=http://evil.test' }), DEFAULT_BASE);
    assert.equal(resolveBase({ hostname: 'localhost.evil.test', search: '?api=http://evil.test' }), DEFAULT_BASE);
  });
  test('ignores a non-http value', () => {
    assert.equal(resolveBase({ hostname: 'localhost', search: '?api=javascript:1' }), DEFAULT_BASE);
  });
  test('defaults to api.github.com', () => {
    assert.equal(resolveBase({ hostname: 'localhost', search: '' }), 'https://api.github.com');
  });
});

describe('resolveTiming', () => {
  test('reads pollMs, timeoutMs and holdMs on localhost only', () => {
    assert.deepEqual(resolveTiming({ hostname: 'localhost', search: '?pollMs=40&timeoutMs=900&holdMs=60' }), { pollMs: 40, timeoutMs: 900, holdMs: 60 });
    assert.deepEqual(resolveTiming({ hostname: 'repo-drop.vercel.app', search: '?pollMs=40' }), {});
    assert.deepEqual(resolveTiming({ hostname: '127.0.0.1', search: '?pollMs=-1&timeoutMs=x' }), {});
  });
});

describe('preview', () => {
  test('index.html at the root wins, else the shortest html path, else none', () => {
    assert.equal(previewPath(['a/index.html', 'index.html', 'x.html']), 'index.html');
    assert.equal(previewPath(['docs/deep/page.html', 'about.html', 'z/a.html']), 'z/a.html');
    assert.equal(previewPath(['b.html', 'a.html']), 'a.html');
    assert.equal(previewPath(['style.css', 'app.js']), null);
    assert.equal(previewPath([]), null);
  });
  test('previewUrl builds the githack address from the commit sha', () => {
    assert.equal(previewUrl('u', 'r', 'abc123', 'index.html'), 'https://rawcdn.githack.com/u/r/abc123/index.html');
    assert.equal(previewUrl('u', 'r', 'abc123', 'my docs/a b.html'), 'https://rawcdn.githack.com/u/r/abc123/my%20docs/a%20b.html');
  });
});

describe('client runs', () => {
  test('latestRun reads the newest Actions run and tolerates 404', async () => {
    const urls = [];
    const answers = [reply(200, { workflow_runs: [{ status: 'queued', conclusion: null, id: 9 }] }), reply(404, { message: 'Not Found' }), reply(200, { workflow_runs: [] })];
    const client = createClient({ token: 't', base: 'http://x', fetchImpl: async (url) => (urls.push(url), answers.shift()) });
    assert.deepEqual(await client.latestRun('o', 'r'), { status: 'queued', conclusion: null });
    assert.equal(await client.latestRun('o', 'r'), null);
    assert.equal(await client.latestRun('o', 'r'), null);
    assert.equal(urls[0], 'http://x/repos/o/r/actions/runs?per_page=1');
  });
});

describe('client retry', () => {
  test('retries a blob on 429 using retry-after', async () => {
    const waits = [];
    let calls = 0;
    const client = createClient({
      token: 't',
      base: 'http://x',
      sleep: async (ms) => waits.push(ms),
      encode: async () => 'AAAA',
      fetchImpl: async () => {
        calls += 1;
        return calls < 3 ? reply(429, { message: 'slow' }, { 'retry-after': '2' }) : reply(201, { sha: 'abc' });
      }
    });
    assert.equal(await client.createBlob('o', 'r', new Blob([])), 'abc');
    assert.equal(calls, 3);
    assert.deepEqual(waits, [2000, 2000]);
  });

  test('falls back to exponential backoff without retry-after', async () => {
    const waits = [];
    let calls = 0;
    const client = createClient({
      token: 't',
      base: 'http://x',
      sleep: async (ms) => waits.push(ms),
      encode: async () => '',
      fetchImpl: async () => {
        calls += 1;
        return calls < 3 ? reply(403, { message: 'limit' }) : reply(201, { sha: 's' });
      }
    });
    await client.createBlob('o', 'r', new Blob([]));
    assert.deepEqual(waits, [500, 1000]);
  });

  test('gives up after three tries', async () => {
    let calls = 0;
    const client = createClient({
      token: 't',
      base: 'http://x',
      sleep: async () => {},
      encode: async () => '',
      fetchImpl: async () => {
        calls += 1;
        return reply(403, { message: 'limit' });
      }
    });
    await assert.rejects(() => client.createBlob('o', 'r', new Blob([])), /limit/);
    assert.equal(calls, 3);
  });

  test('401 is surfaced at once with a status', async () => {
    const client = createClient({ token: 't', base: 'http://x', fetchImpl: async () => reply(401, {}) });
    await assert.rejects(() => client.getUser(), (err) => err.status === 401);
  });

  test('repoExists reads 200 and 404', async () => {
    const codes = [200, 404];
    const client = createClient({ token: 't', base: 'http://x', fetchImpl: async () => reply(codes.shift(), {}) });
    assert.equal(await client.repoExists('o', 'a'), true);
    assert.equal(await client.repoExists('o', 'b'), false);
  });

  test('requests go to the injected base with the bearer token', async () => {
    const seen = [];
    const client = createClient({
      token: 'tok',
      base: 'http://mock.test',
      fetchImpl: async (url, init) => {
        seen.push([url, init.headers.Authorization]);
        return reply(200, { login: 'u' });
      }
    });
    await client.getUser();
    assert.deepEqual(seen, [['http://mock.test/user', 'Bearer tok']]);
  });
});

describe('pool and pages polling', () => {
  test('pool never runs more than the limit at once', async () => {
    let live = 0;
    let peak = 0;
    await pool(Array.from({ length: 20 }, (_, i) => i), 6, async () => {
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      live -= 1;
    });
    assert.equal(peak, 6);
  });

  test('waitForPages returns built after a building poll', async () => {
    const states = [null, { status: 'building' }, { status: 'built' }];
    const ticks = [];
    const out = await waitForPages({ latestBuild: async () => states.shift() }, 'o', 'r', {
      sleep: async () => {},
      onTick: (t) => ticks.push(t)
    });
    assert.equal(out, 'built');
    assert.deepEqual(ticks, [3000, 6000, 9000]);
  });

  test('waitForPages gives up at 10 minutes', async () => {
    let polls = 0;
    const out = await waitForPages({ latestBuild: async () => (polls += 1, { status: 'building' }) }, 'o', 'r', { sleep: async () => {} });
    assert.equal(out, 'timeout');
    assert.equal(polls, 200);
  });

  test('waitForPages reports queued, building, then built from the Actions run', async () => {
    const runs = [null, { status: 'queued', conclusion: null }, { status: 'waiting', conclusion: null }, { status: 'in_progress', conclusion: null }, { status: 'completed', conclusion: 'success' }];
    const phases = [];
    const out = await waitForPages({ latestBuild: async () => null, latestRun: async () => runs.shift() }, 'o', 'r', {
      sleep: async () => {},
      onTick: (t, limit, phase) => phases.push(phase)
    });
    assert.equal(out, 'built');
    assert.deepEqual(phases, ['queued', 'queued', 'queued', 'building', 'built']);
  });

  test('waitForPages stays queued past the timeout when the run never starts', async () => {
    const phases = [];
    const out = await waitForPages({ latestBuild: async () => null, latestRun: async () => ({ status: 'queued', conclusion: null }) }, 'o', 'r', {
      sleep: async () => {},
      intervalMs: 100,
      timeoutMs: 500,
      onTick: (t, limit, phase) => phases.push(phase)
    });
    assert.equal(out, 'timeout');
    assert.deepEqual(phases, ['queued', 'queued', 'queued', 'queued', 'queued']);
  });

  test('waitForPages keeps going when the runs call fails', async () => {
    const states = [{ status: 'building' }, { status: 'built' }];
    const out = await waitForPages({ latestBuild: async () => states.shift(), latestRun: async () => { throw new Error('boom'); } }, 'o', 'r', { sleep: async () => {} });
    assert.equal(out, 'built');
  });

  test('waitForPages reports an errored build', async () => {
    const out = await waitForPages({ latestBuild: async () => ({ status: 'errored' }) }, 'o', 'r', { sleep: async () => {} });
    assert.equal(out, 'errored');
  });
});

describe('uploadProject', () => {
  const makeClient = (log) => ({
    createRepo: async (name) => (log.push(['repo', name]), { name, owner: { login: 'u' }, html_url: 'https://github.com/u/' + name, default_branch: 'main' }),
    createBlob: async () => (log.push(['blob']), 'sha' + log.length),
    createTree: async (o, r, tree) => (log.push(['tree', tree.map((t) => t.path)]), 'tree1'),
    createCommit: async () => (log.push(['commit']), 'c1'),
    updateRef: async (o, r, b, sha) => log.push(['ref', b, sha]),
    enablePages: async () => (log.push(['pages']), { html_url: 'https://u.github.io/x/' }),
    latestBuild: async () => ({ status: 'built' })
  });
  const files = [{ path: 'index.html', size: 1, read: async () => new Blob(['a']) }];

  test('pages on adds an empty .nojekyll and enables pages', async () => {
    const log = [];
    const out = await uploadProject({ client: makeClient(log), name: 'x', files, pages: true, sleep: async () => {} });
    assert.deepEqual(log.find((l) => l[0] === 'tree')[1], ['index.html', '.nojekyll']);
    assert.equal(log.filter((l) => l[0] === 'blob').length, 2);
    assert.ok(log.some((l) => l[0] === 'pages'));
    assert.equal(out.pagesStatus, 'built');
    assert.equal(out.pagesUrl, 'https://u.github.io/x/');
  });

  test('onPreview fires right after the ref and before pages, with the commit sha and html path', async () => {
    const log = [];
    const client = makeClient(log);
    const out = await uploadProject({
      client, name: 'x', files, pages: true, deferPages: true,
      onPreview: ({ preview, repoUrl }) => log.push(['preview', preview.url, repoUrl])
    });
    const kinds = log.map((l) => l[0]);
    assert.ok(kinds.indexOf('ref') < kinds.indexOf('preview'));
    assert.ok(kinds.indexOf('preview') < kinds.indexOf('pages'));
    assert.deepEqual(log.find((l) => l[0] === 'preview').slice(1), ['https://rawcdn.githack.com/u/x/c1/index.html', 'https://github.com/u/x']);
    assert.equal(out.pagesStatus, 'queued');
    assert.equal(out.preview.path, 'index.html');
  });

  test('no html means no preview and the repo url is handed over', async () => {
    const seen = [];
    const out = await uploadProject({ client: makeClient([]), name: 'x', files: [{ path: 'a.css', size: 1, read: async () => new Blob(['a']) }], pages: false, onPreview: (p) => seen.push(p) });
    assert.equal(out.preview, null);
    assert.deepEqual(seen, [{ preview: null, repoUrl: 'https://github.com/u/x' }]);
  });

  test('waitForPages stops when cancelled', async () => {
    let polls = 0;
    const out = await waitForPages({ latestBuild: async () => (polls += 1, null) }, 'o', 'r', { sleep: async () => {}, cancelled: () => polls >= 2 });
    assert.equal(out, 'cancelled');
  });

  test('pages off adds nothing and never calls pages', async () => {
    const log = [];
    const out = await uploadProject({ client: makeClient(log), name: 'x', files, pages: false });
    assert.deepEqual(log.find((l) => l[0] === 'tree')[1], ['index.html']);
    assert.ok(!log.some((l) => l[0] === 'pages'));
    assert.equal(out.pagesStatus, 'off');
  });

  test('an existing .nojekyll is not duplicated', async () => {
    const log = [];
    const own = [...files, { path: '.nojekyll', size: 0, read: async () => new Blob([]) }];
    await uploadProject({ client: makeClient(log), name: 'x', files: own, pages: true, sleep: async () => {} });
    assert.deepEqual(log.find((l) => l[0] === 'tree')[1], ['index.html', '.nojekyll']);
  });

  test('order is repo, blobs, tree, commit, ref, pages', async () => {
    const log = [];
    await uploadProject({ client: makeClient(log), name: 'x', files, pages: true, sleep: async () => {} });
    const order = log.map((l) => l[0]).filter((v, i, a) => a.indexOf(v) === i);
    assert.deepEqual(order, ['repo', 'blob', 'tree', 'commit', 'ref', 'pages']);
  });
});
