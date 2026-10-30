/**
 * Approved project registry for panel-driven imports.
 *
 * Only roots recorded here may be read by the source endpoints. A Web request
 * names an id, never an absolute path; the Host resolves the root, re-runs
 * realpath, and refuses a root that disappeared or changed identity.
 */

import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { nowIso, sha1, slugify, toPosix } from './core.js';
import { projectKey } from './fs-scan.js';

const REGISTRY_VERSION = 1;

export class ProjectRegistryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProjectRegistryError';
    this.code = code;
  }
}

export class ProjectRegistry {
  constructor(dataDir) {
    this.dataDir = path.resolve(dataDir);
    this.file = path.join(this.dataDir, 'projects.json');
    this.cache = null;
  }

  async load() {
    if (this.cache) return this.cache;
    let data = { version: REGISTRY_VERSION, projects: {} };
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed?.version === REGISTRY_VERSION && parsed.projects && typeof parsed.projects === 'object') {
        data = parsed;
      }
    } catch {
      /* first use */
    }
    this.cache = data;
    return data;
  }

  async save(data) {
    this.cache = data;
    await mkdir(this.dataDir, { recursive: true });
    const temporary = `${this.file}.tmp-${process.pid}`;
    const payload = JSON.stringify(data, null, 2);
    await writeFile(temporary, payload, 'utf8');
    try {
      await rename(temporary, this.file);
    } catch {
      await writeFile(this.file, payload, 'utf8');
    }
  }

  async add(root) {
    let real;
    try {
      real = await realpath(root);
    } catch {
      throw new ProjectRegistryError('PROJECT_NOT_FOUND', `目录不存在或不可访问：${root}`);
    }
    const info = await stat(real);
    if (!info.isDirectory()) throw new ProjectRegistryError('PROJECT_NOT_DIRECTORY', `不是目录：${real}`);
    const id = projectKey(real);
    const data = await this.load();
    const previous = data.projects[id];
    const entry = {
      id,
      root: toPosix(real),
      name: path.basename(real) || id,
      addedAt: previous?.addedAt || nowIso(),
      lastOpenedAt: nowIso(),
    };
    data.projects[id] = entry;
    await this.save(data);
    return entry;
  }

  async touch(id) {
    const data = await this.load();
    const entry = data.projects[id];
    if (!entry) return null;
    entry.lastOpenedAt = nowIso();
    await this.save(data);
    return entry;
  }

  async list() {
    const data = await this.load();
    return Object.values(data.projects).sort((left, right) => String(right.lastOpenedAt).localeCompare(String(left.lastOpenedAt)));
  }

  async get(id) {
    const data = await this.load();
    return data.projects[id] || null;
  }

  async resolve(id) {
    if (!id || !/^[a-z0-9._-]+$/i.test(String(id))) {
      throw new ProjectRegistryError('PROJECT_ID_INVALID', '项目 id 非法。');
    }
    const entry = await this.get(id);
    if (!entry) throw new ProjectRegistryError('PROJECT_UNKNOWN', '该项目尚未导入或已移除。');
    let real;
    try {
      real = await realpath(entry.root);
    } catch {
      throw new ProjectRegistryError('PROJECT_UNAVAILABLE', `项目目录不可访问：${entry.root}`);
    }
    if (toPosix(real) !== toPosix(entry.root)) {
      throw new ProjectRegistryError('PROJECT_MOVED', '项目目录的真实路径已变化，请重新导入。');
    }
    await this.touch(id);
    return { ...entry, root: real };
  }

  async syncFromIndex(projects) {
    const data = await this.load();
    let changed = false;
    for (const project of projects || []) {
      if (!project?.id || !project?.root || data.projects[project.id]) continue;
      data.projects[project.id] = {
        id: project.id,
        root: toPosix(project.root),
        name: project.name || path.basename(project.root),
        addedAt: project.updatedAt || nowIso(),
        lastOpenedAt: project.updatedAt || nowIso(),
      };
      changed = true;
    }
    if (changed) await this.save(data);
    return this.list();
  }

  async remove(id) {
    const data = await this.load();
    if (!data.projects[id]) return false;
    delete data.projects[id];
    await this.save(data);
    return true;
  }
}

export function projectRefId(root) {
  return projectKey(root);
}

export function shortProjectLabel(entry) {
  return `${entry.name} · ${sha1(entry.root.toLowerCase(), 4)}`;
}
