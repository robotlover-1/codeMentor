/**
 * Host-side orchestration for CodeMentor: project resolution, cache lifecycle,
 * incremental refresh, tool payloads and their human-readable rendering.
 */

import { stat } from 'node:fs/promises';
import path from 'node:path';

import {
  CodeMentorError,
  PLUGIN_NAME,
  PLUGIN_VERSION,
  errorInfo,
  isAbortError,
  nowIso,
  oneLine,
  round,
  truncate,
} from './core.js';
import {
  buildChangedSet,
  findSymbols,
  markStaleItems,
  scanProject,
  summarizeKnowledge,
  traceChain,
} from './analyze.js';
import { createCommandRunner, gitInfo, KnowledgeStore } from './fs-scan.js';
import {
  buildRoadmap,
  findModule,
  GOALS,
  LEVELS,
  listProgress,
  MODES,
  nextBestModule,
  recordProgress,
} from './plan.js';
import {
  briefTask,
  buildVerificationPlan,
  executeVerification,
  generateTasks,
  practiceStats,
  recordPracticeRun,
  suggestReferencePatch,
} from './practice.js';
import {
  currentQuestion,
  ensureBank,
  getReport,
  hintFor,
  startSession,
  submitAnswer,
} from './interview.js';

const EVIDENCE_LABEL = { source: '源码', doc: '文档', inference: '推断', unverified: '待验证' };

function cite(evidence) {
  if (!evidence) return '（无源码依据）';
  if (Array.isArray(evidence)) return cite(evidence[0]);
  if (!evidence.file) return '（无源码依据）';
  return `${evidence.file}:${evidence.line}`;
}

function cites(evidenceList, limit = 2) {
  const items = (evidenceList || []).filter((evidence) => evidence?.file).slice(0, limit);
  return items.length ? items.map((evidence) => `${evidence.file}:${evidence.line}`).join('、') : '（无源码依据）';
}

function ok(value) {
  return { ok: true, ...value };
}

function fail(error, partial = {}) {
  const info = error instanceof CodeMentorError
    ? { code: error.code, message: error.message }
    : errorInfo(error);
  return { ok: false, error: info, ...partial };
}

function clampConfigNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

export class CodeMentorService {
  constructor(ctx, config = {}) {
    this.ctx = ctx;
    this.config = config || {};
    this.store = new KnowledgeStore({
      dataDir: typeof config.dataDir === 'string' && config.dataDir.trim() ? config.dataDir.trim() : undefined,
    });
    this.runner = createCommandRunner(ctx, {
      commandTimeoutMs: clampConfigNumber(config.commandTimeoutMs, 60_000),
    });
    this.memory = new Map();
    this.logger = ctx?.logger;
  }

  /* --------------------------------------------------------------- project */

  async resolveRoot(explicitPath, agent, signal) {
    const candidate = typeof explicitPath === 'string' && explicitPath.trim() ? explicitPath.trim() : '';
    if (candidate && /^(?:https?:\/\/|git@|ssh:\/\/|git:\/\/)/i.test(candidate)) {
      throw new CodeMentorError(
        'REMOTE_REPOSITORY',
        `CodeMentor 不会自行克隆远程仓库（${candidate}）。请先克隆到本地，再用本地路径调用。`,
      );
    }
    let root = candidate;
    let source = 'argument';
    if (!root && typeof this.config.projectRoot === 'string' && this.config.projectRoot.trim()) {
      root = this.config.projectRoot.trim();
      source = 'config.projectRoot';
    }
    if (!root) {
      const workingDirectory = typeof this.ctx?.get === 'function' ? this.ctx.get('workingDirectory') : undefined;
      if (workingDirectory && agent) {
        try {
          root = await workingDirectory.ensure(agent, signal);
          source = 'session.workingDirectory';
        } catch {
          /* fall through to process cwd */
        }
      }
    }
    if (!root) {
      root = process.cwd();
      source = 'process.cwd';
    }
    const resolved = path.resolve(root);
    let info;
    try {
      info = await stat(resolved);
    } catch (error) {
      throw new CodeMentorError('PROJECT_NOT_FOUND', `项目路径不存在或不可访问：${resolved}`, errorInfo(error));
    }
    if (!info.isDirectory()) {
      throw new CodeMentorError('PROJECT_NOT_DIRECTORY', `项目路径不是目录：${resolved}`);
    }
    return { root: resolved, source };
  }

  options() {
    const config = this.config;
    return {
      maxFiles: clampConfigNumber(config.maxFiles, 4000),
      maxDepth: clampConfigNumber(config.maxDepth, 24),
      maxFileBytes: clampConfigNumber(config.maxFileBytes, 512 * 1024),
      maxParseFiles: clampConfigNumber(config.maxParseFiles, 600),
      maxParseBytes: clampConfigNumber(config.maxParseBytes, 32 * 1024 * 1024),
      includeVendored: config.includeVendored === true,
      excludeDirs: Array.isArray(config.excludeDirs) ? config.excludeDirs.map(String) : [],
      vendoredDirs: Array.isArray(config.vendoredDirs) ? config.vendoredDirs.map(String) : [],
      force: false,
    };
  }

  cacheTtlMs() {
    return clampConfigNumber(this.config.cacheTtlMs, 10 * 60 * 1000);
  }

  async persist(root, knowledge) {
    try {
      knowledge.updatedAt = nowIso();
      const target = await this.store.save(root, knowledge);
      const cached = this.memory.get(root);
      if (cached) cached.savedAt = Date.now();
      return { saved: true, path: target };
    } catch (error) {
      return { saved: false, reason: errorInfo(error).message };
    }
  }

  async ensureKnowledge({ path: explicitPath, force = false, agent, signal, allowScan = true, skipReuse = false } = {}) {
    const { root, source } = await this.resolveRoot(explicitPath, agent, signal);
    const memory = this.memory.get(root);
    if (memory && !force && !skipReuse && Date.now() - memory.loadedAt < 60_000) {
      return { root, source, knowledge: memory.knowledge, cache: { hit: 'memory' } };
    }

    const stored = await this.store.load(root);
    if (stored.ok && !force && !skipReuse) {
      const cached = stored.data;
      const ttl = this.cacheTtlMs();
      const age = Date.now() - Date.parse(cached.updatedAt || 0);
      if (Number.isFinite(age) && age >= 0 && age < ttl) {
        const currentGit = await gitInfo(this.runner.run, root, signal);
        const sameCommit = (currentGit.commit || null) === (cached.git?.commit || null);
        const sameDirty = (currentGit.dirtyCount || 0) === (cached.git?.dirtyCount || 0);
        if (sameCommit && sameDirty) {
          this.memory.set(root, { knowledge: cached, loadedAt: Date.now(), savedAt: Date.now() });
          return { root, source, knowledge: cached, cache: { hit: 'disk', path: stored.path, ageMs: age } };
        }
      }
    }

    if (!allowScan) {
      if (stored.ok) {
        this.memory.set(root, { knowledge: stored.data, loadedAt: Date.now(), savedAt: Date.now() });
        return { root, source, knowledge: stored.data, cache: { hit: 'disk-stale', path: stored.path } };
      }
      throw new CodeMentorError('NO_KNOWLEDGE', '该项目还没有分析缓存；先执行 codementor_scan。');
    }

    const previous = stored.ok ? stored.data : null;
    const options = { ...this.options(), force };
    const { knowledge, changed, diagnostics } = await scanProject({
      root,
      options,
      runner: this.runner,
      previous,
      signal,
      logger: this.logger,
    });
    knowledge.codeMentor = { plugin: PLUGIN_NAME, version: PLUGIN_VERSION };
    const saved = await this.persist(root, knowledge);
    this.memory.set(root, { knowledge, loadedAt: Date.now(), savedAt: Date.now() });
    return {
      root,
      source,
      knowledge,
      cache: {
        hit: previous ? 'refresh' : 'miss',
        path: saved.path || '',
        saved: saved.saved,
        reason: saved.saved ? '' : String(saved.reason || '保存失败'),
      },
      changed,
      diagnostics,
    };
  }

  async save(root, knowledge) {
    return this.persist(root, knowledge);
  }

  /* ------------------------------------------------------------------- scan */

  async scan(args = {}, exec = {}) {
    try {
      const force = args.force === true;
      const result = await this.ensureKnowledge({
        path: args.path,
        force,
        agent: exec.agent,
        signal: exec.signal,
      });
      const knowledge = result.knowledge;
      const modules = knowledge.modules.slice(0, 16).map((module) => ({
        id: module.id,
        name: module.name,
        vendored: module.vendored,
        files: module.files,
        symbols: module.symbols,
        loc: module.loc,
        importance: module.importance.score,
        deps: module.deps.slice(0, 8),
        dependents: module.dependents.slice(0, 8),
      }));
      return ok({
        project: {
          name: knowledge.name,
          root: knowledge.root,
          resolvedFrom: result.source,
          commit: knowledge.git?.commit || null,
          branch: knowledge.git?.branch || null,
          dirty: Boolean(knowledge.git?.dirty),
          dirtyCount: knowledge.git?.dirtyCount || 0,
          languages: knowledge.inventory.languages.slice(0, 5),
          manifests: knowledge.manifests.map((item) => ({ id: item.id, name: item.name, manifest: item.manifest })),
          buildCommands: knowledge.build.commands.map((command) => ({
            label: command.label,
            display: command.display,
            kind: command.kind,
            available: command.available,
            reason: command.reason,
          })),
        },
        stats: {
          totalFiles: knowledge.inventory.totalFiles,
          sourceFiles: knowledge.inventory.sourceFiles,
          vendoredSourceFiles: knowledge.inventory.vendoredSourceFiles,
          parsedFiles: knowledge.scan.parsedFiles,
          symbols: knowledge.symbols.length,
          modules: knowledge.modules.length,
          entryPoints: knowledge.entryPoints.length,
          chains: knowledge.chains.length,
          testFiles: knowledge.tests.count,
          loc: knowledge.inventory.loc,
          durationMs: knowledge.scan.durationMs,
        },
        modules,
        entryPoints: knowledge.entryPoints.map((entry) => ({
          kind: entry.kind,
          name: entry.name,
          file: entry.file,
          line: entry.line,
          module: entry.module,
          confidence: entry.confidence,
        })),
        cache: result.cache,
        change: knowledge.change,
        diagnostics: knowledge.scan.diagnostics,
        skipped: knowledge.scan.skipped.slice(0, 12),
        warnings: knowledge.files.filter((file) => file.parseError).slice(0, 5).map((file) => ({ file: file.path, error: file.parseError })),
        note: '首次扫描只建立项目全景；符号识别是启发式的，定位结论请用 explore 核对行号。',
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      return fail(error);
    }
  }

  /* --------------------------------------------------------------- overview */

  async overview(args = {}, exec = {}) {
    try {
      const result = await this.ensureKnowledge({ path: args.path, agent: exec.agent, signal: exec.signal });
      const knowledge = result.knowledge;
      const analysis = knowledge.analysis;
      const section = typeof args.section === 'string' ? args.section : 'all';
      const maxModules = Number.isFinite(Number(args.maxModules)) ? Number(args.maxModules) : 12;

      const modules = knowledge.modules
        .filter((module) => section === 'all' || section === 'architecture' ? true : true)
        .slice(0, maxModules)
        .map((module) => ({
          id: module.id,
          name: module.name,
          vendored: module.vendored,
          files: module.files,
          symbols: module.symbols,
          loc: module.loc,
          importance: module.importance.score,
          deps: module.deps,
          dependents: module.dependents,
          topFiles: module.topFiles,
          evidence: module.evidence,
        }));

      const claims = (analysis?.claims || [])
        .filter((claim) => section === 'all' || claim.section === section)
        .map((claim) => ({
          id: claim.id,
          section: claim.section,
          text: claim.text,
          kind: claim.kind,
          evidence: claim.evidence,
          stale: Boolean(claim.stale),
          note: claim.note || '',
        }));

      const payload = ok({
        project: {
          name: knowledge.name,
          root: knowledge.root,
          commit: knowledge.git?.commit || null,
          branch: knowledge.git?.branch || null,
          dirty: Boolean(knowledge.git?.dirty),
          languages: knowledge.inventory.languages.slice(0, 4),
        },
        oneLiner: analysis?.oneLiner || null,
        problem: analysis?.problem || null,
        architecture: {
          nodes: analysis?.architecture?.nodes || [],
          edges: analysis?.architecture?.edges || [],
          mermaid: analysis?.mermaid?.architecture || '',
        },
        modules,
        chain: analysis?.chain || null,
        startup: analysis?.startup || null,
        dataStructures: analysis?.dataStructures || null,
        concurrency: analysis?.concurrency || null,
        storage: analysis?.storage || null,
        testing: knowledge.tests,
        build: {
          manifests: knowledge.manifests,
          commands: knowledge.build.commands.map((command) => ({
            label: command.label,
            display: command.display,
            kind: command.kind,
            available: command.available,
            reason: command.reason,
          })),
        },
        risks: knowledge.risks.map((risk) => ({ kind: risk.kind, severity: risk.severity, text: risk.text, evidence: risk.evidence })),
        conflicts: knowledge.conflicts,
        claims,
        mermaid: analysis?.mermaid || {},
        stale: knowledge.stale || { changed: [], claims: 0, chains: 0, tasks: 0 },
        cache: result.cache,
        notes: {
          confirmed: claims.filter((claim) => claim.kind === 'source').length,
          inferred: claims.filter((claim) => claim.kind === 'inference').length,
          unverified: claims.filter((claim) => claim.kind === 'unverified' || claim.stale).length,
        },
      });
      return payload;
    } catch (error) {
      if (isAbortError(error)) throw error;
      return fail(error);
    }
  }

  /* ---------------------------------------------------------------- explore */

  async explore(args = {}, exec = {}) {
    try {
      const target = String(args.target || '').trim();
      if (!target) return fail(new CodeMentorError('INVALID_TARGET', 'target 不能为空：给函数名、文件路径或关键字。'));
      const result = await this.ensureKnowledge({ path: args.path, agent: exec.agent, signal: exec.signal });
      const knowledge = result.knowledge;
      const mode = ['symbol', 'file', 'chain', 'search', 'references'].includes(args.mode) ? args.mode : 'symbol';
      const definitions = [];
      const references = [];
      const matches = [];
      let chain = null;
      let file = null;

      const pushDefinition = (symbol) => {
        definitions.push({
          name: symbol.name,
          kind: symbol.kind,
          file: symbol.file,
          line: symbol.line,
          endLine: symbol.endLine || symbol.line,
          signature: symbol.signature || '',
          module: symbol.module || '',
          confidence: 'heuristic',
        });
      };

      if (mode === 'file') {
        const record = knowledge.files.find((entry) => entry.path === target)
          || knowledge.files.find((entry) => entry.path.endsWith(`/${target}`))
          || knowledge.files.find((entry) => entry.path.toLowerCase() === target.toLowerCase());
        if (!record) {
          return ok({
            mode,
            query: target,
            found: false,
            definitions: [],
            references: [],
            matches: [],
            chain: null,
            file: null,
            notes: [`未在缓存中找到文件 ${target}。可用 codementor_scan 查看已解析文件，或用 grep 做全仓库文本搜索。`],
          });
        }
        const module = knowledge.modules.find((item) => item.id === (record.module || ''));
        file = {
          path: record.path,
          lang: record.lang,
          loc: record.loc,
          size: record.size,
          module: module ? { id: module.id, name: module.name } : null,
          symbols: record.symbols.map((symbol) => ({
            name: symbol.name,
            kind: symbol.kind,
            line: symbol.line,
            endLine: symbol.endLine || symbol.line,
            signature: symbol.signature || '',
            calls: (symbol.calls || []).length,
          })),
          structures: record.structures.map((structure) => ({
            name: structure.name,
            kind: structure.kind,
            line: structure.line,
            fields: (structure.fields || []).length,
          })),
          imports: (record.imports || []).slice(0, 20),
          todos: record.todos || [],
          parseError: record.parseError || null,
        };
        return ok({ mode, query: target, found: true, definitions: [], references: [], matches: [], chain: null, file, notes: [] });
      }

      if (mode === 'chain') {
        const depth = Number.isFinite(Number(args.depth)) ? Math.max(1, Math.min(8, Number(args.depth))) : 5;
        const traced = traceChain(knowledge, target, { maxDepth: depth, maxNodes: 60 });
        if (!traced.ok) {
          return ok({
            mode,
            query: target,
            found: false,
            definitions: [],
            references: [],
            matches: traced.candidates || [],
            chain: null,
            file: null,
            notes: [traced.reason, '可先用 mode=symbol 找到精确符号名。'],
          });
        }
        chain = {
          start: traced.start,
          nodes: traced.nodes.slice(0, 40),
          edges: traced.edges.slice(0, 60),
          primary: traced.primary,
          externals: traced.externals.slice(0, 20),
          stats: traced.stats,
          confidence: traced.confidence,
          truncated: traced.truncated,
        };
        return ok({ mode, query: target, found: true, definitions: [], references: [], matches: [], chain, file, notes: ['调用边来自函数体内的真实调用点；符号解析是启发式的，歧义边标记 inferred。'] });
      }

      const query = target.toLowerCase();
      const symbols = findSymbols(knowledge, target, { limit: 20 });
      for (const symbol of symbols) {
        pushDefinition(symbol);
        for (const caller of knowledge.symbols) {
          for (const call of caller.calls || []) {
            if (call.name !== symbol.name) continue;
            references.push({
              name: symbol.name,
              file: caller.file,
              line: call.line,
              module: caller.module,
              caller: caller.name,
            });
            if (references.length >= 40) break;
          }
          if (references.length >= 40) break;
        }
        if (references.length >= 40) break;
      }

      if (mode === 'search' || !definitions.length) {
        for (const module of knowledge.modules) {
          if (module.name.toLowerCase().includes(query)) {
            matches.push({
              kind: 'module',
              name: module.name,
              file: module.topFiles[0]?.path || module.path,
              line: 1,
              detail: `${module.files} 个文件，重要度 ${module.importance.score}`,
            });
          }
        }
        for (const structure of knowledge.structures) {
          if (structure.name.toLowerCase().includes(query)) {
            matches.push({
              kind: 'structure',
              name: structure.name,
              file: structure.file,
              line: structure.line,
              detail: `${structure.fields?.length || 0} 个字段，生命周期：${structure.lifecycle?.verdict || 'unknown'}`,
            });
          }
        }
        for (const todo of knowledge.todos) {
          if (`${todo.kind} ${todo.text}`.toLowerCase().includes(query)) {
            matches.push({ kind: 'todo', name: todo.kind, file: todo.file, line: todo.line, detail: todo.text });
          }
        }
        for (const fileEntry of knowledge.files) {
          if (fileEntry.path.toLowerCase().includes(query)) {
            matches.push({ kind: 'file', name: fileEntry.path, file: fileEntry.path, line: 1, detail: `${fileEntry.loc} 行，${fileEntry.symbols.length} 个符号` });
          }
        }
      }

      return ok({
        mode,
        query: target,
        found: definitions.length > 0 || references.length > 0 || matches.length > 0,
        definitions: definitions.slice(0, 20),
        references: references.slice(0, 40),
        matches: matches.slice(0, 20),
        chain,
        file,
        notes: definitions.length
          ? ['定义来自启发式解析；行号可直接用于 read。若同名符号多个，按同文件→同模块→首个定义消歧。']
          : ['没有命中符号；可用 mode=search 搜索模块/结构/文件，或直接用 grep 做文本检索。'],
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      return fail(error);
    }
  }

  /* ---------------------------------------------------------------- roadmap */

  async roadmap(args = {}, exec = {}) {
    try {
      const result = await this.ensureKnowledge({ path: args.path, agent: exec.agent, signal: exec.signal });
      const knowledge = result.knowledge;
      const plan = buildRoadmap(knowledge, {
        goal: args.goal,
        level: args.level,
        mode: args.mode,
        focus: args.focus,
        weights: this.config.priorityWeights,
      });
      knowledge.learning = knowledge.learning || { plan: null, progress: {} };
      knowledge.learning.plan = plan;
      const saved = await this.persist(result.root, knowledge);
      return ok({
        plan,
        next: nextBestModule(knowledge),
        cache: { saved: saved.saved, path: saved.path },
        note: plan.caveat,
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      return fail(error);
    }
  }

  /* --------------------------------------------------------------- progress */

  async progress(args = {}, exec = {}) {
    try {
      const result = await this.ensureKnowledge({ path: args.path, agent: exec.agent, signal: exec.signal });
      const knowledge = result.knowledge;
      const action = ['list', 'record', 'next'].includes(args.action) ? args.action : 'list';
      if (action === 'record') {
        const outcome = recordProgress(knowledge, {
          module: args.module,
          level: args.level,
          evidenceKind: args.evidence_kind,
          detail: args.detail,
          ref: args.ref,
          score: args.score,
        });
        if (!outcome.ok) return ok({ action, outcome, progress: listProgress(knowledge) });
        const saved = await this.persist(result.root, knowledge);
        return ok({ action, outcome, progress: listProgress(knowledge), cache: { saved: saved.saved } });
      }
      const progress = listProgress(knowledge);
      const next = nextBestModule(knowledge);
      return ok({ action, progress, next, note: '等级必须由证据支撑：阅读只能到「已理解基本概念」，定位/修改/验证/面试各有独立证据要求。' });
    } catch (error) {
      if (isAbortError(error)) throw error;
      return fail(error);
    }
  }

  /* --------------------------------------------------------------- practice */

  async practice(args = {}, exec = {}) {
    try {
      const result = await this.ensureKnowledge({ path: args.path, agent: exec.agent, signal: exec.signal });
      const knowledge = result.knowledge;
      knowledge.practice = knowledge.practice || { tasks: [], records: [], generatedAt: null };
      const action = ['list', 'generate', 'brief', 'verify', 'reference'].includes(args.action) ? args.action : 'list';
      const requestedId = typeof args.task_id === 'string' ? args.task_id.trim() : '';

      if (action === 'generate' || !knowledge.practice.tasks?.length) {
        const generated = generateTasks(knowledge);
        knowledge.practice.tasks = generated.tasks;
        knowledge.practice.verificationPlan = generated.verificationPlan;
        knowledge.practice.generatedAt = generated.generatedAt;
        await this.persist(result.root, knowledge);
      }

      const tasks = (knowledge.practice.tasks || []).filter((item) => !item.stale || args.include_stale === true);
      const verificationPlan = buildVerificationPlan(knowledge);
      let task = null;
      if (requestedId) {
        task = tasks.find((item) => item.id === requestedId) || null;
        const numeric = /^#?(\d+)$/.exec(requestedId);
        if (!task && numeric) task = tasks[Number(numeric[1]) - 1] || null;
      }

      if (action === 'list' || action === 'generate') {
        return ok({
          action: 'list',
          tasks: tasks.map((item) => ({
            id: item.id,
            kind: item.kind,
            title: item.title,
            module: item.module,
            target: item.target,
            objective: item.objective,
            currentBehavior: item.currentBehavior,
            expectedBehavior: item.expectedBehavior,
            risk: item.risk,
            stale: Boolean(item.stale),
            evidence: item.evidence,
          })),
          stats: practiceStats(knowledge),
          verificationPlan: verificationPlan.steps.map((step) => ({
            id: step.id,
            kind: step.kind,
            label: step.label,
            display: step.display,
            available: step.available,
            reason: step.reason,
          })),
          note: '默认只读分析。任何修改都需要用户明确授权，并建议在独立分支或隔离工作区进行。',
        });
      }

      if (!task) {
        return fail(new CodeMentorError('TASK_NOT_FOUND', `未找到任务 ${requestedId || '(empty)'}；先执行 action=list。`), {
          tasks: tasks.slice(0, 8).map((item) => ({ id: item.id, title: item.title })),
        });
      }

      if (action === 'brief') {
        const mode = ['guided', 'coop', 'reference'].includes(args.mode) ? args.mode : 'coop';
        const brief = briefTask(knowledge, task, mode);
        return ok({ action, mode, task: brief, note: 'guided 只给目标、线索与思考问题；coop 增加影响分析与验证方案；reference 才给补丁建议。' });
      }

      if (action === 'reference') {
        const proposal = suggestReferencePatch(knowledge, task);
        return ok({ action, task: { id: task.id, title: task.title }, referencePatch: proposal, note: '补丁建议未经执行验证，不会自动写入仓库。' });
      }

      const authorized = args.authorized === true;
      const allowExecution = this.config.allowCommandExecution !== false;
      if (authorized && !allowExecution) {
        return ok({
          action: 'verify',
          result: {
            executed: false,
            reason: '配置 allowCommandExecution=false，禁止执行任何命令。',
            planned: verificationPlan.steps,
          },
        });
      }
      const stepIds = Array.isArray(args.steps) ? args.steps.map(String) : undefined;
      const outcome = await executeVerification({
        knowledge,
        plan: verificationPlan,
        stepIds,
        runner: this.runner,
        root: result.root,
        signal: exec.signal,
        authorized,
      });
      if (outcome.executed) {
        recordPracticeRun(knowledge, task.id, outcome);
        await this.persist(result.root, knowledge);
      }
      return ok({
        action: 'verify',
        task: { id: task.id, title: task.title },
        authorized,
        result: outcome,
        stats: practiceStats(knowledge),
        note: '区分“已实际执行且通过”和“仅建议运行”：查看每个步骤的 executed/ok。',
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      return fail(error);
    }
  }

  /* -------------------------------------------------------------- interview */

  async interview(args = {}, exec = {}) {
    try {
      const result = await this.ensureKnowledge({ path: args.path, agent: exec.agent, signal: exec.signal });
      const knowledge = result.knowledge;
      const action = ['start', 'question', 'answer', 'hint', 'report', 'bank'].includes(args.action) ? args.action : 'question';
      ensureBank(knowledge);

      if (action === 'start') {
        const started = startSession(knowledge, {
          focus: args.focus,
          difficulty: args.difficulty,
          maxQuestions: args.max_questions,
        });
        await this.persist(result.root, knowledge);
        return ok({ action, ...started, rule: '默认每轮只提一个问题；回答后先给评价与纠错，再决定是否追问。' });
      }
      if (action === 'question') {
        const current = currentQuestion(knowledge);
        if (!current.ok && !knowledge.interview?.sessions?.length) {
          const started = startSession(knowledge, { focus: args.focus, difficulty: args.difficulty, maxQuestions: args.max_questions });
          await this.persist(result.root, knowledge);
          return ok({ action: 'start', ...started, note: '没有进行中的会话，已自动开始一轮。' });
        }
        return ok({ action, ...current });
      }
      if (action === 'hint') {
        return ok({ action, ...hintFor(knowledge) });
      }
      if (action === 'answer') {
        const graded = submitAnswer(knowledge, { answer: args.answer, questionId: args.question_id });
        if (graded.ok) await this.persist(result.root, knowledge);
        return ok({ action, ...graded });
      }
      if (action === 'report') {
        return ok({ action, ...getReport(knowledge) });
      }
      const bank = knowledge.interview.bank;
      return ok({
        action,
        dimensions: [...new Set(bank.questions.map((question) => question.dimension))],
        count: bank.questions.length,
        questions: bank.questions.map((question) => ({
          id: question.id,
          dimension: question.dimension,
          difficulty: question.difficulty,
          prompt: question.prompt,
          followups: (question.followups || []).length,
          evidence: question.evidence,
        })),
        note: bank.note,
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      return fail(error);
    }
  }

  /* ---------------------------------------------------------------- refresh */

  async refresh(args = {}, exec = {}) {
    try {
      const forced = args.force === true;
      const result = await this.ensureKnowledge({
        path: args.path,
        force: forced,
        agent: exec.agent,
        signal: exec.signal,
        skipReuse: true,
      });
      const knowledge = result.knowledge;
      const changed = knowledge.change || { added: [], modified: [], removed: [], gitDiff: null };
      const changedSet = buildChangedSet(knowledge);
      if (changedSet.size) markStaleItems(knowledge, changedSet);
      const affectedModules = new Set();
      for (const file of [...changed.added, ...changed.modified, ...changed.removed]) {
        const module = knowledge.modules.find((item) => (item.topFiles || []).some((entry) => entry.path === file));
        if (module) affectedModules.add(module.name);
      }
      const saved = await this.persist(result.root, knowledge);
      const mode = changed.added?.length || changed.modified?.length || changed.removed?.length ? 'incremental' : 'up-to-date';
      return ok({
        action: 'refresh',
        mode,
        project: { name: knowledge.name, root: knowledge.root, commit: knowledge.git?.commit || null, branch: knowledge.git?.branch || null, dirty: Boolean(knowledge.git?.dirty) },
        changed: {
          added: (changed.added || []).slice(0, 40),
          modified: (changed.modified || []).slice(0, 40),
          removed: (changed.removed || []).slice(0, 40),
          gitDiff: changed.gitDiff ? { from: changed.gitDiff.from, to: changed.gitDiff.to, files: (changed.gitDiff.files || []).slice(0, 40), error: changed.gitDiff.error } : null,
        },
        affectedModules: [...affectedModules].slice(0, 20),
        stale: knowledge.stale || { changed: [], claims: 0, chains: 0, tasks: 0 },
        counts: {
          parsedFiles: knowledge.scan.parsedFiles,
          reusedFiles: knowledge.files.length - knowledge.scan.parsedFiles,
          symbols: knowledge.symbols.length,
        },
        cache: { saved: saved.saved, path: saved.path },
        note: '增量刷新只重新解析 mtime/size 变化的文件；受影响的旧结论被标记 stale，需要重新核对。',
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      return fail(error);
    }
  }

  /* ------------------------------------------------------------------- misc */

  async status() {
    const projects = await this.store.list();
    return {
      ok: true,
      plugin: { name: PLUGIN_NAME, version: PLUGIN_VERSION },
      dataDir: this.store.dataDir,
      runner: this.runner.mode,
      projects,
    };
  }
}

/* ============================================================= UI view model */

/**
 * Read-only projection served to the Web panel. It is built from the cached
 * knowledge file only; the HTTP route never scans the filesystem.
 */
export function buildUiView(knowledge) {
  const analysis = knowledge.analysis || {};
  const plan = knowledge.learning?.plan || null;
  const progress = listProgress(knowledge);
  const verificationPlan = buildVerificationPlan(knowledge);
  const tasks = (knowledge.practice?.tasks || []).map((task) => ({
    id: task.id,
    kind: task.kind,
    title: task.title,
    module: task.module,
    target: task.target,
    risk: task.risk,
    objective: task.objective,
    currentBehavior: task.currentBehavior,
    expectedBehavior: task.expectedBehavior,
    scope: task.scope,
    invariants: task.invariants,
    hints: task.hints,
    stale: Boolean(task.stale),
    evidence: task.evidence,
  }));
  const report = getReport(knowledge);
  const interviewBank = knowledge.interview?.bank;
  return {
    meta: {
      name: knowledge.name,
      root: knowledge.root,
      commit: knowledge.git?.commit || null,
      branch: knowledge.git?.branch || null,
      dirty: Boolean(knowledge.git?.dirty),
      updatedAt: knowledge.updatedAt,
      scannedAt: knowledge.scan?.mode || 'full',
      stale: knowledge.stale || { changed: [], claims: 0, chains: 0, tasks: 0 },
      pluginVersion: knowledge.pluginVersion,
    },
    overview: {
      oneLiner: analysis.oneLiner || null,
      problem: analysis.problem || null,
      architecture: analysis.architecture || { nodes: [], edges: [], mermaid: '' },
      modules: knowledge.modules.slice(0, 24).map((module) => ({
        id: module.id,
        name: module.name,
        vendored: module.vendored,
        files: module.files,
        symbols: module.symbols,
        loc: module.loc,
        importance: module.importance.score,
        deps: module.deps,
        dependents: module.dependents,
        topFiles: module.topFiles,
        evidence: module.evidence,
      })),
      chain: analysis.chain || null,
      startup: analysis.startup || null,
      dataStructures: analysis.dataStructures || null,
      concurrency: analysis.concurrency || null,
      storage: knowledge.storage || null,
      testing: knowledge.tests || null,
      build: {
        manifests: knowledge.manifests || [],
        commands: (knowledge.build?.commands || []).map((command) => ({
          label: command.label,
          display: command.display,
          kind: command.kind,
          available: command.available,
          reason: command.reason,
        })),
      },
      risks: knowledge.risks || [],
      conflicts: knowledge.conflicts || [],
      claims: (analysis.claims || []).map((claim) => ({
        id: claim.id,
        section: claim.section,
        text: claim.text,
        kind: claim.kind,
        evidence: claim.evidence,
        stale: Boolean(claim.stale),
      })),
      mermaid: analysis.mermaid || {},
      inventory: knowledge.inventory,
    },
    explorer: {
      entryPoints: knowledge.entryPoints || [],
      modules: knowledge.modules.map((module) => ({
        id: module.id,
        name: module.name,
        path: module.path,
        vendored: module.vendored,
        files: module.files,
        loc: module.loc,
        symbols: (knowledge.symbols || [])
          .filter((symbol) => symbol.module === module.id)
          .slice(0, 60)
          .map((symbol) => ({
            id: symbol.id,
            name: symbol.name,
            kind: symbol.kind,
            file: symbol.file,
            line: symbol.line,
            endLine: symbol.endLine,
            signature: symbol.signature,
            calls: (symbol.calls || []).length,
          })),
      })),
      structures: (knowledge.coreStructures || []).map((structure) => ({
        name: structure.name,
        kind: structure.kind,
        file: structure.file,
        line: structure.line,
        fields: structure.fields,
        lifecycle: structure.lifecycle,
      })),
      chains: (knowledge.chains || []).map((chain) => ({ id: chain.id, name: chain.name, start: chain.start, primary: chain.primary, stats: chain.stats, confidence: chain.confidence, stale: Boolean(chain.stale), notes: chain.notes || [] })),
      files: (knowledge.files || []).map((file) => ({
        path: file.path,
        lang: file.lang,
        loc: file.loc,
        symbols: file.symbols.length,
        structures: file.structures.length,
        parseError: file.parseError || null,
      })),
    },
    roadmap: plan,
    progress,
    practice: {
      tasks,
      stats: practiceStats(knowledge),
      verificationPlan,
    },
    interview: {
      bank: interviewBank
        ? {
          generatedAt: interviewBank.generatedAt,
          count: interviewBank.questions.length,
          dimensions: [...new Set(interviewBank.questions.map((question) => question.dimension))],
          questions: interviewBank.questions.map((question) => ({
            id: question.id,
            dimension: question.dimension,
            difficulty: question.difficulty,
            prompt: question.prompt,
            followups: (question.followups || []).length,
            evidence: question.evidence,
            recommended: question.recommended,
          })),
        }
        : null,
      report,
      weakPoints: knowledge.interview?.weakPoints || [],
    },
  };
}

/* ===================================================================== render */

export function renderScan(args, value) {
  if (!value?.ok) return [`扫描失败：${value?.error?.message || '未知错误'}${value?.error?.code ? `（${value.error.code}）` : ''}`];
  const lines = [];
  lines.push(`项目：${value.project.name}`);
  lines.push(`路径：${value.project.root}（来源：${value.project.resolvedFrom}）`);
  if (value.project.commit) {
    lines.push(`Git：${value.project.commit.slice(0, 8)} @ ${value.project.branch}${value.project.dirty ? `（未提交改动 ${value.project.dirtyCount} 项）` : ''}`);
  } else {
    lines.push('Git：不可用（无版本增量信息）');
  }
  lines.push(`语言：${value.project.languages.map((item) => `${item.name} ${item.files} 文件`).join('、') || '未识别'}`);
  lines.push(`规模：${value.stats.totalFiles} 文件 / ${value.stats.sourceFiles} 源文件（${value.stats.vendoredSourceFiles} 个第三方） / ${value.stats.loc} 行（解析 ${value.stats.parsedFiles}）`);
  lines.push(`结构：${value.stats.modules} 个模块 / ${value.stats.symbols} 个符号 / ${value.stats.entryPoints} 个入口 / ${value.stats.chains} 条主链`);
  lines.push('');
  lines.push('入口：');
  for (const entry of value.entryPoints.slice(0, 6)) {
    lines.push(`- ${entry.name}（${entry.kind}）— ${entry.file}:${entry.line}`);
  }
  lines.push('');
  lines.push('主要模块：');
  for (const module of value.modules.slice(0, 8)) {
    const deps = module.deps.length ? ` → ${module.deps.join(', ')}` : '';
    lines.push(`- ${module.name}：${module.files} 文件 / ${module.symbols} 符号 / 重要度 ${module.importance}${module.vendored ? '（第三方）' : ''}${deps}`);
  }
  lines.push('');
  lines.push('构建方式：');
  if (value.project.buildCommands.length) {
    for (const command of value.project.buildCommands) {
      lines.push(`- ${command.display || command.label} [${command.kind}]${command.available ? '' : `（不可自动执行：${command.reason}）`}`);
    }
  } else {
    lines.push('- 未识别到可自动执行的构建命令（可能是 IDE 工程或自定义脚本）。');
  }
  if (value.project.manifests.length) {
    lines.push(`工程文件：${value.project.manifests.map((item) => `${item.name}(${item.manifest})`).join('、')}`);
  }
  if (value.diagnostics?.length) {
    lines.push('');
    lines.push('诊断：');
    for (const item of value.diagnostics) lines.push(`- [${item.level}] ${item.message}`);
  }
  if (value.cache) {
    lines.push('');
    lines.push(`缓存：${value.cache.hit}${value.cache.path ? ` · ${value.cache.path}` : ''}${value.cache.saved === false ? `（保存失败：${value.cache.reason}）` : ''}`);
  }
  lines.push('');
  lines.push(value.note);
  return [lines.join('\n')];
}

export function renderOverview(args, value) {
  if (!value?.ok) return [`项目全景生成失败：${value?.error?.message || '未知错误'}`];
  const lines = [];
  lines.push(`# ${value.project.name} · 项目全景`);
  if (value.project.commit) lines.push(`版本：${value.project.commit.slice(0, 8)}${value.project.dirty ? '（含未提交改动）' : ''}`);
  lines.push('');
  lines.push('## 结论');
  lines.push(`${value.oneLiner?.text || '缺少可读的 README，项目目标需要从源码确认。'}  _(${EVIDENCE_LABEL[value.oneLiner?.kind] || '待验证'}，${cite(value.oneLiner?.evidence)})_`);
  lines.push('');
  lines.push('## 项目主要解决的问题');
  lines.push(`${value.problem?.text || '暂无足够证据。'}  _(${EVIDENCE_LABEL[value.problem?.kind] || '待验证'}，${cite(value.problem?.evidence)})_`);
  lines.push('');
  lines.push('## 系统架构');
  if (value.architecture.mermaid) {
    lines.push('```mermaid');
    lines.push(value.architecture.mermaid);
    lines.push('```');
  }
  for (const module of value.modules.slice(0, 10)) {
    const depText = module.deps.length ? `依赖：${module.deps.join('、')}` : '无模块依赖';
    lines.push(`- **${module.name}**（${module.files} 文件 / ${module.symbols} 符号 / 重要度 ${module.importance}）— ${depText}；证据 ${cites(module.evidence, 1)}`);
  }
  lines.push('');
  lines.push('## 典型执行链路');
  if (value.chain?.steps?.length) {
    lines.push(`置信度：${value.chain.confidence}（调用边有源码行号；符号解析为启发式）`);
    for (const step of value.chain.steps.slice(0, 8)) {
      lines.push(`${step.step}. \`${step.from}\` → \`${step.to}\` — ${step.file}:${step.line}${step.confidence === 'inferred' ? '（推断）' : ''}`);
    }
    if (value.chain.mermaid) {
      lines.push('');
      lines.push('```mermaid');
      lines.push(value.chain.mermaid);
      lines.push('```');
    }
  } else {
    lines.push('未构建出可核对的调用链；可先执行 codementor_explore mode=chain。');
  }
  if (value.startup?.steps?.length) {
    lines.push('');
    lines.push('启动路径：');
    for (const step of value.startup.steps) {
      lines.push(`- ${step.from} → ${step.to}（${step.fromFile}:${step.line}）${step.confidence === 'inferred' ? '（推断）' : ''}`);
    }
    for (const note of value.startup.notes || []) lines.push(`  ${note}`);
  }
  lines.push('');
  lines.push('## 核心数据结构与生命周期');
  const top = value.dataStructures?.top;
  if (top) {
    lines.push(`- ${top.name}（${top.file}:${top.line}）：${top.fields.length} 个字段；生命周期判定 **${top.lifecycle.verdict}**（${top.lifecycle.confidence}）。`);
    if (top.fields.length) lines.push(`  字段：${top.fields.slice(0, 10).map((field) => field.name).join('、')}`);
    for (const item of top.lifecycle.declarations || []) lines.push(`  - 实例：${item.file}:${item.line} ${item.variable || ''}`);
    for (const item of top.lifecycle.releases || []) lines.push(`  - 释放：${item.file}:${item.line} ${item.variable || ''}`);
    if (value.dataStructures.mermaid) {
      lines.push('```mermaid');
      lines.push(value.dataStructures.mermaid);
      lines.push('```');
    }
  } else {
    lines.push('- 未识别到结构体/类定义。');
  }
  lines.push('');
  lines.push('## 并发与异步模型');
  lines.push(`- 模型：${value.concurrency?.model || 'unknown'}；ISR ${value.concurrency?.counts?.isr || 0} 个，RTOS 原语 ${value.concurrency?.counts?.rtos || 0} 处，锁/临界区 ${value.concurrency?.counts?.lock || 0} 处。`);
  for (const isr of (value.concurrency?.isrs || []).slice(0, 5)) lines.push(`  - ${isr.name} — ${isr.file}:${isr.line}`);
  lines.push('');
  lines.push('## 数据存储与外部依赖');
  lines.push(`- 存储：${value.storage?.kinds?.join('、') || '未识别到持久化调用'}${value.storage?.evidence?.length ? `（证据 ${cites(value.storage.evidence, 2)}）` : ''}`);
  lines.push(`- 测试：${value.testing?.count || 0} 个测试文件${value.testing?.frameworks?.length ? `，框架 ${value.testing.frameworks.join('、')}` : '，未识别测试框架'}`);
  lines.push('');
  lines.push('## 构建、部署与运行');
  if (value.build.commands.length) {
    for (const command of value.build.commands) {
      lines.push(`- \`${command.display || command.label}\`${command.available ? '' : `（不可自动执行：${command.reason}）`}`);
    }
  } else {
    lines.push('- 未识别到可自动执行的构建命令。');
  }
  lines.push('');
  lines.push('## 关键技术难点与风险');
  if (value.risks.length) {
    for (const risk of value.risks.slice(0, 6)) lines.push(`- [${risk.severity}] ${risk.text}${risk.evidence?.length ? `（证据 ${cites(risk.evidence, 2)}）` : ''}`);
  } else {
    lines.push('- 未发现明显风险信号。');
  }
  if (value.conflicts?.length) {
    lines.push('');
    lines.push('文档与源码冲突：');
    for (const conflict of value.conflicts) lines.push(`- ${conflict.text}（${cites(conflict.evidence, 1)}）`);
  }
  lines.push('');
  lines.push('## 证据状态');
  lines.push(`- 已确认（源码）：${value.notes.confirmed} 条；推断：${value.notes.inferred} 条；待验证/过期：${value.notes.unverified} 条。`);
  if (value.stale?.changed?.length) lines.push(`- 自上次分析以来有 ${value.stale.changed.length} 个文件变化，${value.stale.claims} 条结论被标记为 stale。`);
  lines.push('');
  lines.push('## 下一步');
  lines.push('执行 `codementor_roadmap` 生成学习路线，或 `codementor_explore` 精读某个模块。');
  return [lines.join('\n')];
}

export function renderExplore(args, value) {
  if (!value?.ok) return [`定位失败：${value?.error?.message || '未知错误'}`];
  const lines = [];
  lines.push(`定位：${value.query}（mode=${value.mode}）`);
  if (!value.found) {
    lines.push(value.notes?.join('\n') || '没有命中。');
    for (const match of value.matches || []) lines.push(`- ${match.kind}: ${match.name} — ${match.file}:${match.line} ${match.detail || ''}`);
    return [lines.join('\n')];
  }
  if (value.file) {
    const file = value.file;
    lines.push(`文件：${file.path}（${file.lang}，${file.loc} 行，模块 ${file.module?.name || '未知'}）`);
    lines.push('');
    lines.push('符号：');
    for (const symbol of file.symbols.slice(0, 30)) {
      lines.push(`- ${symbol.kind} ${symbol.name} — ${symbol.line}-${symbol.endLine}（调用 ${symbol.calls} 次）`);
    }
    if (file.structures.length) {
      lines.push('');
      lines.push('结构：');
      for (const structure of file.structures) lines.push(`- ${structure.kind} ${structure.name} — ${structure.line}（${structure.fields} 字段）`);
    }
    if (file.imports.length) {
      lines.push('');
      lines.push('导入：');
      for (const item of file.imports.slice(0, 12)) lines.push(`- ${item.line}: ${item.raw}`);
    }
    if (file.todos.length) {
      lines.push('');
      for (const todo of file.todos) lines.push(`- ${todo.kind} ${file.path}:${todo.line} ${todo.text}`);
    }
    return [lines.join('\n')];
  }
  if (value.chain) {
    const chain = value.chain;
    lines.push(`调用链起点：${chain.start.name}（${chain.start.file}:${chain.start.line}）`);
    lines.push(`置信度：${chain.confidence}；节点 ${chain.stats.nodes}，边 ${chain.stats.edges}，外部调用 ${chain.stats.external}${chain.truncated ? '，已截断' : ''}`);
    lines.push('');
    lines.push('主路径：');
    for (const step of chain.primary) {
      lines.push(`${step.step}. ${step.from} → ${step.to} — ${step.file}:${step.line}${step.confidence === 'inferred' ? '（推断）' : ''}`);
    }
    if (chain.externals.length) {
      lines.push('');
      lines.push('未解析/外部调用（不假设其行为）：');
      for (const item of chain.externals.slice(0, 10)) lines.push(`- ${item.name} — ${item.file}:${item.line}`);
    }
    lines.push('');
    lines.push(value.notes?.join('\n') || '');
    return [lines.join('\n')];
  }
  lines.push('');
  if (value.definitions.length) {
    lines.push('定义：');
    for (const definition of value.definitions) {
      lines.push(`- ${definition.kind} ${definition.name} — ${definition.file}:${definition.line}-${definition.endLine}（模块 ${definition.module}）`);
      if (definition.signature) lines.push(`  ${definition.signature}`);
    }
  }
  if (value.references.length) {
    lines.push('');
    lines.push('调用点：');
    for (const reference of value.references.slice(0, 20)) {
      lines.push(`- ${reference.caller} 调用 ${reference.name} — ${reference.file}:${reference.line}`);
    }
  }
  if (value.matches.length) {
    lines.push('');
    lines.push('匹配：');
    for (const match of value.matches.slice(0, 15)) {
      lines.push(`- [${match.kind}] ${match.name} — ${match.file}:${match.line} ${match.detail || ''}`);
    }
  }
  lines.push('');
  lines.push(value.notes?.join('\n') || '');
  return [lines.join('\n')];
}

export function renderRoadmap(args, value) {
  if (!value?.ok) return [`学习路线生成失败：${value?.error?.message || '未知错误'}`];
  const plan = value.plan;
  const lines = [];
  lines.push(`# 学习路线 · ${plan.summary}`);
  lines.push(`目标：${plan.goalLabel} · 水平：${plan.levelLabel} · 模式：${plan.modeLabel}`);
  lines.push('');
  for (const item of plan.items) {
    lines.push(`## ${item.order}. [${item.priority}] ${item.module}（评分 ${item.score}）`);
    lines.push(`目标：${item.objective}`);
    lines.push(`理由：${item.rationale.join('；')}`);
    lines.push(`证据：${cites(item.evidence, 2)}`);
    if (item.prerequisites.length) lines.push(`前置：${item.prerequisites.map((dep) => `${dep.name}${dep.learned ? '（已掌握）' : ''}`).join('、')}`);
    lines.push(`当前状态：${item.status.label} · 预算约 ${item.budgetMinutes} 分钟`);
    lines.push('');
  }
  if (plan.skipped.length) {
    lines.push(`未纳入本次预算：${plan.skipped.slice(0, 8).map((item) => `${item.module}(${item.priority})`).join('、')}`);
    lines.push('');
  }
  if (value.next) {
    lines.push(`下一步最值得学：**${value.next.module}**（${value.next.reason}）`);
  }
  lines.push(plan.caveat);
  return [lines.join('\n')];
}

export function renderProgress(args, value) {
  if (!value?.ok) return [`进度操作失败：${value?.error?.message || '未知错误'}`];
  const lines = [];
  if (value.outcome) {
    lines.push(value.outcome.reason);
    if (Number.isFinite(value.outcome.level)) lines.push(`当前等级：${value.outcome.level}（${value.outcome.label}）`);
    if (value.outcome.missingEvidence?.length) lines.push(`仍需证据：${value.outcome.missingEvidence.join('；')}`);
    lines.push('');
  }
  lines.push('模块进度：');
  for (const item of value.progress.items.slice(0, 15)) {
    lines.push(`- ${item.module}：L${item.level} ${item.label}（证据 ${item.evidenceCount} 条）`);
  }
  if (value.next) {
    lines.push('');
    lines.push(`下一步：**${value.next.module}** — ${value.next.reason}`);
  }
  lines.push('');
  lines.push(value.note || '');
  return [lines.join('\n')];
}

export function renderPractice(args, value) {
  if (!value?.ok) return [`实践任务操作失败：${value?.error?.message || '未知错误'}`];
  const lines = [];
  if (value.action === 'list') {
    lines.push(`# 实践任务（${value.tasks.length}）`);
    value.tasks.forEach((task, index) => {
      lines.push(`- #${index + 1} [${task.kind}][${task.risk.level}] ${task.title} — ${task.target.file}:${task.target.line}`);
      lines.push(`  id: ${task.id}`);
    });
    lines.push('');
    lines.push('验证计划：');
    for (const step of value.verificationPlan) {
      lines.push(`- ${step.label}：${step.display || '（需手工执行）'}${step.available ? '' : ` — ${step.reason}`}`);
    }
    lines.push('');
    lines.push(value.note);
    return [lines.join('\n')];
  }
  if (value.action === 'brief') {
    const task = value.task;
    lines.push(`# ${task.title}（${task.kind} · ${value.mode} 模式）`);
    lines.push(`目标：${task.objective}`);
    lines.push(`当前行为：${task.currentBehavior}`);
    lines.push(`预期行为：${task.expectedBehavior}`);
    lines.push(`范围：${task.scope}`);
    lines.push(`不变量：`);
    for (const invariant of task.invariants) lines.push(`- ${invariant}`);
    lines.push(`风险：${task.risk.level} — ${task.risk.reasons.join('；')}`);
    if (task.risk.blastRadius.length) lines.push(`影响面：${task.risk.blastRadius.join('、')}`);
    lines.push('');
    lines.push('线索：');
    for (const hint of task.hints) lines.push(`- ${hint}`);
    lines.push('');
    lines.push('验证计划（未执行前只能算建议）：');
    for (const step of task.verification.steps) {
      lines.push(`- ${step.label}：${step.display || '（需手工执行）'}${step.available ? '' : ` — ${step.reason}`}`);
    }
    if (value.mode === 'reference') {
      lines.push('');
      lines.push(`参考实现：${task.referencePatch.available ? `\`\`\`\n${task.referencePatch.proposal}\n\`\`\`\n${task.referencePatch.reason}` : task.referencePatch.reason}`);
    }
    lines.push('');
    lines.push('默认只读分析；真正修改仓库前请获得用户明确授权，并使用独立分支或隔离工作区。');
    return [lines.join('\n')];
  }
  if (value.action === 'reference') {
    lines.push(`# 参考实现：${value.task.title}`);
    lines.push(value.referencePatch.reason);
    if (value.referencePatch.proposal) {
      lines.push('```');
      lines.push(value.referencePatch.proposal);
      lines.push('```');
    }
    lines.push(`已验证：${value.referencePatch.verified ? '是' : '否（仅建议，未执行验证）'}`);
    return [lines.join('\n')];
  }
  const result = value.result;
  lines.push(`# 验证结果（${result.summary?.verdict || 'nothing-executed'}）`);
  if (result.executed === false) {
    lines.push(result.reason || '未执行。');
    for (const step of result.planned || []) {
      lines.push(`- ${step.label}：${step.display || '（手工）'}${step.available ? '' : ` — ${step.reason}`}`);
    }
    return [lines.join('\n')];
  }
  for (const item of result.results) {
    const status = item.executed ? (item.ok ? '✅ 执行通过' : `❌ 执行失败（exit ${item.exitCode}）`) : item.skipped ? '⏭️ 跳过（未验证）' : '⚠️ 启动失败';
    lines.push(`## ${item.label} — ${status}`);
    if (item.display) lines.push(`命令：\`${item.display}\``);
    if (item.stdoutTail) lines.push(`stdout:\n\`\`\`\n${item.stdoutTail}\n\`\`\``);
    if (item.stderrTail) lines.push(`stderr:\n\`\`\`\n${item.stderrTail}\n\`\`\``);
  }
  lines.push('');
  lines.push(`总计：执行 ${result.summary.executed}，通过 ${result.summary.passed}，失败 ${result.summary.failed}，跳过 ${result.summary.skipped}`);
  lines.push(result.summary.note);
  return [lines.join('\n')];
}

export function renderInterview(args, value) {
  if (!value?.ok) return [`面试操作失败：${value?.error?.message || '未知错误'}`];
  const lines = [];
  if (value.question) {
    lines.push(`# 面试题 ${value.question.progress ? `(${value.question.progress.index}/${value.question.progress.total})` : ''}`);
    lines.push(`维度：${value.question.dimension} ｜ 难度：${value.question.difficulty} ｜ 类型：${value.question.kind}`);
    lines.push(`题目 id：${value.question.questionId}`);
    lines.push('');
    lines.push(value.question.prompt);
    lines.push('');
    lines.push('提示（不包含答案）：');
    for (const hint of value.question.hints || []) lines.push(`- ${hint}`);
    if (value.question.done) lines.push(value.question.reason || '本轮已结束。');
    return [lines.join('\n')];
  }
  if (value.grading) {
    lines.push(`# 回答评价：${value.verdict}（${value.grading.overall}）`);
    lines.push(value.feedback);
    lines.push('');
    lines.push('维度：');
    for (const dimension of value.grading.dimensions) {
      lines.push(`- ${dimension.label}：${dimension.score}${dimension.missing.length ? `（缺：${dimension.missing.slice(0, 3).join('；')}）` : ''}`);
    }
    if (value.correction) {
      lines.push('');
      lines.push(`纠错：${value.correction}`);
    }
    if (value.grading.unverifiedCitations?.length) {
      lines.push(`无法核对的引用：${value.grading.unverifiedCitations.join('、')}`);
    }
    lines.push('');
    lines.push('推荐回答（简洁版）：');
    lines.push(value.recommended?.concise || '—');
    lines.push('');
    lines.push('推荐回答（深入版）：');
    lines.push(value.recommended?.deep || '—');
    if (value.next?.ok) {
      lines.push('');
      lines.push(`下一问：${value.next.prompt}`);
      lines.push(`（${value.next.kind === 'followup' ? '追问' : '新题'}，维度 ${value.next.dimension}）`);
    } else {
      lines.push('');
      lines.push(value.next?.reason || '本轮结束。');
    }
    lines.push('');
    lines.push(`评分方法：${value.grading.method}；${value.grading.caveat}`);
    return [lines.join('\n')];
  }
  if (value.session) {
    lines.push(`# 面试会话 ${value.session.id}`);
    const difficulty = value.session.difficultyLabel || (value.session.difficulty === 'junior' ? '初级' : value.session.difficulty === 'senior' ? '高级' : '中级');
    const quota = value.session.maxQuestions ? `基础题配额 ${value.session.maxQuestions} · ` : '';
    lines.push(`${difficulty} · ${quota}题库 ${value.session.total} 题 · 聚焦：${value.session.focus || '全部维度'}`);
    if (value.weakest) lines.push(`当前最弱维度：${value.weakest.label}（${value.weakest.average}）`);
    lines.push('');
    for (const dimension of value.dimensions || []) lines.push(`- ${dimension.label}：${dimension.average}（${dimension.attempts} 题）`);
    if (value.weakPoints?.length) {
      lines.push('');
      lines.push('薄弱点记录：');
      for (const point of value.weakPoints.slice(0, 6)) lines.push(`- ${point.label}：${(point.missing || []).join('；')}`);
    }
    lines.push('');
    lines.push(value.recommendation);
    return [lines.join('\n')];
  }
  if (value.questions) {
    lines.push(`# 题库（${value.count} 题，维度：${value.dimensions.join('、')}）`);
    for (const question of value.questions) {
      lines.push(`- [${question.dimension}/${question.difficulty}] ${oneLine(question.prompt, 160)}（追问 ${question.followups} 层）`);
      lines.push(`  id: ${question.id}`);
    }
    lines.push('');
    lines.push(value.note);
    return [lines.join('\n')];
  }
  if (value.hint) {
    lines.push('# 提示');
    for (const item of value.hint) lines.push(`- ${item}`);
    return [lines.join('\n')];
  }
  lines.push(value.note || '（无输出）');
  return [lines.join('\n')];
}

export function renderRefresh(args, value) {
  if (!value?.ok) return [`增量刷新失败：${value?.error?.message || '未知错误'}`];
  const lines = [];
  lines.push(`# 增量刷新：${value.mode}`);
  lines.push(`项目：${value.project.name} @ ${value.project.commit ? value.project.commit.slice(0, 8) : 'no-git'}${value.project.dirty ? '（dirty）' : ''}`);
  const changed = value.changed;
  lines.push(`变化：新增 ${changed.added.length}，修改 ${changed.modified.length}，删除 ${changed.removed.length}`);
  for (const file of [...changed.added.map((item) => `+ ${item}`), ...changed.modified.map((item) => `~ ${item}`), ...changed.removed.map((item) => `- ${item}`)].slice(0, 20)) {
    lines.push(`- ${file}`);
  }
  if (value.affectedModules.length) lines.push(`受影响模块：${value.affectedModules.join('、')}`);
  lines.push(`复用文件：${value.counts.reusedFiles}，重新解析：${value.counts.parsedFiles}`);
  if (value.stale?.claims) lines.push(`被标记过期的结论：${value.stale.claims} 条；过期调用链：${value.stale.chains} 条；过期练习：${value.stale.tasks} 个。`);
  lines.push('');
  lines.push(value.note);
  return [lines.join('\n')];
}

export { round, truncate, GOALS, LEVELS, MODES };
