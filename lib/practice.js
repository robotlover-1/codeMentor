/**
 * Engineering practice lab.
 *
 * Tasks are derived from observable source evidence only (TODO comments, ignored
 * return values, unsafe libc calls, missing tests, allocation sites). The
 * verification plan is a list of concrete argv arrays; execution is opt-in and
 * every result records whether the command actually ran.
 */

import {
  CodeMentorError,
  KNOWN_VOID_CALLS,
  clamp,
  declaredReturnType,
  nowIso,
  oneLine,
  round,
  truncate,
} from './core.js';

const TASK_LIMIT = 12;

const UNSAFE_HINT = {
  strcpy: 'strcpy 不接收目标缓冲区长度；考虑 snprintf/strncpy 并显式写入终止符。',
  strcat: 'strcat 可能越界；先确认目标剩余容量，或改用有界拼接。',
  sprintf: 'sprintf 不限制输出长度；改用 snprintf 并检查返回值。',
  gets: 'gets 无法限长，必须替换。',
  memcpy: '确认源长度来自可信变量且不超过目标容量。',
  memmove: '确认长度参数与实际缓冲区容量一致。',
  scanf: 'scanf 的 %s 无长度上限，需要显式宽度或改用其他解析方式。',
};

function taskId(kind, file, line) {
  return `${kind}:${file}:${line}`.toLowerCase().replace(/[^a-z0-9:_/-]+/g, '-');
}

function lineSnippet(knowledge, file, line) {
  const record = knowledge.files.find((entry) => entry.path === file);
  if (!record) return '';
  return truncate(`${record.path}:${line}`, 200);
}

function findSymbolAt(knowledge, file, line) {
  return (knowledge.symbols || []).find((symbol) =>
    symbol.file === file && symbol.line <= line && (symbol.endLine || symbol.line) >= line,
  ) || null;
}

function moduleOfFile(knowledge, file) {
  return (knowledge.modules || []).find((module) =>
    (module.topFiles || []).some((entry) => entry.path === file)
    || file.startsWith(`${module.path}/`),
  ) || null;
}

function baseTask(knowledge, { kind, file, line, title, objective, currentBehavior, expectedBehavior, severity }) {
  const symbol = findSymbolAt(knowledge, file, line);
  const module = moduleOfFile(knowledge, file);
  const riskLevel = severity || (symbol && symbol.loc > 120 ? 'medium' : 'low');
  return {
    id: taskId(kind, file, line),
    kind,
    title,
    moduleId: module?.id || '',
    module: module?.name || '',
    target: { file, line, snippet: lineSnippet(knowledge, file, line) },
    symbol: symbol ? { name: symbol.name, file: symbol.file, line: symbol.line } : null,
    files: [file],
    objective,
    currentBehavior,
    expectedBehavior,
    scope: symbol
      ? `只修改 ${symbol.name}（${file}:${symbol.line}-${symbol.endLine}）内的逻辑；不改变对外函数签名。`
      : `只修改 ${file}:${line} 附近的逻辑，不扩大改动范围。`,
    dependencies: (module?.deps || []).map((dep) => knowledge.modules.find((item) => item.id === dep)?.name).filter(Boolean).slice(0, 5),
    invariants: [
      '不得改变已有函数的对外签名与调用约定（除非题目明确要求）。',
      '失败路径必须保持可预期：返回错误码或进入既有错误处理，不允许静默忽略。',
      '不得修改与本任务无关的构建配置和第三方代码。',
    ],
    risk: {
      level: riskLevel,
      reasons: [
        symbol ? `目标函数约 ${symbol.loc} 行，调用点 ${symbol.calls?.length || 0} 个。` : '目标是单行/局部改动。',
        module ? `模块 ${module.name} 被 ${module.dependents.length} 个模块依赖。` : '目标文件没有明显的外部依赖。',
      ],
      blastRadius: module ? (module.dependents || []).slice(0, 6) : [],
    },
    evidence: [{ file, line, symbol: symbol?.name || '' }],
    hints: {
      guided: [
        `先读 ${file}:${Math.max(1, line - 8)} 附近的上下文，确认这段代码的调用者与失败处理约定。`,
        '回答：如果这里失败，调用方期望收到什么（返回码、日志、重试、回滚）？',
        '回答：这个改动会影响哪些相邻路径（正常路径、异常路径、中断/并发路径）？',
      ],
      coop: [
        '先用 explore 工具确认函数调用者，再列出所有需要同步修改的失败处理。',
        '把修改限制在一个函数内，保留原有控制流；先写验证命令，再改代码。',
        '修改后必须实际执行构建/测试，并把退出码和关键输出贴回记录。',
      ],
    },
    referencePatch: { available: false, reason: '需要结合项目语义；CodeMentor 只提供机械可推导的补丁建议。', proposal: null, verified: false },
    stale: false,
    createdAt: nowIso(),
  };
}

/* ------------------------------------------------------------- verification */

export function buildVerificationPlan(knowledge) {
  const steps = [];
  const git = knowledge.git || {};
  const buildCommand = (knowledge.build?.commands || []).find((command) => command.kind === 'build' && command.available)
    || (knowledge.build?.commands || []).find((command) => command.kind === 'configure' && command.available);
  const testCommand = (knowledge.build?.commands || []).find((command) => command.kind === 'test' && command.available)
    || (knowledge.tests?.commands || []).find((command) => command.available);
  const unavailableBuild = (knowledge.build?.commands || []).find((command) => command.kind === 'build');

  steps.push({
    id: 'diff-check',
    kind: 'static',
    label: 'Git Diff 检查（空白/冲突标记）',
    argv: ['git', 'diff', '--check'],
    display: 'git diff --check',
    available: Boolean(git.available),
    reason: git.available ? '' : '当前不是 Git 仓库，无法做差分检查。',
  });
  steps.push({
    id: 'diff-stat',
    kind: 'diff',
    label: 'Git Diff 审查（改动范围）',
    argv: ['git', 'diff', '--stat'],
    display: 'git diff --stat',
    available: Boolean(git.available),
    reason: git.available ? '' : '当前不是 Git 仓库，无法审查差分。',
  });

  if (buildCommand) {
    steps.push({
      id: buildCommand.kind === 'configure' ? 'configure' : 'build',
      kind: buildCommand.kind === 'configure' ? 'configure' : 'build',
      label: buildCommand.label,
      argv: buildCommand.argv,
      display: buildCommand.display,
      available: true,
      reason: '',
    });
  } else {
    steps.push({
      id: 'build',
      kind: 'build',
      label: '构建',
      argv: null,
      display: unavailableBuild?.display || '',
      available: false,
      reason: unavailableBuild?.reason || '未检测到可自动执行的构建命令；请提供构建方式，或在 IDE 中手工构建。',
      manual: true,
    });
  }

  if (testCommand) {
    steps.push({
      id: testCommand.kind === 'test' ? 'test' : testCommand.kind,
      kind: 'test',
      label: testCommand.label,
      argv: testCommand.argv,
      display: testCommand.display,
      available: true,
      reason: '',
    });
  } else {
    steps.push({
      id: 'test',
      kind: 'test',
      label: '自动化测试',
      argv: null,
      display: '',
      available: false,
      reason: knowledge.tests?.count
        ? '检测到测试文件，但未识别出可自动运行的测试命令；请说明测试框架入口。'
        : '未检测到自动化测试；只能依赖构建、静态检查和手工回归。',
      manual: true,
    });
  }

  steps.push({
    id: 'manual-regression',
    kind: 'manual',
    label: '关键功能回归',
    argv: null,
    display: '',
    available: false,
    reason: '需要在真实设备/运行环境验证正常路径、异常路径和边界条件；CodeMentor 不会声称已执行。',
    manual: true,
  });

  return {
    planId: `plan:${knowledge.git?.commit?.slice(0, 8) || 'nogit'}`,
    generatedAt: nowIso(),
    steps,
    notes: [
      '只有 available=true 的步骤会被 codementor_practice verify 执行。',
      '执行结果会记录真实 argv、退出码和输出片段；未执行的步骤永远标记为 skipped/manual。',
    ],
  };
}

export async function executeVerification({ knowledge, plan, stepIds, runner, root, signal, authorized }) {
  if (authorized !== true) {
    return {
      executed: false,
      reason: '未获得明确授权。请用户确认后传入 authorized=true；CodeMentor 默认只做只读分析。',
      planned: plan.steps.map((step) => ({ id: step.id, label: step.label, display: step.display, available: step.available, reason: step.reason })),
    };
  }
  const requested = Array.isArray(stepIds) && stepIds.length ? new Set(stepIds) : null;
  const results = [];
  for (const step of plan.steps) {
    if (requested && !requested.has(step.id)) continue;
    if (!step.available || !Array.isArray(step.argv)) {
      results.push({
        stepId: step.id,
        label: step.label,
        kind: step.kind,
        display: step.display || '',
        executed: false,
        skipped: true,
        reason: step.reason || '该步骤不可自动执行。',
        exitCode: null,
        durationMs: 0,
        stdoutTail: '',
        stderrTail: '',
      });
      continue;
    }
    const started = Date.now();
    try {
      const outcome = await runner.run(step.argv, root, { signal, timeoutMs: 120000 });
      results.push({
        stepId: step.id,
        label: step.label,
        kind: step.kind,
        display: step.display,
        argv: step.argv,
        executed: true,
        skipped: false,
        exitCode: outcome.code,
        timedOut: Boolean(outcome.timedOut),
        durationMs: Date.now() - started,
        stdoutTail: tail(outcome.stdout, 3000),
        stderrTail: tail(outcome.stderr, 2000),
        ok: outcome.code === 0,
        reason: '',
      });
    } catch (error) {
      results.push({
        stepId: step.id,
        label: step.label,
        kind: step.kind,
        display: step.display,
        argv: step.argv,
        executed: false,
        skipped: false,
        exitCode: null,
        durationMs: Date.now() - started,
        stdoutTail: '',
        stderrTail: oneLine(error?.message || String(error), 500),
        ok: false,
        reason: '命令启动失败；这不等于验证通过。',
      });
    }
  }
  const executed = results.filter((result) => result.executed);
  const passed = executed.filter((result) => result.ok);
  const failed = executed.filter((result) => !result.ok);
  const skipped = results.filter((result) => result.skipped);
  return {
    executed: executed.length > 0,
    results,
    summary: {
      total: results.length,
      executed: executed.length,
      passed: passed.length,
      failed: failed.length,
      skipped: skipped.length,
      verdict: failed.length ? 'failed' : executed.length ? 'passed-for-executed-steps' : 'nothing-executed',
      note: '只有 executed=true 且 ok=true 的步骤才算通过；skipped/manual 步骤未被验证。',
    },
  };
}

function tail(text, max) {
  const value = String(text || '');
  return value.length <= max ? value : `…${value.slice(value.length - max)}`;
}

/* ------------------------------------------------------------------- tasks */

export function generateTasks(knowledge, options = {}) {
  const tasks = [];
  const seen = new Set();
  const voidNames = buildVoidNames(knowledge.symbols || []);
  const push = (task) => {
    if (seen.has(task.id)) return;
    seen.add(task.id);
    tasks.push(task);
  };

  for (const todo of (knowledge.todos || []).slice(0, 24)) {
    if (todo.kind === 'HACK') continue;
    push(baseTask(knowledge, {
      kind: 'todo',
      file: todo.file,
      line: todo.line,
      title: `完成 ${todo.kind}：${oneLine(todo.text || '未填写说明', 70)}`,
      objective: `按注释意图补全 ${todo.file}:${todo.line} 附近缺失的实现或清理项。`,
      currentBehavior: `${todo.kind} 注释表明这里尚未完成：${oneLine(todo.text || '(空)', 200)}`,
      expectedBehavior: '注释描述的行为被实现，且调用方看到的行为与注释一致。',
      severity: 'low',
    }));
  }

  for (const file of knowledge.files) {
    for (const signal of (file.signals?.ignoredReturn || []).slice(0, 6)) {
      if (voidNames.has(signal.name)) continue;
      const symbol = findSymbolAt(knowledge, file.path, signal.line);
      push(baseTask(knowledge, {
        kind: 'error-handling',
        file: file.path,
        line: signal.line,
        title: `处理 ${signal.name} 的返回值`,
        objective: `在 ${file.path}:${signal.line} 检查 ${signal.name} 的返回值，并补齐失败路径。`,
        currentBehavior: `${signal.name} 的返回值被忽略；失败时后续逻辑仍按成功路径继续。`,
        expectedBehavior: '失败时返回真实错误、记录可诊断日志或回滚已发生的副作用。',
        severity: symbol && symbol.loc > 100 ? 'medium' : 'low',
      }));
      if (tasks.length >= 120) break;
    }
    if (tasks.length >= 120) break;
  }

  for (const file of knowledge.files) {
    for (const signal of (file.signals?.unsafe || []).slice(0, 4)) {
      push(baseTask(knowledge, {
        kind: 'safety',
        file: file.path,
        line: signal.line,
        title: `为 ${signal.name} 增加边界检查`,
        objective: `确认 ${file.path}:${signal.line} 的 ${signal.name} 调用不会越界，并补充必要的长度检查。`,
        currentBehavior: `使用 ${signal.name}，当前代码没有可见的长度校验。`,
        expectedBehavior: `调用前验证目标容量与源长度；超出时拒绝并返回错误。${UNSAFE_HINT[signal.name] || ''}`,
        severity: 'medium',
      }));
      if (tasks.length >= 120) break;
    }
    if (tasks.length >= 120) break;
  }

  for (const file of knowledge.files) {
    for (const signal of (file.signals?.alloc || []).slice(0, 3)) {
      push(baseTask(knowledge, {
        kind: 'boundary',
        file: file.path,
        line: signal.line,
        title: `校验 ${signal.name} 的失败与释放路径`,
        objective: `检查 ${file.path}:${signal.line} 的分配结果，确认 NULL/失败分支和释放路径。`,
        currentBehavior: `发生 ${signal.name} 调用；扫描未在同一位置看到显式失败分支。`,
        expectedBehavior: '分配失败时进入明确错误处理；所有提前返回路径都不会泄漏已分配资源。',
        severity: 'medium',
      }));
      if (tasks.length >= 120) break;
    }
  }

  if (knowledge.tests?.count === 0) {
    const module = knowledge.modules.find((item) => !item.vendored && item.symbols >= 5);
    if (module?.topFiles?.length) {
      const file = module.topFiles[0].path;
      push(baseTask(knowledge, {
        kind: 'testing',
        file,
        line: 1,
        title: `为 ${module.name} 补充第一个单元测试`,
        objective: `为 ${module.name} 的一个纯函数建立可重复运行的测试入口，并让它先失败再通过。`,
        currentBehavior: '仓库中没有自动化测试，回归只能靠手工运行。',
        expectedBehavior: '存在一个能在本机执行的测试命令，覆盖正常输入和一个边界输入。',
        severity: 'low',
      }));
    }
  }

  const longFunctions = [];
  for (const file of knowledge.files) {
    for (const symbol of file.symbols) {
      if (symbol.loc >= 150) longFunctions.push({ file: file.path, symbol });
    }
  }
  longFunctions.sort((left, right) => right.symbol.loc - left.symbol.loc);
  for (const entry of longFunctions.slice(0, 3)) {
    push(baseTask(knowledge, {
      kind: 'refactor',
      file: entry.file,
      line: entry.symbol.line,
      title: `拆分长函数 ${entry.symbol.name}（${entry.symbol.loc} 行）`,
      objective: `在不改变外部行为的前提下，把 ${entry.symbol.name} 中的一段独立逻辑提取为有名字的 helper。`,
      currentBehavior: `函数 ${entry.symbol.name} 约 ${entry.symbol.loc} 行，包含多个职责。`,
      expectedBehavior: '至少提取一个可独立解释的步骤，调用方与返回值保持不变。',
      severity: 'high',
    }));
  }

  const selected = selectBalancedTasks(tasks);
  const tasksWithVerification = selected.map((task) => ({
    ...task,
    verification: buildVerificationPlan(knowledge),
  }));

  const plan = buildVerificationPlan(knowledge);
  return {
    tasks: tasksWithVerification,
    verificationPlan: plan,
    generatedAt: nowIso(),
    note: '题目全部来自当前源码证据；referencePatch 仅在机械可推导时提供，且不会被标记为已验证。',
  };
}

function buildVoidNames(symbols) {
  const names = new Set(KNOWN_VOID_CALLS);
  for (const symbol of symbols) {
    if (symbol.kind !== 'prototype') continue;
    if (/^void\b/.test(declaredReturnType(symbol))) names.add(symbol.name);
  }
  return names;
}

const KIND_LIMITS = {
  todo: 4,
  safety: 3,
  boundary: 3,
  'error-handling': 4,
  testing: 1,
  refactor: 2,
};

/**
 * Keep the exercise list varied instead of letting one scanner family fill all
 * twelve slots. Per-kind caps and per-caller deduplication are explicit.
 */
function selectBalancedTasks(tasks) {
  const selected = [];
  const seen = new Set();
  for (const kind of Object.keys(KIND_LIMITS)) {
    let count = 0;
    for (const task of tasks) {
      if (task.kind !== kind) continue;
      const key = task.kind === 'error-handling'
        ? `${task.module}|${task.symbol?.name || task.target.file}|${task.title}`
        : task.id;
      if (seen.has(key)) continue;
      seen.add(key);
      selected.push(task);
      count += 1;
      if (count >= KIND_LIMITS[kind]) break;
    }
  }
  return selected.slice(0, TASK_LIMIT);
}

export function suggestReferencePatch(knowledge, task) {
  if (!task) return { available: false, reason: '未找到任务。', proposal: null, verified: false };
  const file = knowledge.files.find((entry) => entry.path === task.target.file);
  if (!file) return { available: false, reason: '目标文件不在当前缓存中，请先 scan。', proposal: null, verified: false };
  if (task.kind === 'error-handling' && /malloc|calloc|realloc|fopen/i.test(task.title)) {
    const variable = /处理\s+([A-Za-z_]\w*)/.exec(task.title)?.[1] || 'result';
    return {
      available: true,
      reason: '机械可推导的空值检查建议；返回类型与错误码需按项目约定确认。',
      proposal: [
        `// ${task.target.file}:${task.target.line} 之后插入，并按项目约定替换 TODO`,
        `if (${variable} == NULL) {`,
        '    /* TODO: 记录日志 / 返回错误码 / 回滚已发生的副作用 */',
        '    return -1;',
        '}',
      ].join('\n'),
      verified: false,
    };
  }
  if (task.kind === 'safety') {
    return {
      available: true,
      reason: '方向性建议，不是可直接应用的补丁：需要知道目标缓冲区大小与源长度来源。',
      proposal: [
        '/* 先确认 dst_size 与 src_len 的真实来源 */',
        'if (src_len >= dst_size) {',
        '    /* 记录错误并返回 */',
        '    return -1;',
        '}',
        'memcpy(dst, src, src_len);',
        'dst[src_len] = \'\\0\';',
      ].join('\n'),
      verified: false,
    };
  }
  return {
    available: false,
    reason: '该任务需要结合语义与项目约定生成补丁；CodeMentor 不伪造“参考实现”。请让 Agent 在阅读真实调用方后给出补丁。',
    proposal: null,
    verified: false,
  };
}

export function briefTask(knowledge, task, mode) {
  const plan = task.verification?.steps ? task.verification : buildVerificationPlan(knowledge);
  const base = {
    id: task.id,
    mode,
    title: task.title,
    kind: task.kind,
    objective: task.objective,
    currentBehavior: task.currentBehavior,
    expectedBehavior: task.expectedBehavior,
    scope: task.scope,
    dependencies: task.dependencies,
    invariants: task.invariants,
    risk: task.risk,
    target: task.target,
    files: task.files,
    evidence: task.evidence,
    hints: mode === 'guided' ? task.hints.guided : [...task.hints.guided, ...task.hints.coop],
    verification: {
      planId: plan.planId,
      steps: plan.steps.map((step) => ({
        id: step.id,
        label: step.label,
        kind: step.kind,
        display: step.display || '',
        available: step.available,
        reason: step.reason || '',
      })),
      note: '未实际执行的步骤只能算“建议验证”，不能算已通过。',
    },
    referencePatch: mode === 'reference'
      ? suggestReferencePatch(knowledge, task)
      : { available: false, reason: '当前模式不提供完整实现；切换到 reference 模式需用户明确请求。', proposal: null, verified: false },
  };
  return base;
}

export function recordPracticeRun(knowledge, taskId, outcome) {
  knowledge.practice = knowledge.practice || { tasks: [], records: [], generatedAt: null };
  knowledge.practice.records = [
    ...(knowledge.practice.records || []),
    {
      taskId,
      at: nowIso(),
      summary: outcome.summary,
      results: (outcome.results || []).map((result) => ({
        stepId: result.stepId,
        executed: result.executed,
        exitCode: result.exitCode,
        ok: result.ok ?? null,
        skipped: result.skipped,
      })),
    },
  ].slice(-50);
  return knowledge.practice.records[knowledge.practice.records.length - 1];
}

export function practiceStats(knowledge) {
  const records = knowledge.practice?.records || [];
  const last = records[records.length - 1] || null;
  return {
    tasks: knowledge.practice?.tasks?.length || 0,
    runs: records.length,
    last,
    passedRuns: records.filter((record) => record.summary?.verdict === 'passed-for-executed-steps').length,
    failedRuns: records.filter((record) => record.summary?.verdict === 'failed').length,
  };
}
