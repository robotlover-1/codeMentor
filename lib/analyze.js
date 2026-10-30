/**
 * Project discovery, module graph, evidence-bearing architecture analysis and
 * call-chain tracing.
 *
 * Facts and inferences are kept apart on purpose:
 *   - `source`     directly visible in a file (path + line)
 *   - `doc`        stated by README or another document
 *   - `inference`  derived by CodeMentor's heuristics; must be re-checked
 *   - `unverified` not confirmed; never presented as fact
 */

import path from 'node:path';

import {
  CodeMentorError,
  KNOWN_VOID_CALLS,
  SCHEMA_VERSION,
  PLUGIN_VERSION,
  clamp,
  countLines,
  declaredReturnType,
  extnameLower,
  groupBy,
  isConfigFile,
  isDocFile,
  isSourceLanguage,
  languageOf,
  normalize,
  nowIso,
  oneLine,
  round,
  splitLines,
  stripMarkdown,
  throwIfAborted,
  toPosix,
  truncate,
  uniqueBy,
} from './core.js';
import {
  DEFAULT_VENDORED_DIRS,
  gitChangedFiles,
  gitInfo,
  isVendoredPath,
  readSourceText,
  walkProject,
} from './fs-scan.js';
import { emptyFileRecord, parseSource } from './parse.js';

const MANIFEST_RULES = [
  { id: 'cmake', name: 'CMake', files: ['CMakeLists.txt'], kind: 'build' },
  { id: 'make', name: 'Make', files: ['Makefile', 'makefile', 'GNUmakefile'], kind: 'build' },
  { id: 'keil', name: 'Keil MDK', exts: ['.uvprojx', '.uvproj'], kind: 'ide' },
  { id: 'iar', name: 'IAR EWARM', exts: ['.ewp', '.eww'], kind: 'ide' },
  { id: 'cubemx', name: 'STM32CubeMX', exts: ['.ioc'], kind: 'generator' },
  { id: 'npm', name: 'npm / Node.js', files: ['package.json'], kind: 'package' },
  { id: 'pnpm', name: 'pnpm workspace', files: ['pnpm-workspace.yaml'], kind: 'workspace' },
  { id: 'yarn', name: 'Yarn workspace', files: ['yarn.lock'], kind: 'workspace' },
  { id: 'cargo', name: 'Cargo', files: ['Cargo.toml'], kind: 'package' },
  { id: 'go', name: 'Go modules', files: ['go.mod'], kind: 'package' },
  { id: 'maven', name: 'Maven', files: ['pom.xml'], kind: 'build' },
  { id: 'gradle', name: 'Gradle', files: ['build.gradle', 'build.gradle.kts'], kind: 'build' },
  { id: 'python', name: 'Python packaging', files: ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt'], kind: 'package' },
  { id: 'dotnet', name: '.NET', exts: ['.sln', '.csproj', '.fsproj'], kind: 'build' },
  { id: 'xcode', name: 'Xcode', exts: ['.xcodeproj', '.xcworkspace'], kind: 'ide' },
  { id: 'rust-toolchain', name: 'Rust toolchain', files: ['rust-toolchain', 'rust-toolchain.toml'], kind: 'toolchain' },
];

const TEST_PATH_PATTERNS = [
  /(^|\/)(tests?|__tests__|spec|specs)\//i,
  /\.(test|spec)\.[a-z0-9]+$/i,
  /(^|\/)test_[^/]+\.py$/i,
  /_test\.(go|c|cc|cpp|py|rs|js|ts|tsx)$/i,
  /(^|\/)[^/]+Tests?\.(cs|java|kt)$/i,
];

const SECRET_PATTERNS = [
  { kind: 'private-key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { kind: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { kind: 'generic-secret', pattern: /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|client[_-]?secret)\b\s*[:=]\s*['"]?([^\s'"]{6,})/i },
];

const SECRET_CONFIG_EXTS = new Set(['.env', '.ini', '.cfg', '.conf', '.properties', '.yaml', '.yml', '.json', '.toml', '.xml', '.pem', '.key']);

/* --------------------------------------------------------------- utilities */

function posixJoin(...parts) {
  return toPosix(path.posix.join(...parts.map((part) => toPosix(part))));
}

function posixDirname(value) {
  return toPosix(path.posix.dirname(toPosix(value)));
}

function baseName(value) {
  return path.posix.basename(toPosix(value));
}

function moduleIdOfPath(modulePath) {
  return toPosix(modulePath || '(root)').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'root';
}

function snippetOf(text, line, max = 120) {
  const lines = splitLines(text);
  return truncate((lines[line - 1] || '').trim(), max);
}

function makeEvidence(file, line, symbol = '') {
  return { file: toPosix(file), line: Number(line) || 1, symbol: symbol || '' };
}

function evidenceText(evidence) {
  if (!evidence?.length) return '';
  const first = evidence[0];
  return `${first.file}:${first.line}`;
}

/* --------------------------------------------------------------- readme/docs */

export function parseReadme(text, file) {
  const lines = splitLines(text);
  let title = '';
  const headings = [];
  const paragraphs = [];
  const commands = [];
  let current = '';
  let currentStart = 0;
  let inFence = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^```/.test(line.trim())) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      const trimmed = line.trim();
      if (trimmed && /^(?:\$ |>\s*)?(?:npm|pnpm|yarn|npx|node|python3?|pip3?|cargo|go|make|cmake|gcc|g\+\+|clang|dotnet|mvn|gradle|\.\/gradlew|java|git|uv|poetry|keil|arm-none-eabi-gcc)\b/.test(trimmed)) {
        commands.push({ command: truncate(trimmed.replace(/^\$\s*/, ''), 160), line: index + 1 });
      }
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      headings.push({ level: heading[1].length, title: stripMarkdown(heading[2]), line: index + 1 });
      if (heading[1].length === 1 && !title) title = stripMarkdown(heading[2]);
      current = heading[1].length <= 3 ? stripMarkdown(heading[2]) : current;
      currentStart = index + 2;
      continue;
    }
    if (!line.trim()) continue;
    if (line.trim().startsWith('|')) continue;
    if (/^\s*[-*+]\s+/.test(line)) continue;
    if (paragraphs.length < 6 && line.trim().length > 40) {
      paragraphs.push({ text: truncate(stripMarkdown(line), 400), line: index + 1, section: current });
    }
  }

  const summary = paragraphs.slice(0, 2).map((entry) => entry.text).join(' ');
  return {
    path: toPosix(file),
    title: title || baseName(file),
    summary: truncate(summary, 700),
    headings: headings.slice(0, 40),
    commands: uniqueBy(commands, (entry) => entry.command).slice(0, 30),
    paragraphs: paragraphs.slice(0, 5),
  };
}

/* ------------------------------------------------------------- build systems */

function detectManifests(walk, vendoredDirs) {
  const found = [];
  for (const rule of MANIFEST_RULES) {
    const matches = walk.files.filter((file) => {
      if (isVendoredPath(file.path, vendoredDirs)) return false;
      if (rule.files && rule.files.some((name) => baseName(file.path).toLowerCase() === name.toLowerCase())) return true;
      if (rule.exts && rule.exts.some((ext) => file.path.toLowerCase().endsWith(ext))) return true;
      return false;
    });
    for (const file of matches.slice(0, 6)) {
      found.push({ id: rule.id, name: rule.name, kind: rule.kind, manifest: file.path });
    }
  }
  return found;
}

function packageJsonScripts(text) {
  try {
    const parsed = JSON.parse(text);
    const scripts = parsed?.scripts && typeof parsed.scripts === 'object' ? parsed.scripts : {};
    const dependencies = { ...(parsed?.dependencies || {}), ...(parsed?.devDependencies || {}) };
    return {
      name: typeof parsed?.name === 'string' ? parsed.name : '',
      version: typeof parsed?.version === 'string' ? parsed.version : '',
      main: typeof parsed?.main === 'string' ? parsed.main : '',
      scripts: Object.entries(scripts).map(([name, command]) => ({ name, command: truncate(String(command), 160) })),
      dependencies: Object.keys(dependencies).slice(0, 80),
      description: typeof parsed?.description === 'string' ? parsed.description : '',
      bin: typeof parsed?.bin === 'string' ? [parsed.bin] : parsed?.bin && typeof parsed.bin === 'object' ? Object.values(parsed.bin).map(String) : [],
    };
  } catch {
    return null;
  }
}

function cmakeTargets(text) {
  const targets = [];
  for (const match of text.matchAll(/\b(?:add_executable|add_library)\s*\(\s*([A-Za-z0-9_.-]+)/g)) {
    targets.push({ name: match[1], library: /add_library/.test(match[0]) });
  }
  const project = /\bproject\s*\(\s*([A-Za-z0-9_.-]+)/.exec(text);
  return { project: project ? project[1] : '', targets: targets.slice(0, 20) };
}

function makeTargets(text) {
  const targets = [];
  for (const line of splitLines(text)) {
    const match = /^([A-Za-z0-9_.-]+)\s*:(?!=)/.exec(line);
    if (match && !match[1].startsWith('.')) targets.push(match[1]);
  }
  return [...new Set(targets)].slice(0, 30);
}

function uvprojxTargets(text) {
  const targets = [];
  for (const match of text.matchAll(/<TargetName>([^<]+)<\/TargetName>/g)) targets.push(match[1]);
  return [...new Set(targets)].slice(0, 10);
}

function buildCommands(manifests, texts, tests) {
  const commands = [];
  const seen = new Set();
  const add = (label, argv, kind, available = true, reason = '') => {
    const display = argv.join(' ');
    if (seen.has(display)) return;
    seen.add(display);
    commands.push({ label, argv, display, kind, available, reason });
  };

  const packageInfo = manifests.find((item) => item.id === 'npm');
  const packageData = packageInfo ? packageJsonScripts(texts.get(packageInfo.manifest) || '') : null;
  if (packageData && packageInfo) {
    const prefix = packageInfo.manifest.includes('/') ? posixDirname(packageInfo.manifest) : '';
    const scriptNames = packageData.scripts.map((script) => script.name);
    for (const script of ['build', 'test', 'lint', 'typecheck', 'check']) {
      if (!scriptNames.includes(script)) continue;
      const definition = packageData.scripts.find((item) => item.name === script);
      const direct = /^node\s+([^\s]+)\s*$/.exec(String(definition?.command || '').trim());
      if (direct) {
        add(
          `node ${direct[1]}${prefix && prefix !== '.' ? ` (${prefix})` : ''}`,
          prefix && prefix !== '.' ? ['node', posixJoin(prefix, direct[1])] : ['node', direct[1]],
          script === 'test' ? 'test' : 'build',
        );
      } else {
        add(
          `npm run ${script}${prefix && prefix !== '.' ? ` (${prefix})` : ''}`,
          prefix && prefix !== '.' ? ['npm', '--prefix', prefix, 'run', script] : ['npm', 'run', script],
          script === 'test' ? 'test' : 'build',
        );
      }
    }
  }

  const cmake = manifests.find((item) => item.id === 'cmake');
  if (cmake) {
    const sourceDir = cmake.manifest.includes('/') ? posixDirname(cmake.manifest) : '.';
    const buildDir = sourceDir === '.' ? 'build' : `${sourceDir}/build`;
    add('配置 CMake', ['cmake', '-S', sourceDir, '-B', buildDir], 'configure');
    add('构建 CMake', ['cmake', '--build', buildDir], 'build');
  }
  if (manifests.some((item) => item.id === 'make')) add('make', ['make'], 'build');
  if (manifests.some((item) => item.id === 'go')) add('go test ./...', ['go', 'test', './...'], 'test');
  if (manifests.some((item) => item.id === 'cargo')) add('cargo test', ['cargo', 'test', '-q'], 'test');
  if (manifests.some((item) => item.id === 'maven')) add('mvn test', ['mvn', '-q', 'test'], 'test');
  if (manifests.some((item) => item.id === 'gradle')) add('gradlew test', ['./gradlew', 'test'], 'test');
  if (tests.frameworks.includes('pytest')) add('python -m pytest -q', ['python', '-m', 'pytest', '-q'], 'test');
  const keil = manifests.find((item) => item.id === 'keil');
  if (keil) {
    add('Keil MDK 构建', ['UV4.exe', '-b', keil.manifest, '-o', 'build.log'], 'build', false, '需要 Keil MDK 工具链与图形环境，CodeMentor 不会自动调用');
  }
  return { commands, packageData };
}

/* ------------------------------------------------------------------- modules */

function directSourceCounts(sourceFiles) {
  const counts = new Map();
  for (const file of sourceFiles) {
    const dir = posixDirname(file.path);
    counts.set(dir, (counts.get(dir) || 0) + 1);
  }
  return counts;
}

function moduleDirFor(filePath, counts) {
  const segments = toPosix(filePath).split('/');
  const dirs = segments.slice(0, -1);
  if (!dirs.length) return '';
  for (let depth = dirs.length; depth >= 1; depth -= 1) {
    const candidate = dirs.slice(0, depth).join('/');
    if ((counts.get(candidate) || 0) >= 2) return candidate;
  }
  return dirs.join('/');
}

function vendoredGroupFor(filePath) {
  const segments = toPosix(filePath).split('/');
  if (segments.length <= 1) return segments[0] || '(root)';
  return segments.slice(0, 2).join('/');
}

/* ------------------------------------------------------------ import resolve */

function buildFileLookup(allFiles) {
  const byPath = new Set();
  const byBasename = new Map();
  for (const file of allFiles) {
    byPath.add(file.path);
    const name = baseName(file.path);
    const list = byBasename.get(name);
    if (list) list.push(file.path);
    else byBasename.set(name, [file.path]);
  }
  return { byPath, byBasename };
}

function resolveRelative(fromPath, target, lookup) {
  const base = posixJoin(posixDirname(fromPath), target);
  const candidates = [
    base,
    `${base}.h`, `${base}.hpp`, `${base}.c`, `${base}.cpp`,
    `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`, `${base}.py`, `${base}.go`, `${base}.rs`,
    posixJoin(base, 'index.ts'), posixJoin(base, 'index.js'), posixJoin(base, 'index.tsx'),
    posixJoin(base, 'mod.rs'),
  ];
  for (const candidate of candidates) {
    if (lookup.byPath.has(candidate)) return candidate;
  }
  const fallback = lookup.byBasename.get(baseName(base));
  return fallback && fallback.length ? fallback[0] : null;
}

function resolveImport(fromPath, target, kind, lookup, language) {
  if (!target) return { to: null, external: true };
  const clean = target.split('?')[0];
  if (kind === 'include') {
    if (clean.startsWith('.')) return { to: resolveRelative(fromPath, clean, lookup), external: false };
    const matches = lookup.byBasename.get(baseName(clean));
    return { to: matches && matches.length ? matches[0] : null, external: !matches || !matches.length };
  }
  if (kind === 'import' || kind === 'use') {
    if (clean.startsWith('.')) return { to: resolveRelative(fromPath, clean, lookup), external: false };
    if (language?.family === 'python') {
      const relative = clean.replace(/\./g, '/');
      const matches = lookup.byBasename.get(`${relative.split('/').pop()}.py`);
      if (matches && matches.length) return { to: matches[0], external: false };
      return { to: null, external: true };
    }
    if (language?.family === 'go') {
      const tail = clean.split('/').slice(-2).join('/');
      const match = [...lookup.byPath].find((candidate) => candidate.endsWith(`${tail}.go`) || candidate.endsWith(`${tail}/`));
      if (match) return { to: match, external: false };
      return { to: null, external: true };
    }
    if (language?.family === 'java') {
      const name = clean.split('.').pop() || '';
      const matches = lookup.byBasename.get(`${name}.java`) || lookup.byBasename.get(`${name}.kt`) || lookup.byBasename.get(`${name}.cs`);
      return { to: matches && matches.length ? matches[0] : null, external: !matches || !matches.length };
    }
    return { to: null, external: true };
  }
  return { to: null, external: true };
}

/* ------------------------------------------------------------------ assembly */

function pickStartup(walk, texts, vendoredDirs) {
  const candidates = walk.files.filter((file) => /(^|\/)startup[\w.-]*\.s$/i.test(file.path));
  if (!candidates.length) return null;
  let chip = '';
  for (const text of texts.values()) {
    const ioc = /Mcu\.Name\s*=\s*([A-Za-z0-9_()\- ]+)/.exec(text);
    if (ioc) {
      chip = ioc[1].toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 9);
      break;
    }
    const device = /<Device>\s*([^<]+)<\/Device>/.exec(text);
    if (device) {
      chip = device[1].toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 9);
      break;
    }
  }
  const scoreOf = (file) => {
    let score = 0;
    if (!isVendoredPath(file.path, vendoredDirs)) score += 4;
    if (chip && file.path.toLowerCase().includes(chip.slice(0, 7))) score += 3;
    if (/mdk-arm|ewarm/i.test(file.path)) score += 1;
    score += Math.min(1, file.size / 100_000);
    return score;
  };
  return [...candidates].sort((left, right) => scoreOf(right) - scoreOf(left))[0];
}

export async function scanProject({ root, options = {}, runner, previous = null, signal, logger }) {
  const started = Date.now();
  const rootAbs = path.resolve(root);
  const diagnostics = [];
  const maxFileBytes = Number.isFinite(options.maxFileBytes) ? options.maxFileBytes : 512 * 1024;
  const maxParseFiles = Number.isFinite(options.maxParseFiles) ? options.maxParseFiles : 600;
  const maxParseBytes = Number.isFinite(options.maxParseBytes) ? options.maxParseBytes : 32 * 1024 * 1024;
  const includeVendored = options.includeVendored === true;
  const vendoredDirs = new Set(DEFAULT_VENDORED_DIRS);
  for (const name of options.vendoredDirs || []) vendoredDirs.add(String(name).toLowerCase());

  throwIfAborted(signal);
  const walk = await walkProject(rootAbs, options, signal);
  if (walk.truncated) {
    diagnostics.push({ level: 'warn', code: 'FILE_BUDGET', message: `文件数量超过 maxFiles=${walk.maxFiles}，已截断；可通过 Config 提高上限。` });
  }

  const git = await gitInfo(runner.run, rootAbs, signal);
  if (!git.available) {
    diagnostics.push({ level: 'info', code: 'GIT_UNAVAILABLE', message: `Git 信息不可用：${git.reason}` });
  }

  const manifestCandidates = detectManifests(walk, vendoredDirs);
  const texts = new Map();
  const readManifest = async (rel) => {
    if (texts.has(rel)) return texts.get(rel);
    const entry = walk.files.find((file) => file.path === rel);
    if (!entry) return '';
    const read = await readSourceText(entry.abs, Math.min(maxFileBytes, 256 * 1024), signal);
    const text = read.text || '';
    texts.set(rel, text);
    return text;
  };

  for (const manifest of manifestCandidates.slice(0, 40)) {
    await readManifest(manifest.manifest);
  }

  const readmeCandidates = walk.files.filter((file) =>
    isDocFile(file.path) && /^readme(\.[a-z]+)?$/i.test(baseName(file.path)),
  );
  const docsCandidates = walk.files.filter((file) => isDocFile(file.path) && !/^readme(\.[a-z]+)?$/i.test(baseName(file.path)));
  const readmeEntry = readmeCandidates[0] || null;
  const readmeText = readmeEntry ? (await readSourceText(readmeEntry.abs, Math.min(maxFileBytes, 256 * 1024), signal)).text || '' : '';
  const readme = readmeEntry && readmeText ? parseReadme(readmeText, readmeEntry.path) : null;

  const sourceFiles = walk.files.filter((file) => {
    const language = languageOf(file.path);
    return language && isSourceLanguage(language);
  });
  const nonVendoredSources = sourceFiles.filter((file) => !isVendoredPath(file.path, vendoredDirs));
  const vendoredSources = sourceFiles.filter((file) => isVendoredPath(file.path, vendoredDirs));

  const previousFiles = new Map((previous?.files || []).map((file) => [file.path, file]));
  const schemaCompatible = previous?.schemaVersion === SCHEMA_VERSION;
  const changed = { added: [], modified: [], removed: [] };
  const files = [];
  let parsedFiles = 0;
  let parsedBytes = 0;
  const skipped = [];

  for (const entry of nonVendoredSources) {
    throwIfAborted(signal);
    const language = languageOf(entry.path);
    const cached = schemaCompatible ? previousFiles.get(entry.path) : null;
    if (
      !options.force
      && cached
      && cached.mtimeMs === entry.mtimeMs
      && cached.size === entry.size
      && cached.lang === language.id
      && cached.signals
    ) {
      files.push(cached);
      continue;
    }
    if (parsedFiles >= maxParseFiles || parsedBytes >= maxParseBytes) {
      skipped.push({ path: entry.path, reason: `parse budget exhausted (maxParseFiles=${maxParseFiles})` });
      diagnostics.push({ level: 'warn', code: 'PARSE_BUDGET', message: `解析预算用尽（${maxParseFiles} 个文件），后续文件未解析。` });
      files.push(emptyFileRecord({ ...entry, lang: language.id, family: language.family }, 'parse budget exhausted'));
      continue;
    }
    const read = await readSourceText(entry.abs, maxFileBytes, signal);
    if (read.skipped) {
      skipped.push({ path: entry.path, reason: read.reason });
      files.push(emptyFileRecord({ ...entry, lang: language.id, family: language.family }, read.reason));
      continue;
    }
    const record = parseSource(read.text, { path: entry.path, size: entry.size, mtimeMs: entry.mtimeMs }, language);
    parsedFiles += 1;
    parsedBytes += read.text.length;
    if (cached) changed.modified.push(entry.path);
    else changed.added.push(entry.path);
    files.push(record);
  }

  // Startup assembly is usually vendored; parse the most relevant startup file
  // anyway so the reset path is a source fact instead of a guess.
  const startupEntry = pickStartup(walk, texts, vendoredDirs);
  if (startupEntry) {
    const read = await readSourceText(startupEntry.abs, 256 * 1024, signal);
    if (read.text) {
      const language = languageOf(startupEntry.path) || { id: 'asm', family: 'asm' };
      files.push(parseSource(read.text, { path: startupEntry.path, size: startupEntry.size, mtimeMs: startupEntry.mtimeMs }, language));
      nonVendoredSources.push(startupEntry);
    }
  }

  if (schemaCompatible) {
    const currentPaths = new Set(nonVendoredSources.map((file) => file.path));
    for (const cached of previousFiles.keys()) {
      if (!currentPaths.has(cached)) changed.removed.push(cached);
    }
  }

  const lookups = buildFileLookup(walk.files);

  /* ---------------------------------------------------------------- modules */

  const sourceCounts = directSourceCounts(nonVendoredSources);
  const modulePathByFile = new Map();
  const moduleRecords = new Map();
  const ensureModule = (modulePath, kind) => {
    const id = moduleIdOfPath(modulePath);
    let record = moduleRecords.get(id);
    if (!record) {
      record = {
        id,
        name: modulePath || '(root)',
        path: modulePath,
        kind,
        vendored: kind === 'vendored',
        files: 0,
        sourceFiles: 0,
        loc: 0,
        bytes: 0,
        symbols: 0,
        structures: 0,
        languages: [],
        metrics: { fanIn: 0, fanOut: 0, crossModuleCalls: 0, callIn: 0 },
        importance: { fanIn: 0, fanOut: 0, symbols: 0, loc: 0, entryBoost: 0, score: 0 },
        deps: [],
        dependents: [],
        topFiles: [],
        evidence: [],
      };
      moduleRecords.set(id, record);
    }
    return record;
  };

  for (const file of nonVendoredSources) {
    const dir = moduleDirFor(file.path, sourceCounts);
    modulePathByFile.set(file.path, dir || '');
    const record = ensureModule(dir || '', 'source');
    record.files += 1;
    record.sourceFiles += 1;
    record.bytes += file.size;
    const language = languageOf(file.path);
    if (language && !record.languages.includes(language.id)) record.languages.push(language.id);
  }

  for (const file of vendoredSources) {
    const group = vendoredGroupFor(file.path);
    const record = ensureModule(group, 'vendored');
    record.files += 1;
    record.bytes += file.size;
    const language = languageOf(file.path);
    if (language && !record.languages.includes(language.id)) record.languages.push(language.id);
  }

  const fileByPath = new Map(files.map((file) => [file.path, file]));
  for (const [filePath, modulePath] of modulePathByFile.entries()) {
    const record = fileByPath.get(filePath);
    const module = moduleRecords.get(moduleIdOfPath(modulePath));
    if (!record || !module) continue;
    module.loc += record.loc || 0;
    module.symbols += record.symbols.length;
    module.structures += record.structures.length;
  }

  const vendorFileModule = new Map();
  for (const file of vendoredSources) vendorFileModule.set(file.path, moduleIdOfPath(vendoredGroupFor(file.path)));

  const importEdges = [];
  const externalImports = new Map();
  for (const file of files) {
    if (!file.imports?.length) continue;
    const fromModule = modulePathByFile.has(file.path)
      ? moduleIdOfPath(modulePathByFile.get(file.path))
      : vendorFileModule.get(file.path);
    const language = languageOf(file.path);
    for (const imported of file.imports) {
      const resolved = resolveImport(file.path, imported.target, imported.kind, lookups, language);
      if (!resolved.to) {
        const key = imported.target;
        externalImports.set(key, (externalImports.get(key) || 0) + 1);
        continue;
      }
      const toModule = modulePathByFile.has(resolved.to)
        ? moduleIdOfPath(modulePathByFile.get(resolved.to))
        : vendorFileModule.get(resolved.to);
      if (!fromModule || !toModule || fromModule === toModule) continue;
      importEdges.push({ from: fromModule, to: toModule, file: file.path, line: imported.line, kind: imported.kind });
    }
  }

  const modules = [...moduleRecords.values()].filter((module) => module.files > 0);
  for (const edge of importEdges) {
    const from = moduleRecords.get(edge.from);
    const to = moduleRecords.get(edge.to);
    if (!from || !to) continue;
    if (!from.deps.includes(edge.to)) from.deps.push(edge.to);
    if (!to.dependents.includes(edge.from)) to.dependents.push(edge.from);
  }

  /* ---------------------------------------------------------------- symbols */

  const symbols = [];
  const structures = [];
  for (const file of files) {
    const moduleId = modulePathByFile.has(file.path) ? moduleIdOfPath(modulePathByFile.get(file.path)) : '';
    for (const symbol of file.symbols) {
      symbols.push({
        ...symbol,
        id: `${file.path}::${symbol.name}:${symbol.line}`,
        file: file.path,
        module: moduleId,
        lang: file.lang,
        vendored: false,
      });
    }
    for (const structure of file.structures) {
      structures.push({ ...structure, id: `${file.path}::${structure.name}`, file: file.path, module: moduleId });
    }
  }

  const definitions = new Map();
  for (const symbol of symbols) {
    const list = definitions.get(symbol.name);
    if (list) list.push(symbol);
    else definitions.set(symbol.name, [symbol]);
  }

  const resolveCallee = (name, caller) => {
    const all = definitions.get(name);
    if (!all || !all.length) return null;
    const list = callablePool(all);
    if (list.length === 1) return { symbol: list[0], ambiguous: false };
    const sameFile = list.find((item) => item.file === caller.file);
    if (sameFile) return { symbol: sameFile, ambiguous: false };
    const sameModule = list.find((item) => item.module === caller.module);
    if (sameModule) return { symbol: sameModule, ambiguous: false };
    return { symbol: list[0], ambiguous: true };
  };

  const callEdges = [];
  for (const symbol of symbols) {
    for (const call of symbol.calls || []) {
      const resolved = resolveCallee(call.name, symbol);
      if (!resolved) continue;
      const target = resolved.symbol;
      callEdges.push({
        from: symbol.id,
        fromName: symbol.name,
        to: target.id,
        toName: target.name,
        file: symbol.file,
        line: call.line,
        fromModule: symbol.module,
        toModule: target.module,
        ambiguous: resolved.ambiguous,
      });
      if (symbol.module !== target.module) {
        const fromModule = moduleRecords.get(symbol.module);
        const toModule = moduleRecords.get(target.module);
        if (fromModule) fromModule.metrics.crossModuleCalls += 1;
        if (toModule) toModule.metrics.callIn += 1;
      }
    }
  }

  /* ---------------------------------------------------------------- entries */

  const entryPoints = [];
  const addEntry = (entry) => {
    if (!entry?.name) return;
    if (entryPoints.some((existing) => existing.name === entry.name && existing.file === entry.file)) return;
    entryPoints.push({
      kind: entry.kind,
      name: entry.name,
      file: toPosix(entry.file || ''),
      line: entry.line || 1,
      module: modulePathByFile.has(entry.file) ? moduleIdOfPath(modulePathByFile.get(entry.file)) : '',
      confidence: entry.confidence || 'heuristic',
      evidence: entry.evidence || [makeEvidence(entry.file || '', entry.line || 1, entry.name)],
    });
  };

  for (const symbol of symbols) {
    if (symbol.name === 'main' && symbol.kind === 'function') {
      addEntry({ kind: 'program-entry', name: 'main', file: symbol.file, line: symbol.line, confidence: 'source' });
    }
    if (symbol.name === 'Reset_Handler') {
      addEntry({ kind: 'reset-handler', name: 'Reset_Handler', file: symbol.file, line: symbol.line, confidence: 'source' });
    }
    if (symbol.name === 'SystemInit') {
      addEntry({ kind: 'startup-init', name: 'SystemInit', file: symbol.file, line: symbol.line, confidence: 'source' });
    }
  }
  for (const manifest of manifestCandidates) {
    const text = texts.get(manifest.manifest) || '';
    if (manifest.id === 'npm') {
      const data = packageJsonScripts(text);
      if (data?.main) addEntry({ kind: 'package-main', name: data.main, file: 'package.json', line: 1, confidence: 'source' });
      if (data?.bin?.length) addEntry({ kind: 'cli-entry', name: data.bin[0], file: 'package.json', line: 1, confidence: 'source' });
      for (const script of data?.scripts || []) {
        if (['dev', 'start', 'serve'].includes(script.name)) {
          addEntry({ kind: 'task-entry', name: `npm run ${script.name}`, file: 'package.json', line: 1, confidence: 'source' });
        }
      }
    }
    if (manifest.id === 'cubemx') {
      addEntry({ kind: 'project-generator', name: baseName(manifest.manifest), file: manifest.manifest, line: 1, confidence: 'source' });
    }
  }
  for (const file of files) {
    if (file.lang === 'python' && file.path.endsWith('__main__.py')) {
      addEntry({ kind: 'module-entry', name: '__main__', file: file.path, line: 1, confidence: 'source' });
    }
    if (file.lang === 'go') {
      const main = file.symbols.find((symbol) => symbol.name === 'main');
      if (main) addEntry({ kind: 'program-entry', name: 'main', file: file.path, line: main.line, confidence: 'source' });
    }
    if (file.lang === 'rust' && file.path.endsWith('src/main.rs')) {
      const main = file.symbols.find((symbol) => symbol.name === 'main');
      if (main) addEntry({ kind: 'program-entry', name: 'main', file: file.path, line: main.line, confidence: 'source' });
    }
  }

  /* ------------------------------------------------------------ tests and CI */

  const entryRank = {
    'reset-handler': 0,
    'program-entry': 1,
    'module-entry': 2,
    'startup-init': 3,
    'package-main': 4,
    'cli-entry': 5,
    'task-entry': 6,
    'project-generator': 9,
  };
  entryPoints.sort((left, right) => {
    const rank = (entryRank[left.kind] ?? 8) - (entryRank[right.kind] ?? 8);
    if (rank !== 0) return rank;
    const penalty = (file) => (/^(?:doc|docs|example|examples|sample|samples|demo|demos|test|tests|bench|benchmark)\//i.test(file) ? 1 : 0);
    const delta = penalty(left.file) - penalty(right.file);
    if (delta !== 0) return delta;
    return left.file.length - right.file.length;
  });
  const dedupedEntries = [];
  const seenEntryKeys = new Set();
  for (const entry of entryPoints) {
    const key = `${entry.kind}:${entry.name}`;
    if (seenEntryKeys.has(key)) continue;
    seenEntryKeys.add(key);
    dedupedEntries.push(entry);
  }
  entryPoints.length = 0;
  entryPoints.push(...dedupedEntries);

  const testFiles = walk.files.filter((file) => TEST_PATH_PATTERNS.some((pattern) => pattern.test(file.path)));
  const frameworks = new Set();
  for (const manifest of manifestCandidates) {
    const text = texts.get(manifest.manifest) || '';
    if (manifest.id === 'npm') {
      const data = packageJsonScripts(text);
      for (const name of data?.dependencies || []) {
        if (name === 'jest') frameworks.add('jest');
        if (name === 'vitest') frameworks.add('vitest');
        if (name === 'mocha') frameworks.add('mocha');
        if (name === 'playwright' || name === '@playwright/test') frameworks.add('playwright');
      }
    }
    if (manifest.id === 'cmake' && /enable_testing\s*\(/i.test(text)) frameworks.add('ctest');
    if (manifest.id === 'python') {
      if (/\[tool\.pytest/i.test(text) || /pytest/.test(text)) frameworks.add('pytest');
      if (/unittest/.test(text)) frameworks.add('unittest');
    }
    if (manifest.id === 'go') frameworks.add('go test');
    if (manifest.id === 'cargo') frameworks.add('cargo test');
    if (manifest.id === 'maven') frameworks.add('junit');
    if (manifest.id === 'gradle') frameworks.add('junit');
  }
  for (const file of walk.files) {
    if (/unity\.h$/i.test(file.path) || /ceedling/i.test(file.path)) frameworks.add('unity');
    if (/gtest|googletest/i.test(file.path)) frameworks.add('gtest');
    if (/catch2\/catch\.hpp$/i.test(file.path)) frameworks.add('catch2');
  }
  const tests = {
    files: testFiles.slice(0, 80).map((file) => file.path),
    count: testFiles.length,
    frameworks: [...frameworks],
    commands: [],
  };
  const build = buildCommands(manifestCandidates, texts, tests);
  tests.commands = build.commands.filter((command) => command.kind === 'test');

  const ciFiles = walk.files.filter((file) =>
    /^\.github\/workflows\/[^/]+\.ya?ml$/i.test(file.path)
    || /^\.gitlab-ci\.ya?ml$/i.test(file.path)
    || /(^|\/)Jenkinsfile$/i.test(file.path)
    || /^\.circleci\/config\.ya?ml$/i.test(file.path)
    || /^azure-pipelines\.ya?ml$/i.test(file.path)
    || /^\.travis\.ya?ml$/i.test(file.path),
  );
  const ci = ciFiles.slice(0, 20).map((file) => ({
    path: file.path,
    provider: /^\.github/.test(file.path) ? 'github-actions'
      : /gitlab/.test(file.path) ? 'gitlab-ci'
        : /Jenkinsfile/.test(file.path) ? 'jenkins'
          : /circleci/.test(file.path) ? 'circleci'
            : /azure/.test(file.path) ? 'azure-pipelines' : 'travis',
  }));

  /* -------------------------------------------------------------- concurrency */

  const concurrency = buildConcurrency(files, symbols);
  const storage = buildStorage(files);
  const todoList = files.flatMap((file) => (file.todos || []).map((todo) => ({ ...todo, file: file.path })));

  /* ------------------------------------------------------------------ secrets */

  const secrets = [];
  for (const file of walk.files) {
    const ext = extnameLower(file.path);
    const isEnv = /(^|\/)\.env(\.|$)/i.test(file.path);
    if (!isEnv && !SECRET_CONFIG_EXTS.has(ext)) continue;
    if (!isConfigFile(file.path) && !isEnv) continue;
    const read = await readSourceText(file.abs, 64 * 1024, signal);
    if (!read.text) continue;
    const lines = splitLines(read.text);
    for (let index = 0; index < lines.length; index += 1) {
      for (const rule of SECRET_PATTERNS) {
        if (!rule.pattern.test(lines[index])) continue;
        const value = lines[index].replace(/^[^:=]*[:=]\s*/, '').trim();
        secrets.push({
          file: file.path,
          line: index + 1,
          kind: rule.kind,
          masked: value.length > 4 ? `${value.slice(0, 3)}***` : '***',
        });
        break;
      }
      if (secrets.length >= 40) break;
    }
    if (secrets.length >= 40) break;
  }

  /* ------------------------------------------------------------- inventories */

  const languageStats = new Map();
  for (const file of nonVendoredSources) {
    const language = languageOf(file.path);
    if (!language) continue;
    const record = fileByPath.get(file.path);
    const entry = languageStats.get(language.id) || { id: language.id, name: language.name, files: 0, loc: 0, bytes: 0 };
    entry.files += 1;
    entry.loc += record?.loc || 0;
    entry.bytes += file.size;
    languageStats.set(language.id, entry);
  }
  const totalSourceBytes = [...languageStats.values()].reduce((sum, item) => sum + item.bytes, 0) || 1;
  const languages = [...languageStats.values()]
    .map((item) => ({ ...item, share: round(item.bytes / totalSourceBytes, 4) }))
    .sort((left, right) => right.bytes - left.bytes);

  const topLevel = new Map();
  for (const file of walk.files) {
    const top = file.path.split('/')[0] || '.';
    const entry = topLevel.get(top) || { name: top, type: walk.directories.some((dir) => dir.path === top) ? 'directory' : 'file', files: 0, bytes: 0, vendored: isVendoredPath(`${top}/x`, vendoredDirs) };
    entry.files += 1;
    entry.bytes += file.size;
    topLevel.set(top, entry);
  }

  const documents = walk.files
    .filter((file) => isDocFile(file.path))
    .slice(0, 200)
    .map((file) => ({ path: file.path, size: file.size, title: baseName(file.path) }));

  /* ---------------------------------------------------------------- analysis */

  // importance pass 1
  const maxFanIn = Math.max(1, ...modules.map((module) => module.dependents.length + module.metrics.callIn));
  const maxFanOut = Math.max(1, ...modules.map((module) => module.deps.length));
  const maxSymbols = Math.max(1, ...modules.map((module) => module.symbols));
  const maxLoc = Math.max(1, ...modules.map((module) => module.loc));
  const entryModules = new Set(entryPoints.map((entry) => entry.module).filter(Boolean));
  for (const module of modules) {
    const fanIn = normalize(module.dependents.length + module.metrics.callIn, maxFanIn);
    const fanOut = normalize(module.deps.length, maxFanOut);
    const symbolsScore = normalize(module.symbols, maxSymbols);
    const locScore = normalize(module.loc, maxLoc);
    const entryBoost = entryModules.has(module.id) ? 1 : 0;
    const base = 0.35 * fanIn + 0.2 * fanOut + 0.25 * symbolsScore + 0.2 * locScore;
    const score = module.vendored ? base * 0.15 : base * 0.75 + entryBoost * 0.25;
    module.importance = {
      fanIn: round(fanIn, 3),
      fanOut: round(fanOut, 3),
      symbols: round(symbolsScore, 3),
      loc: round(locScore, 3),
      entryBoost,
      score: round(clamp(score, 0, 1), 3),
    };
    module.topFiles = files
      .filter((file) => modulePathByFile.get(file.path) === module.path)
      .sort((left, right) => (right.symbols.length + right.loc / 100) - (left.symbols.length + left.loc / 100))
      .slice(0, 6)
      .map((file) => ({ path: file.path, loc: file.loc, symbols: file.symbols.length }));
    module.evidence = [{ file: module.topFiles[0]?.path || module.path, line: 1, symbol: '' }];
  }
  modules.sort((left, right) => right.importance.score - left.importance.score);

  // structures with lifecycle evidence
  const structureRecords = buildStructureLifecycle(structures, files);
  const topStructures = structureRecords.slice(0, 30);

  // chains
  const knowledgeDraft = {
    root: toPosix(rootAbs),
    symbols,
    definitions: null,
  };
  const chains = [];
  const seenStarts = new Set();
  for (const entry of entryPoints) {
    if (chains.length >= 3) break;
    if (!['program-entry', 'reset-handler', 'package-main', 'module-entry'].includes(entry.kind)) continue;
    const startKey = `${entry.file}::${entry.name}`;
    if (seenStarts.has(startKey)) continue;
    seenStarts.add(startKey);
    const chain = traceChain(knowledgeDraft, entry.name, { maxDepth: 6, maxNodes: 80, preferFile: entry.file });
    if (chain.ok) {
      const notes = [];
      if (entry.kind === 'reset-handler') {
        const cRuntime = chain.externals.find((item) => item.name === '__main');
        const mainSymbol = symbols.find((symbol) => symbol.name === 'main');
        const boot = chain.primary.filter((step) => step.from === 'Reset_Handler').slice(0, 1);
        const bridged = [...boot];
        if (cRuntime && mainSymbol) {
          bridged.push({
            step: bridged.length + 1,
            from: '__main',
            fromFile: cRuntime.file,
            to: 'main',
            toFile: mainSymbol.file,
            file: cRuntime.file,
            line: cRuntime.line,
            confidence: 'inferred',
          });
          notes.push('Reset_Handler 通过 C 库 __main 间接进入 main；源码中只有 LDR/BLX __main，缺少 __main → main 的直接调用点，因此该跳转标记为推断。');
        }
        chain.primary = bridged;
      }
      chains.push({
        id: `entry:${entry.kind}:${entry.name}`,
        name: `从 ${entry.name} 开始的主调用链`,
        start: { name: entry.name, file: entry.file, line: entry.line, module: entry.module },
        nodes: chain.nodes,
        edges: chain.edges,
        primary: chain.primary,
        externals: chain.externals,
        stats: chain.stats,
        confidence: chain.confidence,
        notes,
        stale: false,
        createdAt: nowIso(),
      });
    }
  }

  const risks = buildRisks({
    files,
    modules,
    tests,
    secrets,
    todoList,
    concurrency,
    parseBudgetExceeded: skipped.length > 0,
    voidNames: buildVoidCallNames(symbols),
  });
  const conflicts = detectConflicts({ readme, manifests: manifestCandidates, walk, languages });

  const knowledge = {
    schemaVersion: SCHEMA_VERSION,
    pluginVersion: PLUGIN_VERSION,
    root: toPosix(rootAbs),
    name: path.basename(rootAbs),
    generatedAt: nowIso(),
    updatedAt: nowIso(),
    scan: {
      mode: previous ? 'refresh' : 'full',
      durationMs: Date.now() - started,
      totalFiles: walk.files.length,
      parsedFiles,
      parsedBytes,
      skipped,
      truncated: walk.truncated,
      limits: {
        maxFiles: walk.maxFiles,
        maxDepth: walk.maxDepth,
        maxFileBytes,
        maxParseFiles,
        includeVendored,
      },
      diagnostics,
      runnerMode: runner.mode,
    },
    git,
    files,
    inventory: {
      totalFiles: walk.files.length,
      totalDirectories: walk.directories.length,
      sourceFiles: sourceFiles.length,
      nonVendoredSourceFiles: nonVendoredSources.length,
      vendoredSourceFiles: vendoredSources.length,
      loc: files.reduce((sum, file) => sum + (file.loc || 0), 0),
      bytes: walk.files.reduce((sum, file) => sum + file.size, 0),
      languages,
      topLevel: [...topLevel.values()].sort((left, right) => right.files - left.files).slice(0, 24),
      documents,
      vendored: {
        files: vendoredSources.length,
        groups: [...groupBy(vendoredSources, (file) => vendoredGroupFor(file.path)).entries()]
          .map(([group, list]) => ({ path: group, files: list.length, bytes: list.reduce((sum, file) => sum + file.size, 0) }))
          .sort((left, right) => right.files - left.files)
          .slice(0, 20),
      },
    },
    manifests: manifestCandidates,
    buildSystems: manifestCandidates,
    build: {
      manifests: manifestCandidates,
      commands: build.commands,
      primary: build.commands.find((command) => command.kind === 'build') || null,
    },
    documents: readme ? [readme] : [],
    readme,
    entryPoints,
    modules,
    symbols,
    structures: structureRecords,
    coreStructures: topStructures,
    dependencies: {
      edges: importEdges,
      external: [...externalImports.entries()].sort((left, right) => right[1] - left[1]).slice(0, 40).map(([name, count]) => ({ name, count })),
    },
    tests,
    ci,
    concurrency,
    storage,
    todos: todoList.slice(0, 200),
    secrets,
    risks,
    conflicts,
    chains,
    analysis: null,
    notes: {
      confirmed: [],
      inferred: [],
      unverified: [],
    },
    learning: previous?.learning || { plan: null, progress: {} },
    interview: previous?.interview || { sessions: [], weakPoints: [], bank: null },
    practice: previous?.practice || { tasks: [], records: [], generatedAt: null },
    change: {
      mode: previous ? 'refresh' : 'full',
      added: changed.added,
      modified: changed.modified,
      removed: changed.removed,
      gitDiff: null,
    },
  };

  if (previous?.git?.commit && git.available && git.commit && git.commit !== previous.git.commit) {
    const diff = await gitChangedFiles(runner.run, rootAbs, previous.git.commit, signal);
    knowledge.change.gitDiff = diff.ok ? { from: diff.from, to: diff.to, files: diff.files } : { error: diff.reason };
  }

  knowledge.analysis = buildAnalysis(knowledge);
  if (previous) markStaleItems(knowledge, buildChangedSet(knowledge));
  else knowledge.stale = { changed: [], claims: 0, chains: 0, tasks: 0 };

  return { knowledge, changed: knowledge.change, diagnostics };
}

/* --------------------------------------------------------------- concurrency */

function buildConcurrency(files, symbols) {
  const primitives = [];
  for (const file of files) {
    for (const kind of ['rtos', 'lock', 'irq']) {
      for (const signal of file.signals?.[kind] || []) {
        primitives.push({ kind, name: signal.name, file: file.path, line: signal.line });
      }
    }
  }
  const isrs = [];
  const seenIsrNames = new Set();
  const isrCandidates = symbols
    .filter((symbol) => /_IRQHandler$/.test(symbol.name)
      || /^(?:NMI|HardFault|MemManage|BusFault|UsageFault|SVC|DebugMon|PendSV|SysTick)_Handler$/.test(symbol.name))
    .sort((left, right) => (left.kind === 'prototype' ? 1 : 0) - (right.kind === 'prototype' ? 1 : 0));
  for (const symbol of isrCandidates) {
    if (seenIsrNames.has(symbol.name)) continue;
    seenIsrNames.add(symbol.name);
    isrs.push({ name: symbol.name, file: symbol.file, line: symbol.line });
  }
  const rtosCount = primitives.filter((item) => item.kind === 'rtos').length;
  const lockCount = primitives.filter((item) => item.kind === 'lock').length;
  const hasAsync = files.some((file) => file.symbols.some((symbol) => symbol.modifiers?.includes('async')))
    || files.some((file) => (file.imports || []).some((item) => /asyncio|tokio|Promise/.test(item.raw || '')));
  let model = 'unknown';
  if (rtosCount > 0) model = 'rtos';
  else if (isrs.length > 0) model = 'interrupt-driven';
  else if (hasAsync) model = 'async';
  else if (lockCount > 0) model = 'multi-threaded';
  else if (files.length > 0) model = 'single-threaded-or-unknown';
  return {
    model,
    primitives: primitives.slice(0, 120),
    isrs,
    counts: {
      rtos: rtosCount,
      lock: lockCount,
      irq: primitives.filter((item) => item.kind === 'irq').length,
      isr: isrs.length,
    },
    evidence: primitives.slice(0, 6).map((item) => makeEvidence(item.file, item.line, item.name)),
  };
}

function buildStorage(files) {
  const evidence = [];
  for (const file of files) {
    for (const signal of file.signals?.io || []) {
      if (!/FLASH|EEPROM|fopen|fwrite|sqlite|redis|file/i.test(signal.name)) continue;
      evidence.push({ name: signal.name, file: file.path, line: signal.line });
    }
  }
  const kinds = new Set();
  for (const item of evidence) {
    if (/FLASH/i.test(item.name)) kinds.add('flash');
    if (/EEPROM/i.test(item.name)) kinds.add('eeprom');
    if (/sqlite/i.test(item.name)) kinds.add('sql');
    if (/fopen|fwrite|file/i.test(item.name)) kinds.add('file');
  }
  return { kinds: [...kinds], evidence: evidence.slice(0, 40) };
}

/* ---------------------------------------------------------------- structures */

function buildStructureLifecycle(structures, files) {
  const typeRefs = [];
  for (const file of files) {
    for (const ref of file.signals?.typeRefs || []) typeRefs.push({ ...ref, file: file.path });
  }
  const frees = [];
  for (const file of files) {
    for (const free of file.signals?.frees || []) frees.push({ ...free, file: file.path });
  }

  const seen = new Set();
  return structures
    .filter((structure) => {
      const key = `${structure.name}:${structure.file}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((structure) => {
      const refs = typeRefs.filter((ref) => ref.type === structure.name);
      const declarations = refs.filter((ref) => ref.form === 'declaration');
      const statics = refs.filter((ref) => ref.form === 'static');
      const sizeofs = refs.filter((ref) => ref.form === 'sizeof' || ref.form === 'new');
      const released = [];
      for (const declaration of declarations) {
        if (!declaration.variable) continue;
        for (const free of frees) {
          if (free.variable === declaration.variable) released.push(free);
        }
      }
      let verdict = 'unverified';
      if (statics.length > 0) verdict = 'static-or-global';
      else if (declarations.length > 0 && released.length > 0) verdict = 'released-on-a-known-path';
      else if (declarations.length > 0) verdict = 'declared-no-release-evidence';
      else if (sizeofs.length > 0) verdict = 'created-by-callers';
      const evidence = [
        ...declarations.slice(0, 3).map((ref) => ({ ...makeEvidence(ref.file, ref.line, `${structure.name} ${ref.variable}`), form: 'declaration' })),
        ...statics.slice(0, 2).map((ref) => ({ ...makeEvidence(ref.file, ref.line, structure.name), form: 'static' })),
        ...sizeofs.slice(0, 2).map((ref) => ({ ...makeEvidence(ref.file, ref.line, structure.name), form: ref.form })),
        ...released.slice(0, 2).map((ref) => ({ ...makeEvidence(ref.file, ref.line, ref.variable), form: 'release' })),
      ];
      return {
        id: structure.id,
        name: structure.name,
        kind: structure.kind,
        file: structure.file,
        line: structure.line,
        endLine: structure.endLine,
        module: structure.module,
        fields: (structure.fields || []).slice(0, 40),
        methods: (structure.methods || []).slice(0, 20),
        lifecycle: {
          verdict,
          declarations: declarations.slice(0, 6),
          statics: statics.slice(0, 6),
          allocations: sizeofs.slice(0, 6),
          releases: released.slice(0, 6),
          confidence: verdict === 'unverified' ? 'unverified' : 'source',
        },
        evidence,
      };
    })
    .sort((left, right) => right.evidence.length - left.evidence.length);
}

/* --------------------------------------------------------------------- risks */

export function buildVoidCallNames(symbols) {
  const names = new Set(KNOWN_VOID_CALLS);
  for (const symbol of symbols || []) {
    if (symbol.kind !== 'prototype') continue;
    if (/^void\b/.test(declaredReturnType(symbol))) names.add(symbol.name);
  }
  return names;
}

function buildRisks({ files, modules, tests, secrets, todoList, concurrency, parseBudgetExceeded, voidNames }) {
  const risks = [];
  const longFunctions = [];
  for (const file of files) {
    for (const symbol of file.symbols) {
      if (symbol.loc >= 120) longFunctions.push({ name: symbol.name, file: file.path, line: symbol.line, loc: symbol.loc });
    }
  }
  const unsafe = files.flatMap((file) => (file.signals?.unsafe || []).map((item) => ({ ...item, file: file.path })));
  const ignored = files
    .flatMap((file) => (file.signals?.ignoredReturn || []).map((item) => ({ ...item, file: file.path })))
    .filter((item) => !voidNames?.has(item.name));
  const allocs = files.flatMap((file) => (file.signals?.alloc || []).map((item) => ({ ...item, file: file.path })));
  const frees = files.flatMap((file) => (file.signals?.free || []).map((item) => ({ ...item, file: file.path })));

  if (longFunctions.length) {
    const sorted = longFunctions.sort((left, right) => right.loc - left.loc).slice(0, 8);
    risks.push({
      kind: 'complexity',
      severity: sorted[0].loc >= 200 ? 'high' : 'medium',
      text: `${longFunctions.length} 个函数超过 120 行；最长的是 ${sorted[0].name}（${sorted[0].loc} 行）。`,
      evidence: sorted.slice(0, 4).map((item) => makeEvidence(item.file, item.line, item.name)),
    });
  }
  if (unsafe.length) {
    risks.push({
      kind: 'memory-safety',
      severity: 'medium',
      text: `检测到 ${unsafe.length} 处可能不安全的 C 字符串/内存函数调用，需要逐个确认边界检查。`,
      evidence: unsafe.slice(0, 5).map((item) => makeEvidence(item.file, item.line, item.name)),
    });
  }
  if (ignored.length) {
    risks.push({
      kind: 'error-handling',
      severity: 'medium',
      text: `${ignored.length} 处调用忽略了返回值（HAL/IO/队列等），失败路径可能没有被处理。`,
      evidence: ignored.slice(0, 5).map((item) => makeEvidence(item.file, item.line, item.name)),
    });
  }
  if (allocs.length > frees.length) {
    risks.push({
      kind: 'resource-lifecycle',
      severity: 'medium',
      text: `分配点 ${allocs.length} 个，释放点 ${frees.length} 个；需要核对每个分配在失败和异常路径上的释放。`,
      evidence: allocs.slice(0, 4).map((item) => makeEvidence(item.file, item.line, item.name)),
    });
  }
  if (!tests.count) {
    risks.push({
      kind: 'verification-gap',
      severity: 'medium',
      text: '未发现自动化测试；修改后的回归验证只能依赖构建、静态检查和手工运行。',
      evidence: [],
    });
  }
  if (secrets.length) {
    risks.push({
      kind: 'secret',
      severity: 'high',
      text: `发现 ${secrets.length} 处疑似凭据（值已脱敏），不要复制到对话或提交记录中。`,
      evidence: secrets.slice(0, 4).map((item) => makeEvidence(item.file, item.line, item.kind)),
    });
  }
  if (todoList.length) {
    risks.push({
      kind: 'known-gap',
      severity: 'low',
      text: `源码中有 ${todoList.length} 条 TODO/FIXME 注释，可作为低风险练习素材。`,
      evidence: todoList.slice(0, 4).map((item) => makeEvidence(item.file, item.line, item.kind)),
    });
  }
  if (parseBudgetExceeded) {
    risks.push({
      kind: 'analysis-coverage',
      severity: 'low',
      text: '部分文件因解析预算限制未被解析，相关结论可能不完整。',
      evidence: [],
    });
  }
  if (concurrency.counts.rtos > 0 && concurrency.isrs.length > 0) {
    risks.push({
      kind: 'concurrency',
      severity: 'low',
      text: `项目同时使用 RTOS（${concurrency.counts.rtos} 处原语）和 ${concurrency.isrs.length} 个 ISR，需重点核对中断与任务间的共享数据。`,
      evidence: concurrency.evidence.slice(0, 4),
    });
  }
  return risks;
}

/* ----------------------------------------------------------------- conflicts */

function detectConflicts({ readme, manifests, walk, languages }) {
  const conflicts = [];
  if (!readme) return conflicts;
  const commands = readme.commands.map((entry) => entry.command.toLowerCase());
  const manifestIds = new Set(manifests.map((item) => item.id));
  const has = (pattern) => commands.some((command) => pattern.test(command));

  if (has(/\b(npm|pnpm|yarn|npx)\b/) && !manifestIds.has('npm')) {
    conflicts.push({ kind: 'doc-vs-source', text: 'README 提到 npm/pnpm/yarn 命令，但仓库中没有 package.json。', evidence: [makeEvidence(readme.path, readme.commands.find((entry) => /\b(npm|pnpm|yarn|npx)\b/.test(entry.command))?.line || 1)] });
  }
  if (has(/\bcmake\b/) && !manifestIds.has('cmake')) {
    conflicts.push({ kind: 'doc-vs-source', text: 'README 提到 cmake，但仓库中没有 CMakeLists.txt。', evidence: [makeEvidence(readme.path, 1)] });
  }
  if (has(/\bcargo\b/) && !manifestIds.has('cargo')) {
    conflicts.push({ kind: 'doc-vs-source', text: 'README 提到 cargo，但仓库中没有 Cargo.toml。', evidence: [makeEvidence(readme.path, 1)] });
  }
  if (has(/\bgo (?:test|build|run)\b/) && !manifestIds.has('go')) {
    conflicts.push({ kind: 'doc-vs-source', text: 'README 提到 go 命令，但仓库中没有 go.mod。', evidence: [makeEvidence(readme.path, 1)] });
  }
  const topLanguages = new Set(languages.filter((item) => item.share > 0.05).map((item) => item.id));
  if (readme.summary && /(?:^|\s)(?:rust|golang|java|python|typescript)(?:\s|,|\.)/i.test(readme.summary)) {
    const mentioned = readme.summary.toLowerCase();
    const mismatch = (
      (mentioned.includes('rust') && !topLanguages.has('rust'))
      || (mentioned.includes('python') && !topLanguages.has('python') && !topLanguages.has('py'))
      || (mentioned.includes('typescript') && !topLanguages.has('typescript') && !topLanguages.has('tsx'))
    );
    if (mismatch) {
      conflicts.push({
        kind: 'doc-vs-source',
        text: 'README 描述的技术栈与扫描到的主要语言不一致，以当前源码为准。',
        evidence: [makeEvidence(readme.path, 1)],
      });
    }
  }
  return conflicts;
}

/* ----------------------------------------------------------------- analysis */

export function buildAnalysis(knowledge) {
  const modules = knowledge.modules.filter((module) => !module.vendored);
  const architectureNodes = modules.slice(0, 18).map((module) => ({
    id: module.id,
    label: module.name,
    files: module.files,
    loc: module.loc,
    symbols: module.symbols,
    importance: module.importance.score,
    vendored: module.vendored,
  }));
  const nodeIds = new Set(architectureNodes.map((node) => node.id));
  const architectureEdges = [];
  for (const module of modules) {
    for (const dep of module.deps) {
      if (!nodeIds.has(dep)) continue;
      architectureEdges.push({ from: module.id, to: dep, kind: 'import' });
    }
  }
  const programChain = knowledge.chains.find((chain) => chain.id.startsWith('entry:program-entry') && chain.primary.length > 0);
  const startupChain = knowledge.chains.find((chain) => chain.id.startsWith('entry:reset-handler'));
  const primaryChain = programChain || knowledge.chains[0] || null;
  const topStructure = knowledge.coreStructures?.[0] || null;
  const concurrency = knowledge.concurrency;
  const risk = knowledge.risks;

  const oneLiner = buildOneLiner(knowledge);
  const problem = buildProblem(knowledge);

  const mermaidArchitecture = renderArchitectureMermaid(architectureNodes, architectureEdges);
  const mermaidChain = primaryChain ? renderChainMermaid(primaryChain) : '';
  const mermaidLifecycle = topStructure && topStructure.lifecycle ? renderLifecycleMermaid(topStructure) : '';
  const mermaidConcurrency = concurrency.counts.isr > 0 ? renderConcurrencyMermaid(knowledge) : '';

  const claims = buildClaims(knowledge, { primaryChain, topStructure, oneLiner, problem });

  return {
    oneLiner,
    problem,
    architecture: { nodes: architectureNodes, edges: architectureEdges, mermaid: mermaidArchitecture },
    chain: primaryChain
      ? {
        id: primaryChain.id,
        name: primaryChain.name,
        confidence: primaryChain.confidence,
        steps: primaryChain.primary,
        mermaid: mermaidChain,
        evidence: primaryChain.primary.flatMap((step) => [
          makeEvidence(step.file, step.line, step.to),
          step.toFile ? makeEvidence(step.toFile, step.line, step.to) : null,
        ].filter(Boolean)),
      }
      : null,
    startup: startupChain
      ? {
        id: startupChain.id,
        steps: startupChain.primary,
        notes: startupChain.notes || [],
        confidence: startupChain.confidence,
      }
      : null,
    dataStructures: {
      items: (knowledge.coreStructures || []).slice(0, 8).map((structure) => ({
        name: structure.name,
        kind: structure.kind,
        file: structure.file,
        line: structure.line,
        fields: structure.fields.length,
        verdict: structure.lifecycle.verdict,
        confidence: structure.lifecycle.confidence,
      })),
      mermaid: mermaidLifecycle,
      top: topStructure
        ? {
          name: topStructure.name,
          file: topStructure.file,
          line: topStructure.line,
          fields: topStructure.fields,
          lifecycle: topStructure.lifecycle,
        }
        : null,
    },
    concurrency: {
      model: concurrency.model,
      counts: concurrency.counts,
      isrs: concurrency.isrs,
      primitives: concurrency.primitives.slice(0, 20),
      mermaid: mermaidConcurrency,
      evidence: concurrency.evidence,
    },
    storage: knowledge.storage,
    testing: knowledge.tests,
    build: knowledge.build,
    risks: risk,
    conflicts: knowledge.conflicts,
    claims,
    mermaid: {
      architecture: mermaidArchitecture,
      chain: mermaidChain,
      lifecycle: mermaidLifecycle,
      concurrency: mermaidConcurrency,
    },
  };
}

function buildOneLiner(knowledge) {
  const languageNames = knowledge.inventory.languages.slice(0, 3).map((item) => item.name).join(' / ');
  const kinds = [...new Set(knowledge.manifests.map((item) => item.name))].slice(0, 3).join('、');
  const readmeTitle = knowledge.readme?.title;
  const readmeSummary = knowledge.readme?.summary;
  if (readmeSummary) {
    return {
      text: truncate(readmeSummary, 220),
      kind: 'doc',
      evidence: [makeEvidence(knowledge.readme.path, knowledge.readme.paragraphs?.[0]?.line || 1)],
    };
  }
  const anchor = knowledge.entryPoints.find((entry) => entry.kind === 'program-entry')
    || knowledge.entryPoints[0]
    || { file: knowledge.modules[0]?.topFiles?.[0]?.path || '', line: 1 };
  return {
    text: `${knowledge.name}：以 ${languageNames || '未知语言'} 为主的项目${kinds ? `，使用 ${kinds}` : ''}。`,
    kind: 'inference',
    evidence: [makeEvidence(anchor.file, anchor.line)],
    note: '仓库没有可读的 README，项目目标需要从源码进一步确认。',
  };
}

function buildProblem(knowledge) {
  const readme = knowledge.readme;
  if (!readme) {
    return {
      text: 'README 缺失，当前只能从入口函数与模块结构推断项目要解决的问题。',
      kind: 'unverified',
      evidence: [],
    };
  }
  const section = readme.headings.find((heading) => /(问题|背景|简介|介绍|overview|about|introduction|what)/i.test(heading.title));
  const paragraph = section
    ? readme.paragraphs.find((entry) => entry.section === section.title)
    : readme.paragraphs?.[0];
  return {
    text: paragraph?.text || truncate(readme.summary, 240),
    kind: paragraph ? 'doc' : 'unverified',
    evidence: [makeEvidence(readme.path, paragraph?.line || section?.line || 1)],
  };
}

function buildClaims(knowledge, { primaryChain, topStructure, oneLiner, problem }) {
  const claims = [];
  const push = (section, text, kind, evidence, extra = {}) => {
    claims.push({
      id: `claim-${claims.length + 1}`,
      section,
      text,
      kind,
      evidence: evidence || [],
      stale: false,
      ...extra,
    });
  };

  push('identity', oneLiner.text, oneLiner.kind, oneLiner.evidence, oneLiner.note ? { note: oneLiner.note } : {});
  push('problem', problem.text, problem.kind, problem.evidence);

  const modules = knowledge.modules.filter((module) => !module.vendored).slice(0, 6);
  for (const module of modules) {
    push(
      'architecture',
      `模块 ${module.name} 包含 ${module.files} 个源文件、${module.symbols} 个符号，依赖 ${module.deps.length} 个模块。`,
      'source',
      module.evidence,
      { module: module.id },
    );
  }

  for (const entry of knowledge.entryPoints.slice(0, 4)) {
    push('entry', `入口 ${entry.name}（${entry.kind}）位于 ${entry.file}:${entry.line}。`, 'source', entry.evidence);
  }

  if (primaryChain) {
    push(
      'chain',
      `主调用链从 ${primaryChain.start.name} 出发，经过 ${primaryChain.stats.nodes} 个节点、${primaryChain.stats.edges} 条调用边；链路建立在真实调用点上，但符号识别是启发式的。`,
      'source',
      primaryChain.primary.slice(0, 4).map((step) => makeEvidence(step.file, step.line, step.to)),
      { chain: primaryChain.id, confidence: primaryChain.confidence },
    );
  }

  if (topStructure) {
    push(
      'data',
      `关键数据结构 ${topStructure.name} 定义在 ${topStructure.file}:${topStructure.line}，生命周期判定为 ${topStructure.lifecycle.verdict}。`,
      topStructure.lifecycle.verdict === 'unverified' ? 'unverified' : 'source',
      topStructure.evidence.slice(0, 3),
    );
  }

  for (const conflict of knowledge.conflicts) {
    push('conflict', conflict.text, 'unverified', conflict.evidence);
  }

  const inferred = [];
  for (const module of modules.slice(0, 5)) {
    if (module.dependents.length === 0 && module.deps.length > 0 && module.importance.score > 0.2) {
      inferred.push(`模块 ${module.name} 没有被其他模块导入，可能是顶层编排模块。`);
    }
  }
  for (const text of inferred) push('architecture', text, 'inference', []);
  return claims;
}

/* ------------------------------------------------------------------- mermaid */

function mermaidId(value) {
  return `m_${String(value).replace(/[^A-Za-z0-9_]/g, '_')}`;
}

function mermaidLabel(value) {
  return String(value).replace(/"/g, "'").replace(/[[\]{}()]/g, ' ').slice(0, 60);
}

function renderArchitectureMermaid(nodes, edges) {
  if (!nodes.length) return '';
  const lines = ['flowchart LR'];
  for (const node of nodes) {
    lines.push(`  ${mermaidId(node.id)}["${mermaidLabel(node.label)}<br/>${node.files} files · ${node.symbols} symbols"]`);
  }
  const nodeIds = new Set(nodes.map((node) => node.id));
  for (const edge of edges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) continue;
    lines.push(`  ${mermaidId(edge.from)} --> ${mermaidId(edge.to)}`);
  }
  return lines.join('\n');
}

function renderChainMermaid(chain) {
  if (!chain?.primary?.length) return '';
  const lines = ['flowchart TD'];
  const seen = new Set();
  for (const step of chain.primary) {
    if (!seen.has(step.from)) {
      lines.push(`  ${mermaidId(step.from)}["${mermaidLabel(step.from.split('::')[1] || step.from)}<br/>${mermaidLabel(step.fromFile || step.file)}"]`);
      seen.add(step.from);
    }
    if (!seen.has(step.to)) {
      lines.push(`  ${mermaidId(step.to)}["${mermaidLabel(step.to.split('::')[1] || step.to)}<br/>${mermaidLabel(step.toFile || step.file)}"]`);
      seen.add(step.to);
    }
    lines.push(`  ${mermaidId(step.from)} -->|${step.line}| ${mermaidId(step.to)}`);
  }
  return lines.join('\n');
}

function renderLifecycleMermaid(structure) {
  const lifecycle = structure.lifecycle;
  const lines = ['stateDiagram-v2'];
  lines.push('  [*] --> Defined');
  if (lifecycle.declarations.length || lifecycle.statics.length) lines.push('  Defined --> Instantiated');
  if (lifecycle.releases.length) {
    lines.push('  Instantiated --> Released');
    lines.push('  Released --> [*]');
  }
  return lines.join('\n');
}

function renderConcurrencyMermaid(knowledge) {
  const isrs = knowledge.concurrency.isrs.slice(0, 4);
  const primitives = knowledge.concurrency.primitives.filter((item) => item.kind === 'rtos').slice(0, 4);
  if (!isrs.length) return '';
  const lines = ['sequenceDiagram', '  participant ISR', '  participant Task'];
  for (const isr of isrs) {
    lines.push(`  ISR->>Task: ${mermaidLabel(isr.name)}() 触发`);
  }
  if (primitives.length) lines.push(`  Task->>Task: ${mermaidLabel(primitives[0].name)}()`);
  lines.push('  Task-->>ISR: 返回');
  return lines.join('\n');
}

/* -------------------------------------------------------------------- chains */

export function buildSymbolIndex(knowledge) {
  if (knowledge.__index) return knowledge.__index;
  const definitions = new Map();
  for (const symbol of knowledge.symbols || []) {
    const list = definitions.get(symbol.name);
    if (list) list.push(symbol);
    else definitions.set(symbol.name, [symbol]);
  }
  const byId = new Map((knowledge.symbols || []).map((symbol) => [symbol.id, symbol]));
  const index = { definitions, byId };
  Object.defineProperty(knowledge, '__index', { value: index, enumerable: false, configurable: true });
  return index;
}

export function findSymbols(knowledge, query, options = {}) {
  const limit = options.limit ?? 20;
  const needle = String(query || '').toLowerCase();
  if (!needle) return [];
  const scored = [];
  for (const symbol of knowledge.symbols || []) {
    const name = symbol.name.toLowerCase();
    let score = 0;
    if (name === needle) score = 100;
    else if (name.startsWith(needle)) score = 70;
    else if (name.includes(needle)) score = 45;
    else if (symbol.file.toLowerCase().includes(needle)) score = 20;
    if (!score) continue;
    if (symbol.kind === 'prototype') score -= 25;
    scored.push({ symbol, score: score + Math.min(20, symbol.loc / 20) });
  }
  return scored.sort((left, right) => right.score - left.score).slice(0, limit).map((entry) => entry.symbol);
}

export function traceChain(knowledge, startTarget, options = {}) {
  const maxDepth = options.maxDepth ?? 5;
  const maxNodes = options.maxNodes ?? 60;
  const index = buildSymbolIndex(knowledge);
  const startSymbol = resolveStartSymbol(knowledge, startTarget, options, index);
  if (!startSymbol) {
    return { ok: false, reason: `未找到起始符号：${startTarget}`, candidates: findSymbols(knowledge, startTarget, { limit: 5 }).map((symbol) => ({ name: symbol.name, file: symbol.file, line: symbol.line })) };
  }

  const nodes = [];
  const edges = [];
  const externals = [];
  const visited = new Set([startSymbol.id]);
  const queue = [{ symbol: startSymbol, depth: 0 }];
  let truncated = false;

  while (queue.length) {
    const current = queue.shift();
    if (current.depth >= maxDepth) continue;
    for (const call of current.symbol.calls || []) {
      const resolved = resolveCalleeInKnowledge(index, call.name, current.symbol);
      if (!resolved) {
        if (externals.length < 60) {
          externals.push({ from: current.symbol.id, name: call.name, file: current.symbol.file, line: call.line });
        }
        continue;
      }
      const target = resolved.symbol;
      if (nodes.length >= maxNodes) {
        truncated = true;
        continue;
      }
      const edgeId = `${current.symbol.id}->${target.id}:${call.line}`;
      if (!edges.some((edge) => edge.id === edgeId)) {
        edges.push({
          id: edgeId,
          from: current.symbol.id,
          fromName: current.symbol.name,
          fromFile: current.symbol.file,
          to: target.id,
          toName: target.name,
          toFile: target.file,
          line: call.line,
          confidence: resolved.ambiguous ? 'inferred' : 'confirmed',
          ambiguous: resolved.ambiguous,
        });
      }
      if (!visited.has(target.id)) {
        visited.add(target.id);
        nodes.push({
          id: target.id,
          name: target.name,
          file: target.file,
          line: target.line,
          module: target.module,
          depth: current.depth + 1,
        });
        queue.push({ symbol: target, depth: current.depth + 1 });
      }
    }
  }

  nodes.unshift({ id: startSymbol.id, name: startSymbol.name, file: startSymbol.file, line: startSymbol.line, module: startSymbol.module, depth: 0 });

  const adjacency = new Map();
  for (const edge of edges) {
    const list = adjacency.get(edge.from) || [];
    list.push(edge);
    adjacency.set(edge.from, list);
  }
  const subtree = new Map();
  const computeSubtree = (id, stack = new Set()) => {
    if (subtree.has(id)) return subtree.get(id);
    if (stack.has(id)) return 0;
    stack.add(id);
    let total = 1;
    for (const edge of adjacency.get(id) || []) total += computeSubtree(edge.to, stack);
    stack.delete(id);
    subtree.set(id, total);
    return total;
  };
  computeSubtree(startSymbol.id);

  const primary = [];
  let cursor = startSymbol.id;
  const primarySeen = new Set([cursor]);
  for (let depth = 0; depth < Math.min(maxDepth, 6); depth += 1) {
    const candidates = (adjacency.get(cursor) || []).filter((edge) => !primarySeen.has(edge.to));
    if (!candidates.length) break;
    candidates.sort((left, right) => (subtree.get(right.to) || 0) - (subtree.get(left.to) || 0));
    const chosen = candidates[0];
    primary.push({
      step: primary.length + 1,
      from: chosen.fromName,
      fromFile: chosen.fromFile,
      to: chosen.toName,
      toFile: chosen.toFile,
      file: chosen.fromFile,
      line: chosen.line,
      confidence: chosen.confidence,
    });
    primarySeen.add(chosen.to);
    cursor = chosen.to;
  }

  const hasAmbiguity = edges.some((edge) => edge.ambiguous);
  const confidence = edges.length === 0 ? 'unverified' : hasAmbiguity ? 'inferred' : 'confirmed';
  return {
    ok: true,
    start: { name: startSymbol.name, file: startSymbol.file, line: startSymbol.line, module: startSymbol.module },
    nodes,
    edges,
    primary,
    externals,
    truncated,
    confidence,
    stats: {
      nodes: nodes.length,
      edges: edges.length,
      external: externals.length,
      depth: nodes.reduce((max, node) => Math.max(max, node.depth), 0),
    },
  };
}

function resolveStartSymbol(knowledge, target, options, index) {
  if (!target) return null;
  const needle = String(target);
  const byId = index.byId.get(needle);
  if (byId) return byId;
  if (options.preferFile) {
    const exact = (index.definitions.get(needle) || []).find((symbol) => symbol.file === options.preferFile);
    if (exact) return exact;
  }
  const list = index.definitions.get(needle);
  if (list && list.length) {
    const definitionsOnly = list.filter((symbol) => symbol.kind !== 'prototype');
    const pool = definitionsOnly.length ? definitionsOnly : list;
    return pool.find((symbol) => symbol.name === needle) || pool[0];
  }
  const fileMatch = knowledge.symbols.find((symbol) => symbol.file === needle || symbol.file.endsWith(`/${needle}`));
  if (fileMatch) return fileMatch;
  const fuzzy = findSymbols(knowledge, needle, { limit: 1 });
  return fuzzy[0] || null;
}

function callablePool(list) {
  const callables = list.filter((symbol) => ['function', 'arrow', 'dunder', 'label', 'method'].includes(symbol.kind));
  return callables.length ? callables : list;
}

function resolveCalleeInKnowledge(index, name, caller) {
  const all = index.definitions.get(name);
  if (!all || !all.length) return null;
  const list = callablePool(all);
  if (list.length === 1) return { symbol: list[0], ambiguous: false };
  const sameFile = list.find((symbol) => symbol.file === caller.file);
  if (sameFile) return { symbol: sameFile, ambiguous: false };
  const sameModule = list.find((symbol) => symbol.module === caller.module);
  if (sameModule) return { symbol: sameModule, ambiguous: false };
  return { symbol: list[0], ambiguous: true };
}

/* --------------------------------------------------------------------- stale */

export function buildChangedSet(knowledge) {
  const paths = new Set([
    ...(knowledge.change?.added || []),
    ...(knowledge.change?.modified || []),
    ...(knowledge.change?.removed || []),
    ...((knowledge.change?.gitDiff?.files || []).map((file) => file.path)),
  ]);
  return paths;
}

export function markStaleItems(knowledge, changedPaths) {
  if (!changedPaths || changedPaths.size === 0) return;
  const isChanged = (file) => file && changedPaths.has(toPosix(file));
  let staleClaims = 0;
  for (const claim of knowledge.analysis?.claims || []) {
    if ((claim.evidence || []).some((evidence) => isChanged(evidence.file))) {
      claim.stale = true;
      staleClaims += 1;
    }
  }
  for (const chain of knowledge.chains || []) {
    const files = new Set([chain.start?.file, ...(chain.primary || []).map((step) => step.file), ...(chain.primary || []).map((step) => step.toFile)]);
    if ([...files].some((file) => isChanged(file))) chain.stale = true;
  }
  for (const task of knowledge.practice?.tasks || []) {
    const files = [task.target?.file, ...(task.files || [])].filter(Boolean);
    if (files.some((file) => isChanged(file))) task.stale = true;
  }
  knowledge.stale = {
    changed: [...changedPaths].slice(0, 60),
    claims: staleClaims,
    chains: (knowledge.chains || []).filter((chain) => chain.stale).length,
    tasks: (knowledge.practice?.tasks || []).filter((task) => task.stale).length,
  };
}

/* ------------------------------------------------------------------- summary */

export function summarizeKnowledge(knowledge) {
  return {
    name: knowledge.name,
    root: knowledge.root,
    commit: knowledge.git?.commit || null,
    dirty: knowledge.git?.dirty || false,
    languages: knowledge.inventory.languages.slice(0, 4),
    modules: knowledge.modules.length,
    symbols: knowledge.symbols.length,
    entryPoints: knowledge.entryPoints.length,
    chains: knowledge.chains.length,
    tests: knowledge.tests.count,
    build: knowledge.build.commands.slice(0, 4).map((command) => ({ label: command.label, display: command.display, available: command.available })),
    scannedAt: knowledge.updatedAt,
    parseErrors: knowledge.files.filter((file) => file.parseError).length,
    skipped: knowledge.scan.skipped.length,
    vendoredFiles: knowledge.inventory.vendoredSourceFiles,
  };
}
