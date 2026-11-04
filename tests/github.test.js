import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, resolveBase, resolveTiming, livePath, liveUrl, waitForPages, pool, uploadProject, DEFAULT_BASE } from '../lib/github.js';

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
  test('reads pollMs and timeoutMs on localhost only', () => {
    assert.deepEqual(resolveTiming({ hostname: 'localhost', search: '?pollMs=40&timeoutMs=900&holdMs=60' }), { pollMs: 40, timeoutMs: 900 });
    assert.deepEqual(resolveTiming({ hostname: 'repo-drop.vercel.app', search: '?pollMs=40' }), {});
    assert.deepEqual(resolveTiming({ hostname: '127.0.0.1', search: '?pollMs=-1&timeoutMs=x' }), {});
  });
});

describe('live address', () => {
  test('index.html at the root wins, else the shortest html path, else none', () => {
    assert.equal(livePath(['a/index.html', 'index.html', 'x.html']), 'index.html');
    assert.equal(livePath(['docs/deep/page.html', 'about.html', 'z/a.html']), 'z/a.html');
    assert.equal(livePath(['b.html', 'a.html']), 'a.html');
    assert.equal(livePath(['whatever.html']), 'whatever.html');
    assert.equal(livePath(['style.css', 'app.js']), null);
    assert.equal(livePath([]), null);
  });
  test('liveUrl is the Pages root for index.html or no html, else the root plus the encoded path', () => {
    assert.equal(liveUrl('https://u.github.io/r/', 'index.html'), 'https://u.github.io/r/');
    assert.equal(liveUrl('https://u.github.io/r', null), 'https://u.github.io/r/');
    assert.equal(liveUrl('https://u.github.io/r/', 'whatever.html'), 'https://u.github.io/r/whatever.html');
    assert.equal(liveUrl('https://u.github.io/r/', 'my docs/a b.html'), 'https://u.github.io/r/my%20docs/a%20b.html');
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
    assert.deepEqual(ticks, [2000, 4000, 6000]);
  });

  test('waitForPages gives up at 10 minutes', async () => {
    let polls = 0;
    const out = await waitForPages({ latestBuild: async () => (polls += 1, { status: 'building' }) }, 'o', 'r', { sleep: async () => {} });
    assert.equal(out, 'timeout');
    assert.equal(polls, 300);
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

  test('onRepoReady fires after the ref and before pages, onPagesOn after pages is enabled with the live address', async () => {
    const log = [];
    const client = makeClient(log);
    const out = await uploadProject({
      client, name: 'x', files, pages: true, deferPages: true,
      onRepoReady: ({ repoUrl, pages }) => log.push(['ready', repoUrl, pages]),
      onPagesOn: (info) => log.push(['on', info.liveUrl, info.pagesUrl, info.repoUrl])
    });
    const kinds = log.map((l) => l[0]);
    assert.ok(kinds.indexOf('ref') < kinds.indexOf('ready'));
    assert.ok(kinds.indexOf('ready') < kinds.indexOf('pages'));
    assert.ok(kinds.indexOf('pages') < kinds.indexOf('on'));
    assert.deepEqual(log.find((l) => l[0] === 'ready').slice(1), ['https://github.com/u/x', true]);
    assert.deepEqual(log.find((l) => l[0] === 'on').slice(1), ['https://u.github.io/x/', 'https://u.github.io/x/', 'https://github.com/u/x']);
    assert.equal(out.pagesStatus, 'queued');
    assert.equal(out.liveUrl, 'https://u.github.io/x/');
  });

  test('a tree with only a nested html file lands on that file under the Pages root', async () => {
    const only = [{ path: 'whatever.html', size: 1, read: async () => new Blob(['a']) }, { path: 'a.css', size: 1, read: async () => new Blob(['a']) }];
    const out = await uploadProject({ client: makeClient([]), name: 'x', files: only, pages: true, deferPages: true });
    assert.equal(out.liveUrl, 'https://u.github.io/x/whatever.html');
  });

  test('pages off hands the repo url over, never calls onPagesOn, and has no live url', async () => {
    const seen = [];
    let on = 0;
    const out = await uploadProject({ client: makeClient([]), name: 'x', files, pages: false, onRepoReady: (p) => seen.push(p), onPagesOn: () => (on += 1) });
    assert.deepEqual(seen, [{ repoUrl: 'https://github.com/u/x', pages: false }]);
    assert.equal(on, 0);
    assert.equal(out.liveUrl, null);
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
