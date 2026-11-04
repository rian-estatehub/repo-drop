export const MAX_BYTES = 100 * 1024 * 1024;

const SKIP_DIRS = new Set(['.git', 'node_modules', '__MACOSX']);
const SKIP_FILES = new Map([
  ['.DS_Store', '.DS_Store'],
  ['Thumbs.db', 'Thumbs.db']
]);

export function normalizePath(path) {
  return String(path)
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^(\.\/)+/, '')
    .replace(/^\/+/, '');
}

export function stripExt(name) {
  const base = String(name).split('/').pop();
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

export function isHtml(path) {
  return /\.html?$/i.test(path);
}

export function skipReason(path, size) {
  const parts = normalizePath(path).split('/');
  for (const part of parts) {
    if (SKIP_DIRS.has(part)) return `${part} folder`;
  }
  const base = parts[parts.length - 1];
  if (SKIP_FILES.has(base)) return SKIP_FILES.get(base);
  if (size > MAX_BYTES) return 'over 100 MB';
  return null;
}

export function classify(entries) {
  const kept = [];
  const skipped = [];
  for (const entry of entries) {
    const path = normalizePath(entry.path);
    if (!path) continue;
    const reason = skipReason(path, entry.size || 0);
    if (reason) skipped.push({ path, reason });
    else kept.push({ ...entry, path });
  }
  return { kept, skipped };
}

export function stripRoot(entries) {
  if (!entries.length) return { entries, root: null };
  const first = entries[0].path.split('/')[0];
  const shared = entries.every((e) => e.path.includes('/') && e.path.split('/')[0] === first);
  if (!shared) return { entries, root: null };
  return {
    entries: entries.map((e) => ({ ...e, path: e.path.slice(first.length + 1) })),
    root: first
  };
}

export function sanitizeName(raw) {
  let name = String(raw ?? '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  name = name.slice(0, 100).replace(/^[-.]+|[-.]+$/g, '');
  name = name.replace(/\.git$/i, '').replace(/^[-.]+|[-.]+$/g, '');
  return name || 'project';
}

export function suffixName(base, n) {
  const tail = `-${n}`;
  return base.slice(0, 100 - tail.length).replace(/[-.]+$/g, '') + tail;
}

export async function nextFreeName(base, exists) {
  if (!(await exists(base))) return base;
  for (let n = 2; n < 500; n += 1) {
    const candidate = suffixName(base, n);
    if (!(await exists(candidate))) return candidate;
  }
  return suffixName(base, Date.now() % 100000);
}

export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(bytes < 10485760 ? 1 : 0)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function buildPlan({ entries, pruned = [], sourceName, kind = 'files', label = '' }) {
  const { kept, skipped } = classify(entries);
  const stripped = stripRoot(kept);
  let files = stripped.entries;
  let single = false;
  let fallbackName = null;
  if (files.length === 1 && isHtml(files[0].path) && !files[0].path.includes('/')) {
    fallbackName = stripExt(files[0].path);
    files = [{ ...files[0], originalPath: files[0].path, path: 'index.html' }];
    single = true;
  }
  const name = sanitizeName(sourceName ?? stripped.root ?? fallbackName);
  const total = files.reduce((sum, f) => sum + (f.size || 0), 0);
  return {
    files,
    skipped: [...pruned, ...skipped],
    name,
    total,
    kind,
    label,
    single,
    root: stripped.root
  };
}

export function captureDrop(dt) {
  const items = dt.items ? Array.from(dt.items).filter((i) => i.kind === 'file') : [];
  const handles = items.map((item) => ({
    entry: item.webkitGetAsEntry ? item.webkitGetAsEntry() : null,
    file: item.getAsFile ? item.getAsFile() : null
  }));
  const files = Array.from(dt.files || []);
  return { handles, files };
}

function entryFile(entry) {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function readBatch(reader) {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

async function walk(entry, prefix, out, pruned) {
  if (entry.isFile) {
    const file = await entryFile(entry);
    out.push({ path: prefix + entry.name, size: file.size, read: () => Promise.resolve(file) });
    return;
  }
  if (!entry.isDirectory) return;
  if (SKIP_DIRS.has(entry.name)) {
    pruned.push({ path: `${prefix}${entry.name}/`, reason: `${entry.name} folder` });
    return;
  }
  const reader = entry.createReader();
  const children = [];
  for (;;) {
    const batch = await readBatch(reader);
    if (!batch.length) break;
    children.push(...batch);
  }
  await Promise.all(children.map((child) => walk(child, `${prefix}${entry.name}/`, out, pruned)));
}

function fileEntry(file, path) {
  return { path, size: file.size, read: () => Promise.resolve(file) };
}

export async function readZip(file, JSZipLib = globalThis.JSZip) {
  if (!JSZipLib) throw new Error('Zip support did not load. Check your connection and try again.');
  const zip = await JSZipLib.loadAsync(file);
  const entries = [];
  zip.forEach((path, obj) => {
    if (obj.dir) return;
    const size = obj._data && typeof obj._data.uncompressedSize === 'number' ? obj._data.uncompressedSize : 0;
    entries.push({ path, size, read: () => obj.async('blob') });
  });
  return entries;
}

export async function readCaptured(cap) {
  const dirs = cap.handles.filter((h) => h.entry && h.entry.isDirectory);
  const loose = cap.handles.length
    ? cap.handles.filter((h) => !h.entry || h.entry.isFile)
    : cap.files.map((file) => ({ entry: null, file }));
  if (!cap.handles.length && !cap.files.length) return { entries: [], pruned: [], kind: 'files' };

  if (!dirs.length && loose.length === 1) {
    const only = loose[0];
    const file = only.file || (await entryFile(only.entry));
    return readSingle(file);
  }

  const entries = [];
  const pruned = [];
  for (const h of cap.handles) {
    if (h.entry) await walk(h.entry, '', entries, pruned);
    else if (h.file) entries.push(fileEntry(h.file, h.file.name));
  }
  if (!cap.handles.length) for (const f of cap.files) entries.push(fileEntry(f, f.name));
  const onlyDir = cap.handles.length === 1 && dirs.length === 1;
  return {
    entries,
    pruned,
    kind: dirs.length ? 'folder' : 'files',
    sourceName: onlyDir ? dirs[0].entry.name : undefined,
    label: onlyDir ? `Folder ${dirs[0].entry.name}` : `${entries.length} dropped items`
  };
}

async function readSingle(file) {
  if (/\.zip$/i.test(file.name)) {
    return {
      entries: await readZip(file),
      pruned: [],
      kind: 'zip',
      sourceName: stripExt(file.name),
      label: `Zip ${file.name}`
    };
  }
  return {
    entries: [fileEntry(file, file.name)],
    pruned: [],
    kind: isHtml(file.name) ? 'html' : 'files',
    sourceName: stripExt(file.name),
    label: file.name
  };
}

export async function readFileInput(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return { entries: [], pruned: [], kind: 'files' };
  const hasRel = files.some((f) => f.webkitRelativePath);
  if (hasRel) {
    const entries = files.map((f) => fileEntry(f, f.webkitRelativePath || f.name));
    const roots = new Set(entries.map((e) => e.path.split('/')[0]));
    const root = roots.size === 1 ? [...roots][0] : undefined;
    return { entries, pruned: [], kind: 'folder', sourceName: root, label: root ? `Folder ${root}` : 'Folder' };
  }
  if (files.length === 1) return readSingle(files[0]);
  return {
    entries: files.map((f) => fileEntry(f, f.name)),
    pruned: [],
    kind: 'files',
    label: `${files.length} files`
  };
}
