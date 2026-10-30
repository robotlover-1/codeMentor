/**
 * Filesystem inventory, command execution, Git facts and the per-project
 * knowledge store. No external dependency and no shell interpolation.
 */

import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  CodeMentorError,
  SCHEMA_VERSION,
  isAbortError,
  isBinaryFile,
  languageOf,
  oneLine,
  sha1,
  slugify,
  throwIfAborted,
  toPosix,
} from './core.js';

/* ---------------------------------------------------------------- inventory */

export const DEFAULT_IGNORED_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'bower_components', 'jspm_packages',
  'dist', 'build', 'out', 'output', 'coverage', 'target', 'bin', 'obj',
  'cmakefiles', 'cmake-build-debug', 'cmake-build-release', '.venv', 'venv', 'env',
  '__pycache__', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.tox', '.gradle',
  '.idea', '.vs', '.vscode-server', '.next', '.nuxt', '.svelte-kit', '.turbo',
  '.cache', '.parcel-cache', 'pods', 'deriveddata', '.dart_tool',
  'objects', 'listings', 'debugconfig', 'rte', '.settings',
  '.git-rewrite', '.yarn', '.pnpm-store',
]);

export const DEFAULT_VENDORED_DIRS = new Set([
  'drivers', 'middlewares', 'third_party', 'third-party', 'thirdparty', '3rdparty',
  'vendor', 'vendors', 'external', 'extern', 'deps', 'dependencies', 'submodules',
  'bower_components', 'jspm_packages', 'pods',
]);

const ALLOWED_HIDDEN_DIRS = new Set(['.github', '.gitlab', '.circleci', '.devcontainer', '.azure-pipelines']);

export function isVendoredPath(rel, vendoredDirs = DEFAULT_VENDORED_DIRS) {
  const segments = toPosix(rel).split('/');
  for (const segment of segments.slice(0, -1)) {
    const lower = segment.toLowerCase();
    if (vendoredDirs.has(lower)) return true;
  }
  return false;
}

/**
 * Breadth-first inventory. Symlinks are skipped (no loop risk), ignored
 * directories are pruned, and the file budget is reported instead of silently
 * cutting the project.
 */
export async function walkProject(root, options = {}, signal) {
  const maxFiles = Number.isFinite(options.maxFiles) ? options.maxFiles : 4000;
  const maxDepth = Number.isFinite(options.maxDepth) ? options.maxDepth : 24;
  const ignoredDirs = new Set(DEFAULT_IGNORED_DIRS);
  for (const name of options.excludeDirs || []) ignoredDirs.add(String(name).toLowerCase());

  const files = [];
  const directories = [];
  const skipped = [];
  let truncated = false;
  const queue = [{ abs: root, rel: '', depth: 0 }];

  while (queue.length) {
    throwIfAborted(signal);
    const current = queue.shift();
    let entries;
    try {
      entries = await readdir(current.abs, { withFileTypes: true });
    } catch (error) {
      skipped.push({ path: current.rel || '.', reason: errorInfoMessage(error) });
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const name = entry.name;
      const rel = current.rel ? `${current.rel}/${name}` : name;
      const abs = path.join(current.abs, name);

      if (entry.isSymbolicLink()) {
        skipped.push({ path: rel, reason: 'symlink skipped' });
        continue;
      }

      if (entry.isDirectory()) {
        const lower = name.toLowerCase();
        if (ignoredDirs.has(lower)) continue;
        if (name.startsWith('.') && !ALLOWED_HIDDEN_DIRS.has(lower)) continue;
        if (current.depth + 1 > maxDepth) {
          skipped.push({ path: rel, reason: `directory depth exceeds ${maxDepth}` });
          continue;
        }
        directories.push({ path: rel, depth: current.depth + 1 });
        queue.push({ abs, rel, depth: current.depth + 1 });
        continue;
      }

      if (!entry.isFile()) continue;
      if (isBinaryFile(name)) continue;
      if (files.length >= maxFiles) {
        truncated = true;
        continue;
      }

      let info;
      try {
        info = await stat(abs);
      } catch {
        skipped.push({ path: rel, reason: 'stat failed' });
        continue;
      }
      const language = languageOf(name);
      files.push({
        path: rel,
        abs,
        name,
        ext: path.extname(name).toLowerCase(),
        size: info.size,
        mtimeMs: Math.floor(info.mtimeMs),
        lang: language ? language.id : 'unknown',
        family: language ? language.family : 'other',
        source: Boolean(language),
      });
    }
  }

  files.sort((left, right) => left.path.localeCompare(right.path));
  directories.sort((left, right) => left.path.localeCompare(right.path));
  return { files, directories, skipped, truncated, maxFiles, maxDepth };
}

function errorInfoMessage(error) {
  return oneLine(error?.message || String(error), 160);
}

export async function readSourceText(target, maxBytes, signal) {
  throwIfAborted(signal);
  let info;
  try {
    info = await stat(target);
  } catch (error) {
    return { text: null, skipped: true, reason: errorInfoMessage(error) };
  }
  if (!info.isFile()) return { text: null, skipped: true, reason: 'not a regular file' };
  if (info.size > maxBytes) {
    return {
      text: null,
      skipped: true,
      reason: `file is ${info.size} bytes, above maxFileBytes=${maxBytes}`,
    };
  }
  try {
    const text = await readFile(target, 'utf8');
    return { text, skipped: false, size: info.size, mtimeMs: Math.floor(info.mtimeMs) };
  } catch (error) {
    return { text: null, skipped: true, reason: errorInfoMessage(error) };
  }
}

/* --------------------------------------------------------------- subprocess */

function readCollected(reader) {
  if (!reader?.readFrom) return '';
  try {
    return reader.readFrom(0).text || '';
  } catch {
    return '';
  }
}

function normalizeOutcome(handle, outcome, timedOut) {
  const stdout = readCollected(handle.collected?.stdout);
  const stderr = readCollected(handle.collected?.stderr);
  return {
    code: timedOut ? null : outcome?.exitCode ?? null,
    signal: timedOut ? 'TIMEOUT' : outcome?.signal || null,
    timedOut,
    stdout,
    stderr,
    truncated: Boolean(handle.collected?.stdout?.readFrom?.(0)?.lossy),
  };
}

function runWithChildProcess(argv, cwd, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(
      argv[0],
      argv.slice(1),
      { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true, signal },
      (error, stdout, stderr) => {
        if (error && isAbortError(error)) {
          reject(error);
          return;
        }
        if (error && error.killed) {
          resolve({ code: null, signal: 'TIMEOUT', timedOut: true, stdout: stdout || '', stderr: stderr || '', truncated: false });
          return;
        }
        if (error && typeof error.code === 'number') {
          resolve({ code: error.code, signal: null, timedOut: false, stdout: stdout || '', stderr: stderr || '', truncated: false });
          return;
        }
        if (error) {
          reject(new CodeMentorError('COMMAND_FAILED', errorInfoMessage(error)));
          return;
        }
        resolve({ code: 0, signal: null, timedOut: false, stdout: stdout || '', stderr: stderr || '', truncated: false });
      },
    );
  });
}

/**
 * Command runner backed by the Harness subprocess service when it is mounted,
 * with a local execFile fallback for tests and minimal profiles.
 */
export function createCommandRunner(ctx, config = {}) {
  const subprocess = typeof ctx?.get === 'function' ? ctx.get('subprocess') : undefined;
  const defaultTimeout = Number.isFinite(config.commandTimeoutMs) ? config.commandTimeoutMs : 60_000;

  async function run(argv, cwd, options = {}) {
    if (!Array.isArray(argv) || argv.length === 0) {
      throw new CodeMentorError('COMMAND_INVALID', 'command argv must be a non-empty array');
    }
    const signal = options.signal;
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : defaultTimeout;
    throwIfAborted(signal);
    if (!subprocess) return runWithChildProcess(argv, cwd, signal, timeoutMs);

    const executable = await subprocess.resolveExecutable(argv[0], undefined, signal);
    const handle = subprocess.spawn({
      argv: [executable, ...argv.slice(1)],
      cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 1024 * 1024 },
        stderr: { maxBytes: 512 * 1024 },
      },
      graceMs: 2000,
      signal,
    });

    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
      if (typeof timer?.unref === 'function') timer.unref();
    });
    let settled;
    try {
      settled = await Promise.race([handle.done.then((outcome) => ({ outcome })), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (settled === 'timeout') {
      handle.terminate();
      try {
        await handle.done;
      } catch {
        /* termination is best effort */
      }
      return normalizeOutcome(handle, undefined, true);
    }
    return normalizeOutcome(handle, settled.outcome, false);
  }

  return { run, mode: subprocess ? 'subprocess-service' : 'local-execfile' };
}

/* ---------------------------------------------------------------------- git */

export async function gitInfo(run, root, signal) {
  try {
    const inside = await run(['git', 'rev-parse', '--is-inside-work-tree'], root, { signal, timeoutMs: 15_000 });
    if (inside.code !== 0 || !inside.stdout.includes('true')) {
      return { available: false, reason: oneLine(inside.stderr || 'not a git work tree', 200) };
    }
    const top = await run(['git', 'rev-parse', '--show-toplevel'], root, { signal, timeoutMs: 15_000 });
    const commit = await run(['git', 'rev-parse', 'HEAD'], root, { signal, timeoutMs: 15_000 });
    const branch = await run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], root, { signal, timeoutMs: 15_000 });
    const status = await run(['git', 'status', '--porcelain'], root, { signal, timeoutMs: 20_000 });
    const log = await run(
      ['git', 'log', '-n', '8', '--date=short', '--pretty=format:%h|%ad|%s'],
      root,
      { signal, timeoutMs: 20_000 },
    );
    const dirtyFiles = status.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => ({ status: line.slice(0, 2).trim(), path: line.slice(3).trim() }));
    const recent = log.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [hash, date, ...subject] = line.split('|');
        return { hash, date, subject: subject.join('|') };
      });
    return {
      available: true,
      topLevel: toPosix(top.stdout.trim()) || null,
      commit: commit.stdout.trim() || null,
      branch: branch.stdout.trim() || null,
      dirty: dirtyFiles.length > 0,
      dirtyCount: dirtyFiles.length,
      dirtyFiles,
      recent,
      reason: '',
    };
  } catch (error) {
    if (isAbortError(error)) throw error;
    return { available: false, reason: errorInfoMessage(error) };
  }
}

export async function gitChangedFiles(run, root, fromCommit, signal) {
  if (!fromCommit) return { ok: false, reason: 'no previous commit recorded' };
  try {
    const diff = await run(
      ['git', 'diff', '--name-status', fromCommit, 'HEAD'],
      root,
      { signal, timeoutMs: 30_000 },
    );
    if (diff.code !== 0) {
      return { ok: false, reason: oneLine(diff.stderr || 'git diff failed', 200) };
    }
    const files = diff.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const parts = line.split('\t');
        const status = parts[0];
        const file = parts.length > 2 ? parts[2] : parts[1];
        return { status, path: toPosix(file || '') };
      })
      .filter((entry) => entry.path);
    return { ok: true, from: fromCommit, to: 'HEAD', files, raw: oneLine(diff.stdout, 4000) };
  } catch (error) {
    if (isAbortError(error)) throw error;
    return { ok: false, reason: errorInfoMessage(error) };
  }
}

/* -------------------------------------------------------------------- store */

function normalizeRoot(root) {
  return toPosix(path.resolve(root));
}

function projectKey(root) {
  const normalized = normalizeRoot(root);
  return `${slugify(path.basename(normalized) || 'project')}-${sha1(normalized.toLowerCase(), 8)}`;
}

export function defaultDataDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'codementor');
}

export class KnowledgeStore {
  constructor(options = {}) {
    this.dataDir = path.resolve(options.dataDir || defaultDataDir());
    this.logger = options.logger;
    this.locks = new Map();
  }

  projectDir(root) {
    return path.join(this.dataDir, 'projects', projectKey(root));
  }

  knowledgePath(root) {
    return path.join(this.projectDir(root), 'knowledge.json');
  }

  indexPath() {
    return path.join(this.dataDir, 'index.json');
  }

  async withLock(root, operation) {
    const key = projectKey(root);
    const previous = this.locks.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    this.locks.set(key, previous.then(() => current));
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(key) === current) this.locks.delete(key);
    }
  }

  async load(root) {
    const target = this.knowledgePath(root);
    try {
      const raw = await readFile(target, 'utf8');
      const data = JSON.parse(raw);
      if (data?.schemaVersion !== SCHEMA_VERSION) {
        return { ok: false, reason: `cache schema ${data?.schemaVersion} != ${SCHEMA_VERSION}` };
      }
      if (data?.pluginVersion !== undefined && data.pluginVersion !== undefined) {
        /* plugin upgrades keep the cache when the schema is compatible */
      }
      return { ok: true, data, path: toPosix(target) };
    } catch (error) {
      if (error?.code === 'ENOENT') return { ok: false, reason: 'no cached knowledge for this project' };
      return { ok: false, reason: `cache unreadable: ${errorInfoMessage(error)}` };
    }
  }

  async save(root, data) {
    const directory = this.projectDir(root);
    await mkdir(directory, { recursive: true });
    const target = this.knowledgePath(root);
    const temporary = `${target}.tmp-${process.pid}`;
    const payload = JSON.stringify(data, null, 2);
    await writeFile(temporary, payload, 'utf8');
    try {
      await rename(temporary, target);
    } catch {
      await writeFile(target, payload, 'utf8');
    }
    await this.updateIndex(root, data);
    return toPosix(target);
  }

  async updateIndex(root, data) {
    const target = this.indexPath();
    let index = { schemaVersion: SCHEMA_VERSION, projects: [] };
    try {
      const raw = await readFile(target, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed?.schemaVersion === SCHEMA_VERSION && Array.isArray(parsed.projects)) index = parsed;
    } catch {
      /* first write */
    }
    const entry = {
      id: projectKey(root),
      root: normalizeRoot(root),
      name: data?.name || path.basename(root),
      updatedAt: data?.updatedAt || new Date().toISOString(),
      commit: data?.git?.commit || null,
      languages: (data?.inventory?.languages || data?.stack?.languages || []).slice(0, 3).map((item) => item.name),
      modules: data?.modules?.length || 0,
      entryPoints: data?.entryPoints?.length || 0,
    };
    const projects = index.projects.filter((item) => item.id !== entry.id);
    projects.push(entry);
    projects.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify({ schemaVersion: SCHEMA_VERSION, projects }, null, 2), 'utf8');
  }

  async list() {
    try {
      const raw = await readFile(this.indexPath(), 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed?.schemaVersion !== SCHEMA_VERSION) return [];
      return Array.isArray(parsed.projects) ? parsed.projects : [];
    } catch {
      return [];
    }
  }

  async loadById(id) {
    const projects = await this.list();
    const entry = projects.find((item) => item.id === id);
    if (!entry) return { ok: false, reason: `unknown project id: ${id}` };
    return this.load(entry.root);
  }
}

export { projectKey, normalizeRoot };
