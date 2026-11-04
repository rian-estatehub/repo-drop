import { mkdirSync } from 'node:fs';
import { startMock } from './mock-github.js';
import { startStatic } from './static-server.js';
import { loadPlaywright, launch, prepare, dropTree, dragOver } from './browser.js';

const OUT = process.env.OUT;
if (!OUT) throw new Error('set OUT to the folder for the screenshots');
const SIZES = [
  ['1440', { width: 1440, height: 900 }],
  ['390', { width: 390, height: 844 }]
];

const SITE = ['dir', 'harbor-studio', [
  ['file', 'index.html', '<!doctype html><title>Harbor</title><h1>Harbor Studio</h1>'.repeat(40)],
  ['file', 'styles.css', 'body{margin:0;font-family:sans-serif}'.repeat(60)],
  ['dir', 'img', [['file', 'hero.jpg', 'x'.repeat(48000)], ['file', 'logo.svg', '<svg/>']]],
  ['dir', 'js', [['file', 'main.js', 'console.log(1);'.repeat(300)]]],
  ['file', '.DS_Store', 'junk'],
  ['dir', 'node_modules', [['file', 'a.js', 'a']]]
]];

const pw = loadPlaywright();
if (!pw) throw new Error('playwright not found, set PW_DIR');
mkdirSync(OUT, { recursive: true });

const web = await startStatic();
const browser = await launch(pw);
const settle = (page, ms = 900) => page.waitForTimeout(ms);

try {
  for (const [label, viewport] of SIZES) {
    const shot = (page, name) => page.screenshot({ path: `${OUT}/${name}-${label}.png` });

    const outCtx = await browser.newContext({ viewport });
    await prepare(outCtx, { token: null, blockFonts: false });
    const out = await outCtx.newPage();
    const mock0 = await startMock();
    await out.goto(`${web.origin}/?api=${mock0.origin}`);
    await out.waitForSelector('#card[data-state="signedout"]');
    await out.evaluate(() => document.fonts.ready);
    await settle(out, 1400);
    await shot(out, 'signed-out');
    await outCtx.close();
    await mock0.close();

    const mock = await startMock({ buildsBeforeBuilt: 0 });
    const ctx = await browser.newContext({ viewport });
    await prepare(ctx, { token: 'fake-token', blockFonts: false });
    const page = await ctx.newPage();
    await page.goto(`${web.origin}/?api=${mock.origin}`);
    await page.waitForSelector('#card[data-state="idle"]');
    await page.evaluate(() => document.fonts.ready);
    await settle(page, 1400);
    await shot(page, 'signed-in-empty');

    await dragOver(page, true);
    await settle(page, 700);
    await shot(page, 'drag-over');
    await dragOver(page, false);

    await dropTree(page, SITE);
    await page.waitForSelector('#card[data-state="confirm"]');
    await page.waitForSelector('#name-status[data-tone="free"]');
    await settle(page, 900);
    await shot(page, 'confirm');

    const popupPromise = ctx.waitForEvent('page');
    await page.click('#upload-btn');
    await popupPromise;
    await page.waitForSelector('#card[data-state="done"]', { timeout: 20000 });
    await settle(page, 1200);
    await shot(page, 'done');
    await ctx.close();
    await mock.close();
  }
} finally {
  await browser.close();
  await web.close();
}
console.log(`shots saved to ${OUT}`);
