/**
 * Safe source access for the Web panel.
 *
 * Every path is resolved against one approved project root, realpath-checked,
 * and re-checked for containment before a byte is read. The client never sends
 * an absolute path and never gets to choose a different root.
 */

import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { isBinaryFile, languageOf, toPosix } from './core.js';
import { DEFAULT_IGNORED_DIRS } from './fs-scan.js';

const VIEWABLE_EXTS = new Set([
  '.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh', '.hxx',
  '.s', '.asm', '.ld', '.sct', '.icf',
  '.py', '.pyi', '.go', '.rs', '.java', '.kt', '.kts', '.cs', '.swift',
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts',
  '.rb', '.php', '.lua', '.sh', '.bash', '.ps1',
  '.sql', '.proto', '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini',
  '.cfg', '.conf', '.properties', '.xml', '.cmake', '.mk', '.gradle',
  '.md', '.markdown', '.rst', '.adoc', '.txt', '.csv', '.ioc',
  '.uvprojx', '.uvproj', '.ewp', '.eww', '.sln', '.csproj',
]);

const DENIED_BASENAMES = [
  /^\.env(?:\.|$)/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)$/i,
  /^credentials?(?:\.|$)/i,
  /^secrets?(?:\.|$)/i,
];
const DENIED_EXTS = new Set(['.pem', '.key', '.pfx', '.p12', '.kdbx', '.jks', '.keystore']);
const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_LINES_PER_REQUEST = 600;
const MAX_TREE_ENTRIES = 6000;
const HIDDEN_ALLOWED = new Set(['.github', '.gitlab', '.circleci', '.devcontainer']);

export class SourceAccessError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SourceAccessError';
    this.code = code;
  }
}

export function isDeniedFile(filePath) {
  const name = path.basename(filePath);
  if (DENIED_BASENAMES.some((pattern) => pattern.test(name))) return true;
  if (DENIED_EXTS.has(path.extname(name).toLowerCase())) return true;
  return false;
}

export function isViewableFile(filePath) {
  if (isDeniedFile(filePath)) return false;
  if (isBinaryFile(filePath)) return false;
  const ext = path.extname(filePath).toLowerCase();
  if (VIEWABLE_EXTS.has(ext)) return true;
  return Boolean(languageOf(filePath));
}

function sanitizeRelative(relative) {
  const raw = String(relative || '').trim();
  if (!raw) throw new SourceAccessError('PATH_REQUIRED', '缺少文件路径。');
  if (raw.includes('\0')) throw new SourceAccessError('PATH_INVALID', '路径包含非法字符。');
  const normalized = raw.replace(/\\/g, '/').replace(/^\/+/, '');
  if (/^[A-Za-z]:/.test(normalized)) throw new SourceAccessError('PATH_ABSOLUTE', '只接受项目内相对路径。');
  if (normalized.split('/').includes('..')) throw new SourceAccessError('PATH_TRAVERSAL', '路径不能包含 ..。');
  return normalized;
}

export async function resolveInsideRoot(root, relative) {
  const rootReal = await realpath(root);
  const clean = sanitizeRelative(relative);
  const absolute = path.resolve(rootReal, clean);
  const check = path.relative(rootReal, absolute);
  if (check.startsWith('..') || path.isAbsolute(check)) {
    throw new SourceAccessError('PATH_OUTSIDE', '路径不在项目根目录内。');
  }
  let real;
  try {
    real = await realpath(absolute);
  } catch {
    throw new SourceAccessError('FILE_NOT_FOUND', `文件不存在：${clean}`);
  }
  const realCheck = path.relative(rootReal, real);
  if (realCheck.startsWith('..') || path.isAbsolute(realCheck)) {
    throw new SourceAccessError('PATH_OUTSIDE', '符号链接指向项目根目录之外。');
  }
  return { root: rootReal, absolute: real, relative: toPosix(realCheck) };
}

export async function listProjectTree(root, options = {}) {
  const rootReal = await realpath(root);
  const maxEntries = Number.isFinite(options.maxEntries) ? options.maxEntries : MAX_TREE_ENTRIES;
  const maxDepth = Number.isFinite(options.maxDepth) ? options.maxDepth : 18;
  const nodes = [];
  const queue = [{ absolute: rootReal, relative: '', depth: 0 }];
  let truncated = false;

  while (queue.length) {
    const current = queue.shift();
    let entries;
    try {
      entries = await readdir(current.absolute, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((left, right) => {
      if (left.isDirectory() !== right.isDirectory()) return left.isDirectory() ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
    for (const entry of entries) {
      if (nodes.length >= maxEntries) {
        truncated = true;
        break;
      }
      const relative = current.relative ? `${current.relative}/${entry.name}` : entry.name;
      const absolute = path.join(current.absolute, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        const lower = entry.name.toLowerCase();
        if (DEFAULT_IGNORED_DIRS.has(lower)) continue;
        if (entry.name.startsWith('.') && !HIDDEN_ALLOWED.has(lower)) continue;
        if (current.depth + 1 > maxDepth) {
          truncated = true;
          continue;
        }
        nodes.push({ path: relative, type: 'dir', depth: current.depth + 1 });
        queue.push({ absolute, relative, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      if (!isViewableFile(relative)) continue;
      let info;
      try {
        info = await stat(absolute);
      } catch {
        continue;
      }
      nodes.push({
        path: relative,
        type: 'file',
        depth: current.depth + 1,
        size: info.size,
        lang: languageOf(relative)?.id || 'text',
      });
    }
    if (truncated) break;
  }

  return { nodes, truncated, total: nodes.length, root: rootReal };
}

export async function readProjectFile(root, relative, options = {}) {
  const resolved = await resolveInsideRoot(root, relative);
  if (!isViewableFile(resolved.relative)) {
    throw new SourceAccessError('FILE_TYPE_BLOCKED', '该文件类型不允许在面板中查看。');
  }
  const info = await stat(resolved.absolute);
  if (!info.isFile()) throw new SourceAccessError('NOT_A_FILE', '目标不是普通文件。');
  if (info.size > MAX_READ_BYTES) {
    throw new SourceAccessError('FILE_TOO_LARGE', `文件超过 ${Math.round(MAX_READ_BYTES / 1024)} KiB，无法整体读取。`);
  }
  const text = await readFile(resolved.absolute, 'utf8');
  const allLines = text.split(/\r\n|\n|\r/);
  if (allLines.length > 1 && allLines[allLines.length - 1] === '') allLines.pop();
  const totalLines = Math.max(1, allLines.length);
  const start = Math.max(1, Math.min(Number(options.start) || 1, totalLines));
  const requestedEnd = Number(options.end) || start + MAX_LINES_PER_REQUEST - 1;
  const end = Math.max(start, Math.min(requestedEnd, totalLines, start + MAX_LINES_PER_REQUEST - 1));
  const lines = [];
  for (let number = start; number <= end; number += 1) {
    lines.push({ number, text: allLines[number - 1] ?? '' });
  }
  return {
    path: resolved.relative,
    absolute: resolved.absolute,
    lang: languageOf(resolved.relative)?.id || 'text',
    size: info.size,
    mtimeMs: Math.floor(info.mtimeMs),
    totalLines,
    start,
    end,
    lines,
    truncated: end < totalLines,
  };
}

export async function readSnippet(root, relative, line, radius = 6) {
  try {
    const start = Math.max(1, Number(line || 1) - radius);
    const file = await readProjectFile(root, relative, { start, end: start + radius * 2 });
    return file.lines.map((entry) => `${entry.number}\t${entry.text}`).join('\n');
  } catch {
    return '';
  }
}

export async function fileStat(root, relative) {
  const resolved = await resolveInsideRoot(root, relative);
  const info = await stat(resolved.absolute);
  return { path: resolved.relative, size: info.size, mtimeMs: Math.floor(info.mtimeMs) };
}
