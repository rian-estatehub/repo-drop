import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_BYTES,
  normalizePath,
  skipReason,
  classify,
  stripRoot,
  sanitizeName,
  nextFreeName,
  suffixName,
  buildPlan,
  formatSize,
  stripExt,
  readCaptured
} from '../lib/intake.js';

const e = (path, size = 10) => ({ path, size });
const paths = (list) => list.map((x) => x.path);

describe('root folder strip', () => {
  test('strips a single shared top-level folder', () => {
    const { entries, root } = stripRoot([e('site/index.html'), e('site/css/a.css')]);
    assert.deepEqual(paths(entries), ['index.html', 'css/a.css']);
    assert.equal(root, 'site');
  });

  test('keeps paths when top-level names differ', () => {
    const { entries, root } = stripRoot([e('a/x.txt'), e('b/y.txt')]);
    assert.deepEqual(paths(entries), ['a/x.txt', 'b/y.txt']);
    assert.equal(root, null);
  });

  test('keeps paths when a loose file sits at the top', () => {
    const { entries, root } = stripRoot([e('site/a.txt'), e('readme.md')]);
    assert.deepEqual(paths(entries), ['site/a.txt', 'readme.md']);
    assert.equal(root, null);
  });

  test('strips only one level', () => {
    const { entries } = stripRoot([e('a/b/c.txt'), e('a/b/d.txt')]);
    assert.deepEqual(paths(entries), ['b/c.txt', 'b/d.txt']);
  });

  test('empty input stays empty', () => {
    assert.deepEqual(stripRoot([]), { entries: [], root: null });
  });

  test('root strip happens after skips so __MACOSX in a zip does not block it', () => {
    const plan = buildPlan({
      entries: [e('proj/index.html'), e('proj/a/b.txt'), e('__MACOSX/proj/._index.html')],
      sourceName: 'proj'
    });
    assert.deepEqual(paths(plan.files).sort(), ['a/b.txt', 'index.html']);
    assert.equal(plan.skipped.length, 1);
  });
});

describe('skip rules', () => {
  test('.git folder', () => assert.equal(skipReason('.git/HEAD', 5), '.git folder'));
  test('nested .git folder', () => assert.equal(skipReason('app/.git/config', 5), '.git folder'));
  test('node_modules folder', () => assert.equal(skipReason('node_modules/x/index.js', 5), 'node_modules folder'));
  test('nested node_modules folder', () => assert.equal(skipReason('web/node_modules/y.js', 5), 'node_modules folder'));
  test('__MACOSX folder', () => assert.equal(skipReason('__MACOSX/a/._b', 5), '__MACOSX folder'));
  test('.DS_Store at any depth', () => {
    assert.equal(skipReason('.DS_Store', 1), '.DS_Store');
    assert.equal(skipReason('a/b/.DS_Store', 1), '.DS_Store');
  });
  test('Thumbs.db at any depth', () => {
    assert.equal(skipReason('Thumbs.db', 1), 'Thumbs.db');
    assert.equal(skipReason('img/Thumbs.db', 1), 'Thumbs.db');
  });
  test('over 100 MB is skipped, exactly 100 MB is kept', () => {
    assert.equal(skipReason('big.bin', MAX_BYTES + 1), 'over 100 MB');
    assert.equal(skipReason('ok.bin', MAX_BYTES), null);
  });
  test('names that only look similar are kept', () => {
    assert.equal(skipReason('.gitignore', 1), null);
    assert.equal(skipReason('.github/workflows/a.yml', 1), null);
    assert.equal(skipReason('my_node_modules/a.js', 1), null);
    assert.equal(skipReason('DS_Store.txt', 1), null);
  });
  test('classify lists each skipped file with its reason', () => {
    const { kept, skipped } = classify([
      e('a/index.html'),
      e('a/.DS_Store'),
      e('a/node_modules/p/i.js'),
      e('a/.git/HEAD'),
      e('a/huge.iso', MAX_BYTES + 5),
      e('a/__MACOSX/x'),
      e('a/Thumbs.db')
    ]);
    assert.deepEqual(paths(kept), ['a/index.html']);
    assert.deepEqual(
      skipped.map((s) => s.reason).sort(),
      ['.DS_Store', '.git folder', 'Thumbs.db', '__MACOSX folder', 'node_modules folder', 'over 100 MB'].sort()
    );
  });
  test('backslash and leading slash paths are normalised', () => {
    assert.equal(normalizePath('\\a\\b.txt'), 'a/b.txt');
    assert.equal(normalizePath('./a//b.txt'), 'a/b.txt');
  });
});

describe('single HTML file', () => {
  test('becomes index.html and the name comes from the original file', () => {
    const plan = buildPlan({ entries: [e('My Page.html')], sourceName: stripExt('My Page.html'), kind: 'html' });
    assert.deepEqual(paths(plan.files), ['index.html']);
    assert.equal(plan.files[0].originalPath, 'My Page.html');
    assert.equal(plan.name, 'My-Page');
    assert.equal(plan.single, true);
  });

  test('a lone .htm file also becomes index.html', () => {
    const plan = buildPlan({ entries: [e('old.htm')], sourceName: 'old' });
    assert.deepEqual(paths(plan.files), ['index.html']);
  });

  test('two files are not renamed', () => {
    const plan = buildPlan({ entries: [e('a.html'), e('b.html')] });
    assert.deepEqual(paths(plan.files), ['a.html', 'b.html']);
    assert.equal(plan.single, false);
  });

  test('a single html inside a folder drops to index.html after the strip', () => {
    const plan = buildPlan({ entries: [e('folder/page.html')], sourceName: 'folder' });
    assert.deepEqual(paths(plan.files), ['index.html']);
    assert.equal(plan.name, 'folder');
  });

  test('a lone non-html file keeps its name', () => {
    const plan = buildPlan({ entries: [e('notes.txt')], sourceName: 'notes' });
    assert.deepEqual(paths(plan.files), ['notes.txt']);
  });
});

describe('name sanitising', () => {
  test('spaces become dashes', () => assert.equal(sanitizeName('my cool site'), 'my-cool-site'));
  test('invalid characters become dashes', () => assert.equal(sanitizeName('a@b#c$d'), 'a-b-c-d'));
  test('repeats collapse', () => assert.equal(sanitizeName('a   b---c'), 'a-b-c'));
  test('leading and trailing dashes and dots are trimmed', () => {
    assert.equal(sanitizeName('--.name.--'), 'name');
    assert.equal(sanitizeName('...'), 'project');
  });
  test('allowed characters survive', () => assert.equal(sanitizeName('A.b_c-9'), 'A.b_c-9'));
  test('max 100 characters', () => {
    const out = sanitizeName('x'.repeat(250));
    assert.equal(out.length, 100);
  });
  test('trimming happens after the length cut', () => {
    const out = sanitizeName(`${'x'.repeat(99)}-yyyy`);
    assert.equal(out, 'x'.repeat(99));
  });
  test('empty falls back to project', () => {
    assert.equal(sanitizeName(''), 'project');
    assert.equal(sanitizeName('   '), 'project');
    assert.equal(sanitizeName(undefined), 'project');
    assert.equal(sanitizeName('???'), 'project');
  });
  test('a trailing .git is removed', () => assert.equal(sanitizeName('thing.git'), 'thing'));
  test('unicode becomes dashes', () => assert.equal(sanitizeName('my site ☃'), 'my-site'));
  test('stripExt', () => {
    assert.equal(stripExt('My Page.html'), 'My Page');
    assert.equal(stripExt('archive.tar.zip'), 'archive.tar');
    assert.equal(stripExt('.hidden'), '.hidden');
  });
});

describe('next free name', () => {
  const taken = (set) => async (n) => set.has(n);

  test('returns the base when it is free', async () => {
    assert.equal(await nextFreeName('site', taken(new Set())), 'site');
  });
  test('suggests name-2 when the base is taken', async () => {
    assert.equal(await nextFreeName('site', taken(new Set(['site']))), 'site-2');
  });
  test('walks to name-3 and name-4', async () => {
    assert.equal(await nextFreeName('site', taken(new Set(['site', 'site-2']))), 'site-3');
    assert.equal(await nextFreeName('site', taken(new Set(['site', 'site-2', 'site-3']))), 'site-4');
  });
  test('stays inside 100 characters', async () => {
    const base = 'y'.repeat(100);
    const out = await nextFreeName(base, taken(new Set([base])));
    assert.equal(out.length, 100);
    assert.ok(out.endsWith('-2'));
  });
  test('suffixName trims a dangling dash', () => {
    assert.equal(suffixName('a-', 2), 'a-2');
  });
});

describe('plan totals and drop walking', () => {
  test('total adds the kept sizes only', () => {
    const plan = buildPlan({ entries: [e('a/x', 100), e('a/y', 50), e('a/.DS_Store', 999)], sourceName: 'a' });
    assert.equal(plan.total, 150);
  });

  test('formatSize', () => {
    assert.equal(formatSize(12), '12 B');
    assert.equal(formatSize(2048), '2.0 KB');
    assert.equal(formatSize(5 * 1024 * 1024), '5.0 MB');
  });

  test('a dropped folder prunes node_modules and lists it as skipped', async () => {
    const file = (name, text) => ({
      isFile: true,
      isDirectory: false,
      name,
      file: (ok) => ok({ name, size: text.length })
    });
    const dir = (name, children) => ({
      isFile: false,
      isDirectory: true,
      name,
      createReader() {
        let done = false;
        return {
          readEntries(ok) {
            if (done) return ok([]);
            done = true;
            return ok(children);
          }
        };
      }
    });
    const root = dir('demo', [file('index.html', 'hi'), file('.DS_Store', 'x'), dir('node_modules', [file('a.js', 'z')]), dir('css', [file('a.css', 'b')])]);
    const source = await readCaptured({ handles: [{ entry: root, file: null }], files: [] });
    const plan = buildPlan(source);
    assert.deepEqual(paths(plan.files).sort(), ['css/a.css', 'index.html']);
    assert.equal(plan.name, 'demo');
    assert.deepEqual(plan.skipped.map((s) => s.path).sort(), ['demo/.DS_Store', 'demo/node_modules/']);
  });
});
