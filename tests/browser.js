import { createRequire } from 'node:module';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const PW_DIR = process.env.PW_DIR || '';
const require = createRequire(join(PW_DIR || process.cwd(), 'package.json'));

export function loadPlaywright() {
  if (!PW_DIR) return null;
  try {
    return require('playwright');
  } catch (err) {
    return null;
  }
}

export function jszipSource() {
  if (!PW_DIR) return null;
  const file = join(PW_DIR, 'node_modules', 'jszip', 'dist', 'jszip.min.js');
  return existsSync(file) ? file : null;
}

export function loadJSZip() {
  return require('jszip');
}

export function chromePath() {
  if (process.env.CHROME) return process.env.CHROME;
  const cache = join(homedir(), 'Library', 'Caches', 'ms-playwright');
  if (!existsSync(cache)) return undefined;
  const shells = readdirSync(cache).filter((d) => d.startsWith('chromium_headless_shell-')).sort().reverse();
  for (const dir of shells) {
    const sub = readdirSync(join(cache, dir)).find((d) => d.startsWith('chrome-headless-shell'));
    if (!sub) continue;
    const exe = join(cache, dir, sub, 'chrome-headless-shell');
    if (existsSync(exe)) return exe;
  }
  return undefined;
}

export async function launch(pw) {
  const executablePath = chromePath();
  try {
    return await pw.chromium.launch({ headless: true });
  } catch (err) {
    return pw.chromium.launch({ headless: true, executablePath });
  }
}

export async function prepare(context, { token, blockFonts = true }) {
  const zip = jszipSource();
  await context.route('**/cdnjs.cloudflare.com/**', (route) => {
    if (zip) return route.fulfill({ path: zip, contentType: 'text/javascript' });
    return route.abort();
  });
  if (blockFonts) {
    await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
  }
  if (token) {
    await context.addInitScript((value) => {
      try {
        sessionStorage.setItem('rd_token', value);
      } catch (err) {
        return;
      }
    }, token);
  }
}

export function dropTree(page, tree, target = '#card') {
  return page.evaluate(
    ([spec, selector]) => {
      const build = (node) => {
        if (node[0] === 'file') {
          const file = new File([node[2]], node[1]);
          return { isFile: true, isDirectory: false, name: node[1], file: (ok) => ok(file) };
        }
        const children = node[2].map(build);
        return {
          isFile: false,
          isDirectory: true,
          name: node[1],
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
        };
      };
      const root = build(spec);
      const event = new Event('drop', { bubbles: true, cancelable: true });
      event.dataTransfer = {
        types: ['Files'],
        files: [],
        items: [{ kind: 'file', webkitGetAsEntry: () => root, getAsFile: () => null }]
      };
      document.querySelector(selector).dispatchEvent(event);
    },
    [tree, target]
  );
}

export function dragOver(page, on) {
  return page.evaluate((flag) => {
    const dt = new DataTransfer();
    dt.items.add(new File(['x'], 'x.txt'));
    const type = flag ? 'dragenter' : 'dragleave';
    document.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, on);
}
