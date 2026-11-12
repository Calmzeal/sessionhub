'use strict';
// SessionHub shared fs utilities: root-confined file browsing (docs/SPEC.md "Shared libs").
//
// Exact API:
//   const { resolveWithin, listDir, readFile, readChunk, MIME } = require('../lib/fsutil');
//   resolveWithin(roots, absPath, platform) // → absolute resolved path; throws {status, message}
//   listDir(root, absPath)   // → {path, root, entries:[{name, path, type, size, mtimeMs}]}
//   readFile(path, { mode, maxBytes }) // → {size, mtimeMs, mime, isBinary, content?, truncated?}
//   readChunk(path, offset, length) // → {data: base64, eof}
//   MIME(extOrFilename) // → mime string (function, with .map exposed)

const fs = require('fs');
const path = require('path');

const BINARY_SNIFF = 8192; // first 8 KiB used for NUL-byte binary detection
const RAW_CONTENT_CAP = 2 * 1024 * 1024; // 2 MiB base64 payload cap (mode:'raw')
const CHUNK_CAP = 1024 * 1024; // 1 MiB cap for readChunk

// Extensions always treated as text, even if they contain NUL bytes.
const KNOWN_TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'json', 'js', 'mjs', 'cjs', 'ts', 'py', 'sh', 'bash', 'zsh',
  'log', 'css', 'html', 'htm', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg',
  'csv', 'sql', 'rb', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'hpp', 'swift', 'kt', 'php'
]);

const MIME_MAP = {
  md: 'text/markdown',
  json: 'application/json',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  xml: 'application/xml',
  yaml: 'text/yaml',
  yml: 'text/yaml',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  bin: 'application/octet-stream',
  exe: 'application/octet-stream',
  dll: 'application/octet-stream',
  so: 'application/octet-stream',
  dylib: 'application/octet-stream',
  txt: 'text/plain',
  js: 'text/plain',
  mjs: 'text/plain',
  cjs: 'text/plain',
  ts: 'text/plain',
  py: 'text/plain',
  sh: 'text/plain',
  bash: 'text/plain',
  zsh: 'text/plain',
  log: 'text/plain',
  toml: 'text/plain',
  ini: 'text/plain',
  cfg: 'text/plain',
  csv: 'text/plain',
  sql: 'text/plain',
  rb: 'text/plain',
  go: 'text/plain',
  rs: 'text/plain',
  java: 'text/plain',
  c: 'text/plain',
  h: 'text/plain',
  cpp: 'text/plain',
  hpp: 'text/plain',
  swift: 'text/plain',
  kt: 'text/plain',
  php: 'text/plain'
};

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function readFailed(err) {
  return httpError(404, 'read failed: ' + (err && err.code ? err.code : 'ERR'));
}

function extOf(filePath) {
  const base = String(filePath || '').split(/[\\/]/).pop() || '';
  const m = /\.([^.\s]+)$/.exec(base);
  return m ? m[1].toLowerCase() : '';
}

function MIME(input) {
  let ext = extOf(input);
  if (!ext) ext = String(input || '').replace(/^\.+/, '').toLowerCase();
  return MIME_MAP[ext] || 'application/octet-stream';
}
MIME.map = MIME_MAP;

// Choose the path module by inspecting the given strings (drive letter or UNC → win32).
function pickPathModule() {
  for (let i = 0; i < arguments.length; i += 1) {
    const s = String(arguments[i] || '');
    if (/^[a-zA-Z]:[\\/]/.test(s) || /^\\\\/.test(s)) return path.win32;
  }
  return path.posix;
}

function withinRoot(target, rootAbs, pathModule) {
  const ci = pathModule === path.win32;
  let t = target;
  let r = rootAbs;
  if (ci) {
    t = t.toLowerCase();
    r = r.toLowerCase();
  }
  if (t === r) return true;
  const sep = pathModule.sep;
  return t.startsWith(r.endsWith(sep) ? r : r + sep);
}

// realpathSync of the nearest existing ancestor (resolves symlinks); ENOENT → 404.
function realpathNearest(p, pathModule) {
  let cur = p;
  for (let depth = 0; depth < 512; depth += 1) {
    try {
      return fs.realpathSync(cur);
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
        const parent = pathModule.dirname(cur);
        if (parent === cur) throw httpError(404, 'not found');
        cur = parent;
      } else {
        throw httpError(404, 'not found');
      }
    }
  }
  throw httpError(404, 'not found');
}

function resolveWithin(roots, absPath, platform) {
  const pathModule = platform === 'win32' ? path.win32 : path.posix;
  if (!Array.isArray(roots) || roots.length === 0) {
    throw httpError(403, 'outside allowed roots');
  }
  const target = String(absPath || '');
  if (!pathModule.isAbsolute(target)) throw httpError(403, 'outside allowed roots');
  const resolved = pathModule.resolve(target);
  for (const root of roots) {
    let rootAbs;
    try {
      rootAbs = pathModule.resolve(String(root));
    } catch (e) {
      continue;
    }
    let st;
    try {
      st = fs.statSync(rootAbs);
    } catch (e) {
      continue; // root doesn't exist → skip
    }
    if (!st.isDirectory()) continue;
    if (!withinRoot(resolved, rootAbs, pathModule)) continue;
    let rootReal;
    try {
      rootReal = fs.realpathSync(rootAbs);
    } catch (e) {
      continue;
    }
    const real = realpathNearest(resolved, pathModule); // throws 404 when nothing exists
    if (!withinRoot(real, rootReal, pathModule)) throw httpError(403, 'outside allowed roots');
    return resolved;
  }
  throw httpError(403, 'outside allowed roots');
}

function listDir(root, absPath) {
  const pathModule = pickPathModule(root, absPath);
  const resolved = resolveWithin([root], absPath, pathModule === path.win32 ? 'win32' : 'posix');
  const rootAbs = pathModule.resolve(String(root));
  let dirents;
  try {
    dirents = fs.readdirSync(resolved, { withFileTypes: true });
  } catch (err) {
    throw readFailed(err);
  }
  const entries = [];
  for (const d of dirents) {
    const full = pathModule.join(resolved, d.name);
    const type = d.isDirectory() ? 'dir' : 'file';
    let size = 0;
    let mtimeMs = 0;
    try {
      const st = fs.lstatSync(full);
      mtimeMs = st.mtimeMs;
      if (type === 'file') size = st.size;
    } catch (err) {
      // Entry vanished or unreadable: keep zero defaults.
    }
    entries.push({ name: d.name, path: full, type, size, mtimeMs });
  }
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
  return { path: resolved, root: rootAbs, entries };
}

function readFile(filePath, opts) {
  opts = opts || {};
  const mode = opts.mode === 'meta' || opts.mode === 'raw' ? opts.mode : 'text';
  const maxBytes = Number(opts.maxBytes) > 0 ? Math.floor(Number(opts.maxBytes)) : 262144;

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    throw readFailed(err);
  }
  const size = stat.size;
  const mtimeMs = stat.mtimeMs;
  const mime = MIME(filePath);
  const ext = extOf(filePath);

  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch (err) {
    throw readFailed(err);
  }

  let isBinary = false;
  let head = Buffer.alloc(0);
  try {
    const headLen = Math.min(size, BINARY_SNIFF);
    head = Buffer.alloc(headLen);
    let rd = 0;
    while (rd < headLen) {
      const n = fs.readSync(fd, head, rd, headLen - rd, rd);
      if (n <= 0) break;
      rd += n;
    }
    head = head.subarray(0, rd);
    if (head.indexOf(0) !== -1 && !KNOWN_TEXT_EXTENSIONS.has(ext)) isBinary = true;
  } catch (err) {
    try { fs.closeSync(fd); } catch (e) { /* guard */ }
    throw readFailed(err);
  }

  const meta = { size, mtimeMs, mime, isBinary };
  if (mode === 'meta') {
    try { fs.closeSync(fd); } catch (e) { /* guard */ }
    return meta;
  }
  if (mode === 'text' && isBinary) {
    // Content omitted for binary files in text mode.
    try { fs.closeSync(fd); } catch (e) { /* guard */ }
    return meta;
  }

  const cap = mode === 'raw' ? RAW_CONTENT_CAP : maxBytes;
  try {
    const want = Math.min(size, cap);
    const buf = Buffer.alloc(want);
    if (want > 0) {
      const fromHead = Math.min(head.length, want);
      if (fromHead > 0) head.copy(buf, 0, 0, fromHead);
      let rd = fromHead;
      while (rd < want) {
        const n = fs.readSync(fd, buf, rd, want - rd, rd);
        if (n <= 0) break;
        rd += n;
      }
      if (mode === 'raw') {
        return Object.assign({}, meta, {
          content: buf.subarray(0, rd).toString('base64'),
          truncated: size > cap
        });
      }
      return Object.assign({}, meta, {
        content: buf.subarray(0, rd).toString('utf8'),
        truncated: size > maxBytes
      });
    }
    return Object.assign({}, meta, {
      content: '',
      truncated: mode === 'raw' ? size > cap : size > maxBytes
    });
  } catch (err) {
    throw readFailed(err);
  } finally {
    try { fs.closeSync(fd); } catch (e) { /* guard */ }
  }
}

function readChunk(filePath, offset, length) {
  const off = Math.max(0, Math.floor(Number(offset) || 0));
  const want = Math.min(Math.max(0, Math.floor(Number(length) || 0)), CHUNK_CAP);
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch (err) {
    throw readFailed(err);
  }
  try {
    let size;
    try {
      size = fs.fstatSync(fd).size;
    } catch (err) {
      throw readFailed(err);
    }
    const start = Math.min(off, size);
    const toRead = Math.min(want, size - start);
    const buf = Buffer.alloc(toRead);
    let rd = 0;
    while (rd < toRead) {
      const n = fs.readSync(fd, buf, rd, toRead - rd, start + rd);
      if (n <= 0) break;
      rd += n;
    }
    const eof = rd < want || start + rd >= size;
    return { data: buf.subarray(0, rd).toString('base64'), eof };
  } finally {
    try { fs.closeSync(fd); } catch (e) { /* guard */ }
  }
}

module.exports = { resolveWithin, listDir, readFile, readChunk, MIME };
