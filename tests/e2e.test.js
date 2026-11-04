import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMock } from './mock-github.js';
import { startStatic } from './static-server.js';
import { loadPlaywright, launch, prepare, dropTree, loadJSZip } from './browser.js';

const pw = loadPlaywright();
const skip = pw ? false : 'playwright not found, set PW_DIR to a folder with playwright installed';

const SITE = ['dir', 'mysite', [
  ['file', 'index.html', '<h1>hello</h1>'],
  ['file', 'style.css', 'body{color:red}'],
  ['dir', 'img', [['file', 'logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>']]],
  ['file', '.DS_Store', 'junk'],
  ['dir', 'node_modules', [['dir', 'pkg', [['file', 'index.js', 'module.exports = 1']]]]]
]];

describe('repo-drop end to end', { skip }, () => {
  let browser;
  let web;
  const open = [];

  before(async () => {
    web = await startStatic();
    browser = await launch(pw);
  });

  after(async () => {
    for (const fn of open.splice(0)) await fn();
    if (browser) await browser.close();
    if (web) await web.close();
  });

  async function session({ taken = [], token = 'fake-token', width = 1280, height = 800, mock, query = '' } = {}) {
    const api = mock || (await startMock({ taken }));
    const context = await browser.newContext({ viewport: { width, height } });
    await prepare(context, { token });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    open.push(async () => {
      await context.close();
      if (!mock) await api.close();
    });
    await page.goto(`${web.origin}/?api=${api.origin}${query}`);
    return { api, context, page, errors };
  }

  test('drop a folder, confirm, upload: every GitHub call lands, the second tab ends on the Pages address and the card goes live', async () => {
    const { api, context, page, errors } = await session({ query: '&pollMs=80' });
    await page.waitForSelector('#card[data-state="idle"]');
    assert.equal(await page.textContent('.pill-login'), 'testuser');

    await dropTree(page, SITE);
    await page.waitForSelector('#card[data-state="confirm"]');
    await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'upload-btn');

    assert.match(await page.textContent('#confirm-title'), /^3 files/);
    assert.equal(await page.inputValue('#name-input'), 'mysite');
    await page.waitForSelector('#name-status[data-tone="free"]');
    assert.match(await page.textContent('#skipped-toggle'), /2 items skipped/);
    assert.equal(await page.isChecked('#pages-toggle'), true);

    const popupPromise = context.waitForEvent('page');
    await page.keyboard.press('Enter');
    const popup = await popupPromise;

    await page.waitForSelector('#card[data-state="done"]', { timeout: 20000 });
    await page.waitForSelector('.done-title:has-text("It is live")', { timeout: 15000 });
    const siteUrl = `${api.origin}/site/testuser/mysite/`;
    await popup.waitForURL(siteUrl, { timeout: 15000 });

    const repoCalls = api.callsTo('POST', /^\/user\/repos$/);
    assert.equal(repoCalls.length, 1);
    assert.deepEqual(repoCalls[0].body, { name: 'mysite', private: false, auto_init: true });

    const blobCalls = api.callsTo('POST', /\/git\/blobs$/);
    assert.equal(blobCalls.length, 4);
    for (const c of blobCalls) assert.equal(c.body.encoding, 'base64');
    const blobTexts = blobCalls.map((c) => Buffer.from(c.body.content, 'base64').toString());
    assert.ok(blobTexts.includes('body{color:red}'));
    assert.ok(blobTexts.includes('<h1>hello</h1>'));
    assert.ok(blobTexts.includes(''));
    assert.ok(!blobTexts.includes('junk'));
    assert.ok(!blobTexts.includes('module.exports = 1'));

    const treeCalls = api.callsTo('POST', /\/git\/trees$/);
    assert.equal(treeCalls.length, 1);
    const tree = treeCalls[0].body;
    assert.equal(tree.base_tree, undefined);
    assert.deepEqual(tree.tree.map((t) => t.path).sort(), ['.nojekyll', 'img/logo.svg', 'index.html', 'style.css']);
    assert.ok(tree.tree.every((t) => t.mode === '100644' && t.type === 'blob'));
    assert.ok(!tree.tree.some((t) => /node_modules|DS_Store/.test(t.path)));

    const commitCalls = api.callsTo('POST', /\/git\/commits$/);
    assert.equal(commitCalls.length, 1);
    assert.equal(commitCalls[0].body.message, 'Initial upload');
    assert.deepEqual(commitCalls[0].body.parents, []);
    assert.deepEqual(Object.keys(commitCalls[0].body).sort(), ['message', 'parents', 'tree']);

    const refCalls = api.callsTo('PATCH', /\/git\/refs\/heads\/main$/);
    assert.equal(refCalls.length, 1);
    assert.equal(refCalls[0].body.force, true);

    const pagesCalls = api.callsTo('POST', /\/pages$/);
    assert.equal(pagesCalls.length, 1);
    assert.deepEqual(pagesCalls[0].body, { source: { branch: 'main', path: '/' } });
    assert.ok(api.callsTo('GET', /\/pages\/builds\/latest$/).length >= 2);

    const order = (list) => list[0].at;
    assert.ok(order(repoCalls) < order(blobCalls));
    assert.ok(Math.max(...blobCalls.map((c) => c.at)) < order(treeCalls));
    assert.ok(order(treeCalls) < order(commitCalls));
    assert.ok(order(commitCalls) < order(refCalls));
    assert.ok(order(refCalls) < order(pagesCalls));

    const writes = api.calls.filter((c) => c.method !== 'GET' && c.method !== 'OPTIONS');
    assert.ok(writes.every((c) => c.auth === 'Bearer fake-token'));

    const hrefs = await page.locator('.link-row').evaluateAll((els) => els.map((e) => e.href));
    assert.deepEqual(hrefs, [siteUrl, `${api.origin}/gh/testuser/mysite`]);
    assert.match(await page.textContent('.done-title'), /It is live/);
    assert.deepEqual(errors, []);
  });

  async function startTab(session, tree, label) {
    const { api, context, page } = session;
    await page.waitForSelector('#card[data-state="idle"]');
    await dropTree(page, tree);
    await page.waitForSelector('#card[data-state="confirm"]');
    const popupPromise = context.waitForEvent('page');
    await page.click('#upload-btn');
    const popup = await popupPromise;
    const navs = [];
    popup.on('framenavigated', (frame) => {
      if (frame === popup.mainFrame()) navs.push(frame.url());
    });
    return { popup, navs, label };
  }

  test('Pages stalled in the queue keeps the new tab on our progress page with zero navigation anywhere, then lands on the exact Pages address when the build flips', async () => {
    const out = process.env.OUT || '';
    if (out) mkdirSync(out, { recursive: true });
    const mock = await startMock({ stallQueued: true });
    open.push(() => mock.close());
    const sess = await session({ mock, width: 1440, height: 900, query: '&pollMs=150' });
    const { api, page, errors } = sess;
    const { popup, navs } = await startTab(sess, ['dir', 'solo', [['file', 'index.html', '<h1>solo</h1>']]]);

    await popup.waitForFunction(
      () => /GitHub has queued the build\. This part is on GitHub, usually under a minute, sometimes longer\. \d+ s/.test(document.getElementById('tab-detail').textContent),
      null,
      { timeout: 15000 }
    );
    await page.waitForSelector('#card[data-state="done"]', { timeout: 20000 });
    await page.waitForFunction(() => /GitHub has queued the build/.test(document.querySelector('#pages-state').textContent), null, { timeout: 10000 });
    const before = api.callsTo('GET', /\/pages\/builds\/latest$/).length;
    await popup.waitForTimeout(1500);
    assert.ok(api.callsTo('GET', /\/pages\/builds\/latest$/).length >= before + 4);
    assert.match(await popup.textContent('#tab-detail'), /queued the build/);
    assert.equal(await popup.locator('#tab-actions a').count(), 0);
    assert.deepEqual(navs.filter((u) => /\/gh\/|\/site\//.test(u)), []);
    assert.equal(api.repoHits.length, 0);
    assert.equal(api.siteHits.length, 0);
    assert.deepEqual(await page.locator('.link-kind').allTextContents(), ['GitHub Pages', 'Repository']);
    assert.equal(await page.locator('#pages-actions').count(), 0);
    if (out) await popup.screenshot({ path: `${out}/new-tab-queued-1440.png` });

    mock.setRun('in_progress');
    await popup.waitForFunction(() => /Building the site, \d+ s/.test(document.getElementById('tab-detail').textContent), null, { timeout: 10000 });
    assert.equal(api.siteHits.length, 0);
    mock.release();
    const siteUrl = `${api.origin}/site/testuser/solo/`;
    await popup.waitForURL(siteUrl, { timeout: 15000 });
    assert.equal(popup.url(), siteUrl);
    assert.equal(api.repoHits.length, 0);
    assert.ok(!navs.some((u) => /\/gh\//.test(u)));
    assert.match(await popup.textContent('h1'), /mock site testuser\/solo/);

    await page.waitForSelector('.done-title:has-text("It is live")', { timeout: 10000 });
    await page.waitForFunction(() => document.querySelectorAll('a.link-row').length === 2);
    const rows = await page.locator('a.link-row').evaluateAll((els) => els.map((e) => e.href));
    assert.deepEqual(rows, [siteUrl, `${api.origin}/gh/testuser/solo`]);
    assert.equal(await page.locator('#pages-state').count(), 0);
    assert.deepEqual(errors, []);
    if (out) {
      await page.waitForTimeout(900);
      await page.screenshot({ path: `${out}/done-1440.png` });
    }
  });

  test('a folder whose only file is whatever.html lands on the Pages address plus that file', async () => {
    const sess = await session({ query: '&pollMs=80' });
    const { api, page } = sess;
    const { popup } = await startTab(sess, ['dir', 'odd', [['file', 'whatever.html', '<h1>w</h1>'], ['file', 'a.css', 'body{}']]]);
    const target = `${api.origin}/site/testuser/odd/whatever.html`;
    await popup.waitForURL(target, { timeout: 15000 });
    assert.equal(popup.url(), target);
    await page.waitForSelector('.done-title:has-text("It is live")', { timeout: 15000 });
    const rows = await page.locator('a.link-row').evaluateAll((els) => els.map((e) => e.href));
    assert.deepEqual(rows, [target, `${api.origin}/gh/testuser/odd`]);
    const tree = api.callsTo('POST', /\/git\/trees$/)[0].body.tree.map((t) => t.path).sort();
    assert.deepEqual(tree, ['.nojekyll', 'a.css', 'whatever.html']);
  });

  test('past the wait limit both buttons show in the tab and on the card while polling continues, and the tab still navigates when the build finishes', async () => {
    const mock = await startMock({ stallQueued: true });
    open.push(() => mock.close());
    const sess = await session({ mock, query: '&pollMs=150&timeoutMs=1500' });
    const { api, page, errors } = sess;
    const { popup, navs } = await startTab(sess, ['dir', 'slow', [['file', 'index.html', '<h1>slow</h1>']]]);

    await popup.waitForSelector('#tab-actions a', { timeout: 15000 });
    assert.deepEqual(await popup.locator('#tab-actions a').allTextContents(), ['Open site', 'Open repo']);
    const hrefs = await popup.locator('#tab-actions a').evaluateAll((els) => els.map((e) => e.href));
    assert.deepEqual(hrefs, [`${api.origin}/site/testuser/slow/`, `${api.origin}/gh/testuser/slow`]);
    assert.match(await popup.textContent('#tab-detail'), /queued the build/);

    await page.waitForSelector('#pages-actions', { timeout: 15000 });
    assert.deepEqual(await page.locator('#pages-actions a').allTextContents(), ['Open site', 'Open repo']);
    assert.equal(await page.locator('#pages-state').count(), 1);

    const polls = api.callsTo('GET', /\/pages\/builds\/latest$/).length;
    await popup.waitForTimeout(900);
    assert.ok(api.callsTo('GET', /\/pages\/builds\/latest$/).length > polls);
    assert.equal(api.repoHits.length, 0);
    assert.equal(api.siteHits.length, 0);
    assert.deepEqual(navs.filter((u) => /\/gh\/|\/site\//.test(u)), []);

    mock.release();
    const siteUrl = `${api.origin}/site/testuser/slow/`;
    await popup.waitForURL(siteUrl, { timeout: 15000 });
    await page.waitForSelector('.done-title:has-text("It is live")', { timeout: 10000 });
    await page.waitForFunction(() => document.querySelectorAll('a.link-row').length === 2);
    assert.equal(await page.locator('#pages-actions').count(), 0);
    assert.equal(api.repoHits.length, 0);
    assert.deepEqual(errors, []);
  });

  test('with Pages on and no html the new tab still ends on the Pages root', async () => {
    const sess = await session({ query: '&pollMs=60' });
    const { api, page } = sess;
    const { popup } = await startTab(sess, ['dir', 'assets', [['file', 'a.css', 'body{}'], ['file', 'b.js', '1']]]);
    await popup.waitForURL(`${api.origin}/site/testuser/assets/`, { timeout: 15000 });
    await page.waitForSelector('#card[data-state="done"]', { timeout: 20000 });
    assert.equal(api.repoHits.length, 0);
  });

  test('a taken name is suggested as name-2, and typing a taken name offers the chip', async () => {
    const { api, page } = await session({ taken: ['demo-site'] });
    await page.waitForSelector('#card[data-state="idle"]');
    await dropTree(page, ['dir', 'demo-site', [['file', 'index.html', 'x']]]);
    await page.waitForSelector('#card[data-state="confirm"]');
    await page.waitForFunction(() => document.querySelector('#name-input').value === 'demo-site-2');
    assert.match(await page.textContent('#status-text'), /demo-site is taken.*demo-site-2/);
    assert.equal(await page.locator('#upload-btn').isDisabled(), false);

    await page.fill('#name-input', 'demo-site');
    await page.waitForSelector('#name-status[data-tone="taken"] .chip');
    assert.equal((await page.textContent('#name-status .chip')).trim(), 'Use demo-site-2');
    assert.equal(await page.locator('#upload-btn').isDisabled(), true);

    await page.click('#name-status .chip');
    assert.equal(await page.inputValue('#name-input'), 'demo-site-2');
    assert.equal(await page.locator('#upload-btn').isDisabled(), false);

    const checks = api.callsTo('GET', /^\/repos\/testuser\/demo-site(-2)?$/).map((c) => c.path);
    assert.ok(checks.includes('/repos/testuser/demo-site'));
    assert.ok(checks.includes('/repos/testuser/demo-site-2'));
    assert.equal(api.callsTo('POST', /\/user\/repos$/).length, 0);
  });

  test('folder pick with Pages off: node_modules files skipped, no pages call, the new tab opens the repo', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rd-pick-'));
    open.push(async () => rmSync(dir, { recursive: true, force: true }));
    const root = join(dir, 'picked');
    mkdirSync(join(root, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(root, 'index.html'), '<p>a</p>');
    writeFileSync(join(root, 'app.js'), 'console.log(1)');
    writeFileSync(join(root, '.DS_Store'), 'j');
    writeFileSync(join(root, 'node_modules', 'x', 'i.js'), 'z');

    const { api, context, page } = await session();
    await page.waitForSelector('#card[data-state="idle"]');
    await page.setInputFiles('#pick-folder', root);
    await page.waitForSelector('#card[data-state="confirm"]');
    assert.match(await page.textContent('#confirm-title'), /^2 files/);
    assert.equal(await page.inputValue('#name-input'), 'picked');
    await page.click('#skipped-toggle');
    const reasons = await page.locator('.skipped-list .why').allTextContents();
    assert.deepEqual(reasons.sort(), ['.DS_Store', 'node_modules folder']);

    await page.click('.switch-row');
    assert.equal(await page.isChecked('#pages-toggle'), false);
    const popupPromise = context.waitForEvent('page');
    await page.click('#upload-btn');
    const popup = await popupPromise;
    await page.waitForSelector('#card[data-state="done"]', { timeout: 20000 });
    await popup.waitForURL(`${api.origin}/gh/testuser/picked`, { timeout: 15000 });

    const tree = api.callsTo('POST', /\/git\/trees$/)[0].body.tree.map((t) => t.path).sort();
    assert.deepEqual(tree, ['app.js', 'index.html']);
    assert.equal(api.callsTo('POST', /\/pages$/).length, 0);
    assert.equal(api.callsTo('POST', /\/git\/blobs$/).length, 2);
    assert.match(await page.textContent('.done-title'), /Repo created/);
  });

  test('a single HTML file uploads as index.html and the repo is named from the file', async () => {
    const { api, context, page } = await session();
    await page.waitForSelector('#card[data-state="idle"]');
    await page.setInputFiles('#pick-files', { name: 'My Page.html', mimeType: 'text/html', buffer: Buffer.from('<h1>solo</h1>') });
    await page.waitForSelector('#card[data-state="confirm"]');
    assert.equal(await page.inputValue('#name-input'), 'My-Page');
    assert.match(await page.textContent('.confirm-sub'), /My Page\.html becomes index\.html/);
    const popupPromise = context.waitForEvent('page');
    await page.click('#upload-btn');
    await popupPromise;
    await page.waitForSelector('#card[data-state="done"]', { timeout: 20000 });
    const tree = api.callsTo('POST', /\/git\/trees$/)[0].body.tree.map((t) => t.path).sort();
    assert.deepEqual(tree, ['.nojekyll', 'index.html']);
  });

  test('a zip drops its root folder and its macOS metadata', async () => {
    const JSZip = loadJSZip();
    const zip = new JSZip();
    zip.file('proj/index.html', '<p>z</p>');
    zip.file('proj/lib/a.js', 'a');
    zip.file('proj/node_modules/q/i.js', 'q');
    zip.file('__MACOSX/proj/._index.html', 'm');
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    const { api, context, page } = await session();
    await page.waitForSelector('#card[data-state="idle"]');
    await page.setInputFiles('#pick-files', { name: 'proj.zip', mimeType: 'application/zip', buffer });
    await page.waitForSelector('#card[data-state="confirm"]');
    assert.match(await page.textContent('#confirm-title'), /^2 files/);
    assert.equal(await page.inputValue('#name-input'), 'proj');
    const popupPromise = context.waitForEvent('page');
    await page.click('#upload-btn');
    await popupPromise;
    await page.waitForSelector('#card[data-state="done"]', { timeout: 20000 });
    const tree = api.callsTo('POST', /\/git\/trees$/)[0].body.tree.map((t) => t.path).sort();
    assert.deepEqual(tree, ['.nojekyll', 'index.html', 'lib/a.js']);
  });

  test('signed out shows Continue with GitHub, and a fragment token is stored then cleared from the URL', async () => {
    const out = await session({ token: null });
    await out.page.waitForSelector('#card[data-state="signedout"]');
    assert.equal((await out.page.textContent('#signin-btn')).trim(), 'Continue with GitHub');
    assert.equal(await out.page.getAttribute('#signin-btn', 'href'), '/api/login');
    assert.equal(out.api.calls.length, 0);

    await out.page.goto(`${web.origin}/?api=${out.api.origin}&back=1#token=from-callback`);
    await out.page.waitForSelector('#card[data-state="idle"]');
    assert.equal(await out.page.evaluate(() => location.hash), '');
    assert.equal(await out.page.evaluate(() => sessionStorage.getItem('rd_token')), 'from-callback');
    assert.equal(await out.page.evaluate(() => localStorage.length), 0);
    assert.equal(out.api.callsTo('GET', /^\/user$/).at(-1).auth, 'Bearer from-callback');

    await out.page.click('[data-act="signout"]');
    await out.page.waitForSelector('#card[data-state="signedout"]');
    assert.equal(await out.page.evaluate(() => sessionStorage.getItem('rd_token')), null);
  });

  test('the ?api= switch is ignored off localhost', async () => {
    const mock = await startMock();
    const context = await browser.newContext();
    await prepare(context, { token: 'fake-token' });
    const page = await context.newPage();
    open.push(async () => {
      await context.close();
      await mock.close();
    });
    const requested = [];
    await context.route('https://api.github.com/**', (route) => {
      requested.push(route.request().url());
      return route.fulfill({ status: 401, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"message":"Bad credentials"}' });
    });
    await context.route('http://repo-drop.test/**', async (route) => {
      const url = new URL(route.request().url());
      const file = url.pathname === '/' ? '/index.html' : url.pathname;
      const res = await fetch(`${web.origin}${file}`);
      return route.fulfill({ status: 200, contentType: res.headers.get('content-type'), body: Buffer.from(await res.arrayBuffer()) });
    });
    await page.goto(`http://repo-drop.test/?api=${mock.origin}`);
    await page.waitForSelector('#card[data-state="signedout"]');
    assert.ok(requested.length >= 1);
    assert.equal(mock.calls.length, 0);
  });
});
