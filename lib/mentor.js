/**
 * Human-facing mentor model: module narratives, core findings, a 3-step getting
 * started guide, lesson-based learning paths, and practice grouping.
 *
 * Everything here is derived from source evidence. When the evidence is too thin
 * the field says so instead of inventing a responsibility.
 */

import { nowIso, oneLine, round, toPosix, truncate } from './core.js';
import { buildRoadmap } from './plan.js';

const ROLE_RULES = [
  {
    test: (module) => /(^|\/)(mdk-arm|ewarm|iar|startup)(\/|$)|\.s$/i.test(module.path || ''),
    role: '启动与中断向量',
    summary: '提供复位入口、向量表和进入 C 运行库的跳转。',
    confidence: 'source',
  },
  {
    test: (module) => /(^|\/)(inc|include|headers?)(\/|$)/i.test(module.path || ''),
    role: '接口与数据结构声明',
    summary: '声明跨模块函数、结构体与宏，是模块之间的契约层。',
    confidence: 'source',
  },
  {
    test: (module) => /(^|\/)(doc|docs|documents?)(\/|$)/i.test(module.path || ''),
    role: '设计与使用文档',
    summary: '记录设计、参数或操作说明，不参与运行时执行。',
    confidence: 'source',
  },
  {
    test: (module, context) => context.isEntryModule,
    role: '程序入口与主循环',
    summary: '程序从这里启动，完成初始化后驱动主循环或任务调度。',
    confidence: 'source',
  },
  {
    test: (module) => /(cmd|command|dispatch|shell|console|uart)/i.test(`${module.name} ${module.topFiles.map((file) => file.path).join(' ')}`),
    role: '命令解析与分发',
    summary: '接收外部命令文本，解析参数并分发到具体处理函数。',
    confidence: 'inference',
  },
  {
    test: (module) => /(net|eth|tcp|udp|socket|server|client|lwip)/i.test(module.name),
    role: '网络通信',
    summary: '建立连接、收发数据，并把完整报文交给上层处理。',
    confidence: 'inference',
  },
  {
    test: (module) => /(flash|eeprom|storage|sqlite|database|persist)/i.test(module.name),
    role: '持久化与存储',
    summary: '把运行状态保存到 Flash/EEPROM/文件或数据库，并在启动时恢复。',
    confidence: 'inference',
  },
  {
    test: (module) => /(pid|motor|control|engine|servo|pwm|atim|timer|encoder)/i.test(module.name),
    role: '控制算法与执行',
    summary: '根据目标值与实际反馈计算控制量，并驱动执行器。',
    confidence: 'inference',
  },
  {
    test: (module) => /(param|config|setting|option)/i.test(module.name),
    role: '参数与配置',
    summary: '维护可配置参数及其默认值、校验和保存。',
    confidence: 'inference',
  },
  {
    test: (module) => /(ui|view|page|render|component)/i.test(module.name),
    role: '界面与交互',
    summary: '把状态呈现给用户，并把用户操作转成项目内的动作。',
    confidence: 'inference',
  },
];

function moduleSymbols(knowledge, module) {
  return (knowledge.symbols || []).filter((symbol) => symbol.module === module.id);
}

function moduleRole(knowledge, module) {
  const context = {
    isEntryModule: (knowledge.entryPoints || []).some((entry) => entry.module === module.id),
  };
  for (const rule of ROLE_RULES) {
    if (rule.test(module, context)) {
      return { role: rule.role, summary: rule.summary, confidence: rule.confidence };
    }
  }
  return {
    role: '业务实现模块',
    summary: '承担项目的一类业务或支撑职责；具体边界需要结合入口和调用方确认。',
    confidence: 'inference',
  };
}

function moduleNames(knowledge, ids) {
  return ids
    .map((id) => knowledge.modules.find((module) => module.id === id)?.name)
    .filter(Boolean)
    .slice(0, 4);
}

export function moduleNarrative(knowledge, module) {
  const symbols = moduleSymbols(knowledge, module);
  const role = moduleRole(knowledge, module);
  const top = symbols
    .slice()
    .sort((left, right) => right.loc - left.loc)
    .slice(0, 4)
    .map((symbol) => symbol.name);
  const upstream = moduleNames(knowledge, module.deps || []);
  const downstream = moduleNames(knowledge, module.dependents || []);
  const startHere = (knowledge.entryPoints || []).find((entry) => entry.module === module.id)
    || (module.topFiles || [])[0];
  const thin = symbols.length < 2;
  const confidence = thin ? 'unverified' : role.confidence;
  const summary = thin
    ? `${module.name} 的文件已扫描到，但符号证据不足，职责暂标为待深入分析。`
    : `${module.name} 包含 ${top.join('、')} 等符号，主要负责${role.role}。`;
  const responsibility = thin
    ? '待深入分析：当前只能确认目录与文件组织，不能确认业务职责。'
    : `${role.summary}${upstream.length ? ` 它依赖 ${upstream.join('、')} 提供的能力。` : ''}${downstream.length ? ` 上层 ${downstream.join('、')} 会使用它。` : ''}`;
  return {
    moduleId: module.id,
    name: module.name,
    role: thin ? '待深入分析' : role.role,
    summary,
    responsibility,
    inputs: upstream.length ? `依赖 ${upstream.join('、')} 的接口或头文件` : '没有检测到模块级上游依赖',
    outputs: downstream.length ? `向 ${downstream.join('、')} 提供接口或符号` : '对上层暴露入口或工具函数',
    upstream,
    downstream,
    startHere: startHere
      ? { file: startHere.file || startHere.path, line: startHere.line || 1 }
      : null,
    files: (module.topFiles || []).slice(0, 4).map((file) => file.path),
    symbols: symbols.slice(0, 8).map((symbol) => ({ name: symbol.name, file: symbol.file, line: symbol.line })),
    evidence: module.evidence || [],
    confidence,
    confidenceLabel: confidence === 'source' ? '源码结构可确认' : confidence === 'inference' ? '基于符号与依赖的推断' : '待验证',
  };
}

export function buildModuleNarratives(knowledge) {
  const utilityPath = /(^|\/)(docs?|examples?|samples?|demos?|tests?|specs?|benchmarks?|benches|tools|scripts?)(\/|$)/i;
  return knowledge.modules
    .filter((module) => !module.vendored)
    .filter((module) => !utilityPath.test(module.path || ''))
    .filter((module) => {
      if (module.path) return true;
      const others = knowledge.modules.filter((item) => item.id !== module.id && !item.vendored && item.symbols >= 3);
      return others.length === 0;
    })
    .filter((module) => module.importance.score >= 0.02 || (knowledge.entryPoints || []).some((entry) => entry.module === module.id))
    .slice(0, 16)
    .map((module) => moduleNarrative(knowledge, module));
}

export function buildFindings(knowledge, limit = 5) {
  const analysis = knowledge.analysis || {};
  const items = [];
  const push = (item) => {
    if (!item.text) return;
    items.push({
      id: `finding-${items.length + 1}`,
      ...item,
      confidence: item.confidence || 'inference',
      confidenceLabel: item.confidence === 'source'
        ? '源码确认'
        : item.confidence === 'doc'
          ? '文档说明'
          : item.confidence === 'unverified' ? '待验证' : '分析推断',
    });
  };

  if (analysis.oneLiner?.text) {
    push({
      title: '这个项目是什么',
      text: analysis.oneLiner.text,
      confidence: analysis.oneLiner.kind,
      evidence: analysis.oneLiner.evidence,
      action: null,
    });
  }
  if (analysis.problem?.text) {
    push({
      title: '它主要解决什么问题',
      text: analysis.problem.text,
      confidence: analysis.problem.kind,
      evidence: analysis.problem.evidence,
      action: null,
    });
  }
  if (analysis.chain?.steps?.length) {
    const steps = analysis.chain.steps;
    push({
      title: '一次典型请求如何走',
      text: `${steps[0].from} 在 ${steps[0].file}:${steps[0].line} 进入，依次经过 ${steps.slice(1).map((step) => step.to).join(' → ')}。每一步都能在源码中看到调用点。`,
      confidence: 'source',
      evidence: analysis.chain.evidence,
      action: { type: 'chain', chainId: analysis.chain.id, file: steps[0].file, line: steps[0].line },
    });
  }
  if (analysis.dataStructures?.top) {
    const top = analysis.dataStructures.top;
    push({
      title: '核心数据结构由谁持有',
      text: `${top.name} 定义在 ${top.file}:${top.line}，包含 ${top.fields.length} 个字段；生命周期判定：${top.lifecycle.verdict}。`,
      confidence: top.lifecycle.confidence,
      evidence: top.lifecycle.declarations?.length ? top.lifecycle.declarations : [{ file: top.file, line: top.line }],
      action: { type: 'file', file: top.file, line: top.line },
    });
  }
  if (analysis.concurrency?.isrs?.length) {
    push({
      title: '并发与中断从哪里进入',
      text: `项目检测到 ${analysis.concurrency.isrs.length} 个中断处理函数，例如 ${analysis.concurrency.isrs.slice(0, 2).map((isr) => isr.name).join('、')}；并发模型为 ${analysis.concurrency.model}。`,
      confidence: 'source',
      evidence: analysis.concurrency.evidence,
      action: { type: 'file', file: analysis.concurrency.isrs[0].file, line: analysis.concurrency.isrs[0].line },
    });
  }
  return items.slice(0, limit);
}

export function buildGettingStarted(knowledge, lessons) {
  const entry = (knowledge.entryPoints || []).find((item) => item.kind === 'program-entry')
    || (knowledge.entryPoints || []).find((item) => item.kind === 'reset-handler')
    || (knowledge.entryPoints || [])[0]
    || null;
  const chain = knowledge.analysis?.chain || null;
  const firstLesson = lessons[0] || null;
  const progress = knowledge.learning?.progress || {};
  const entryLevel = entry?.module ? progress[entry.module]?.level || 0 : 0;
  const chainDone = Boolean(chain && (entryLevel >= 2 || knowledge.learning?.lessons?.[firstLesson?.lessonId]?.steps?.trace));
  const lessonStatus = firstLesson ? knowledge.learning?.lessons?.[firstLesson.lessonId]?.status : null;
  return [
    {
      id: 'read-entry',
      order: 1,
      title: '先看程序从哪里开始',
      description: entry ? `打开 ${entry.file}:${entry.line}，确认 ${entry.name} 是启动入口。` : '项目没有明显入口，建议从最大模块的首个文件开始。',
      action: entry ? { type: 'file', file: entry.file, line: entry.line } : { type: 'file', file: knowledge.modules[0]?.topFiles?.[0]?.path || '', line: 1 },
      done: entryLevel >= 1,
      doneLabel: '已阅读入口',
    },
    {
      id: 'trace-chain',
      order: 2,
      title: '跟一条真实调用链',
      description: chain ? `从 ${chain.steps[0]?.from || '入口'} 跟到 ${chain.steps[chain.steps.length - 1]?.to || '终点'}，共 ${chain.steps.length} 步，每步都有源码行号。` : '当前没有可核对的调用链，先完成入口阅读。',
      action: chain ? { type: 'chain', chainId: chain.id, file: chain.steps[0].file, line: chain.steps[0].line } : null,
      done: Boolean(chainDone),
      doneLabel: '已解释调用链',
    },
    {
      id: 'first-lesson',
      order: 3,
      title: '完成第一课并做一次验证',
      description: firstLesson ? `第一课：${firstLesson.title}。读源码、回答理解问题，再用一道面试题验证。` : '生成学习路线后开始第一课。',
      action: firstLesson ? { type: 'lesson', lessonId: firstLesson.lessonId } : null,
      done: lessonStatus === 'completed',
      doneLabel: '第一课已完成',
    },
  ];
}

/* -------------------------------------------------------------------- lessons */

function chainForModule(knowledge, moduleId) {
  const chains = knowledge.chains || [];
  return chains.find((chain) => (chain.nodes || []).some((node) => node.module === moduleId))
    || chains[0]
    || null;
}

function lessonStatus(knowledge, lessonId) {
  return knowledge.learning?.lessons?.[lessonId]?.status || 'not_started';
}

export function buildLessons(knowledge, options = {}) {
  const plan = knowledge.learning?.plan?.items?.length
    ? knowledge.learning.plan
    : buildRoadmap(knowledge, {
      goal: options.goal || 'onboarding',
      level: options.level || 'beginner',
      mode: options.mode || '2h',
    });
  const lessons = [];
  for (const item of plan.items || []) {
    const module = knowledge.modules.find((candidate) => candidate.id === item.moduleId);
    if (!module) continue;
    const narrative = moduleNarrative(knowledge, module);
    const chain = chainForModule(knowledge, module.id);
    const lessonId = `lesson:${module.id}`;
    const start = narrative.startHere || { file: module.topFiles?.[0]?.path || '', line: 1 };
    const chainSteps = (chain?.primary || []).slice(0, 5);
    const explainPrompt = chain
      ? `不看笔记说明：${chain.start?.name || '入口'} 如何一步步走到 ${chainSteps[chainSteps.length - 1]?.to || '链路终点'}？${module.name} 在其中负责什么？请给出至少两个 file:line。`
      : `不看笔记说明：${module.name} 负责什么？它被谁调用、又调用了谁？请给出至少一个 file:line。`;
    lessons.push({
      lessonId,
      moduleId: module.id,
      title: `读懂 ${module.name}：${narrative.role}`,
      priority: item.priority,
      whyLearn: `${narrative.responsibility}${item.rationale?.length ? ` 选择它先学的依据：${item.rationale[0]}。` : ''}`,
      prerequisites: (item.prerequisites || []).map((prerequisite) => prerequisite.name),
      learningObjectives: [
        `能说清 ${module.name} 的职责与边界`,
        chain ? '能沿真实调用点解释一条跨函数链路' : '能定位模块入口与主要符号',
        '能指出至少两个真实 file:line 作为依据',
      ],
      steps: [
        {
          type: 'concept',
          title: '先理解它解决什么问题',
          content: narrative.summary,
        },
        {
          type: 'read',
          title: '阅读推荐入口',
          target: start,
          note: `先只读 ${start.file}:${start.line} 附近，确认函数签名与调用关系。`,
        },
        ...(chainSteps.length ? [{
          type: 'trace',
          title: '追踪一条真实调用链',
          chainId: chain.id,
          steps: chainSteps,
        }] : []),
        {
          type: 'explain',
          title: '用自己的话解释',
          prompt: explainPrompt,
          evidence: narrative.evidence,
        },
        {
          type: 'verify',
          title: '做一次低风险验证',
          instruction: `打开 ${start.file}，确认 ${narrative.symbols[0]?.name || '入口函数'} 的定义与调用点；再在面试间选「项目整体」或「${module.name}」做一道题。`,
          planId: null,
          readOnly: true,
        },
      ],
      completionCriteria: [
        `能不看笔记说出 ${module.name} 的职责`,
        '能指出至少两个真实 file:line',
        '能解释一个失败或边界路径',
      ],
      estimatedMinutes: item.budgetMinutes || 25,
      status: lessonStatus(knowledge, lessonId),
      evidence: narrative.evidence,
      startHere: start,
      module: { id: module.id, name: module.name, role: narrative.role, confidence: narrative.confidence },
    });
  }
  return lessons;
}

export function lessonProgressView(knowledge, lessons) {
  const records = knowledge.learning?.lessons || {};
  return {
    total: lessons.length,
    completed: lessons.filter((lesson) => records[lesson.lessonId]?.status === 'completed').length,
    inProgress: lessons.filter((lesson) => records[lesson.lessonId]?.status === 'in_progress').length,
    lessons: lessons.map((lesson) => ({
      lessonId: lesson.lessonId,
      title: lesson.title,
      status: lesson.status,
      updatedAt: records[lesson.lessonId]?.updatedAt || null,
      evidence: records[lesson.lessonId]?.evidence || null,
    })),
  };
}

export function recordLesson(knowledge, input = {}) {
  const lessonId = String(input.lessonId || '');
  const status = ['not_started', 'in_progress', 'completed'].includes(input.status) ? input.status : 'in_progress';
  const lessons = buildLessons(knowledge);
  const lesson = lessons.find((item) => item.lessonId === lessonId);
  if (!lesson) return { ok: false, reason: `未知课程：${lessonId || '(empty)'}` };
  const detail = truncate(String(input.detail || input.evidence?.detail || ''), 500);
  const ref = truncate(String(input.ref || input.evidence?.ref || ''), 240);
  if (status === 'completed') {
    if (detail.length < 6) return { ok: false, reason: '标记完成需要具体依据（例如你能解释的调用链或定位到的文件），不能只点按钮。' };
    if (!/[A-Za-z]:\d+|[\w./-]+:\d+/.test(ref) && !/[A-Za-z]:\d+/.test(detail)) {
      return { ok: false, reason: '标记完成需要至少一个 file:line 形式的源码位置。' };
    }
  }
  knowledge.learning = knowledge.learning || { plan: null, progress: {}, lessons: {} };
  knowledge.learning.lessons = knowledge.learning.lessons || {};
  const previous = knowledge.learning.lessons[lessonId];
  knowledge.learning.lessons[lessonId] = {
    lessonId,
    status,
    moduleId: lesson.moduleId,
    detail,
    ref,
    updatedAt: nowIso(),
    startedAt: previous?.startedAt || nowIso(),
    completedAt: status === 'completed' ? nowIso() : previous?.completedAt || null,
    steps: {
      ...(previous?.steps || {}),
      [input.step || 'manual']: nowIso(),
    },
  };
  return { ok: true, lesson: { lessonId, status }, record: knowledge.learning.lessons[lessonId] };
}

/* ------------------------------------------------------------------- practice */

function readOnlyTasks(knowledge) {
  const chain = knowledge.analysis?.chain;
  const structure = knowledge.coreStructures?.[0];
  const risk = (knowledge.risks || []).find((item) => item.evidence?.length);
  const entry = (knowledge.entryPoints || []).find((item) => item.kind === 'program-entry') || knowledge.entryPoints?.[0];
  const tasks = [];
  if (entry) {
    tasks.push({
      id: 'understand:entry-and-chain',
      category: 'understand',
      kind: 'read-only',
      title: `从 ${entry.file}:${entry.line} 开始，说清项目如何启动`,
      scenario: '新人第一次读项目，需要先知道程序从哪里开始、初始化后进入哪个循环。',
      objective: `打开入口文件，沿调用点说明初始化与主循环；至少指出两个真实 file:line。`,
      whyItMatters: '入口和主循环决定了后续所有模块的调用时机。',
      target: { file: entry.file, line: entry.line },
      evidence: entry.evidence,
      completion: '能解释入口函数、初始化顺序和主循环的触发条件。',
      readOnly: true,
      action: { type: 'file', file: entry.file, line: entry.line },
    });
  }
  if (chain?.steps?.length) {
    tasks.push({
      id: `understand:chain:${chain.id}`,
      category: 'understand',
      kind: 'read-only',
      title: `跟一遍 ${chain.steps[0].from} → ${chain.steps[chain.steps.length - 1].to}`,
      scenario: '只读代码容易迷失在函数名里，需要沿真实调用点走一遍。',
      objective: `在源码面板依次打开 ${chain.steps.slice(0, 3).map((step) => `${step.file}:${step.line}`).join('、')}，说明每一步的参数与返回。`,
      whyItMatters: '这条链路代表项目的一类典型请求。',
      target: { file: chain.steps[0].file, line: chain.steps[0].line },
      evidence: chain.evidence,
      completion: '能复述链路，并指出一个可能失败的位置。',
      readOnly: true,
      action: { type: 'chain', chainId: chain.id, file: chain.steps[0].file, line: chain.steps[0].line },
    });
  }
  if (structure) {
    tasks.push({
      id: `understand:structure:${structure.name}`,
      category: 'understand',
      kind: 'read-only',
      title: `解释 ${structure.name} 的生命周期`,
      scenario: '核心结构体被多个函数共享，先弄清谁创建、谁持有、谁释放。',
      objective: `打开 ${structure.file}:${structure.line}，列出字段，并找出至少一个实例位置。`,
      whyItMatters: '生命周期不清会导致空指针、悬垂引用或状态不一致。',
      target: { file: structure.file, line: structure.line },
      evidence: structure.evidence,
      completion: '能说明结构体由谁创建、在哪些路径被修改。',
      readOnly: true,
      action: { type: 'file', file: structure.file, line: structure.line },
    });
  }
  if (risk) {
    tasks.push({
      id: `understand:error-path:${risk.kind}`,
      category: 'understand',
      kind: 'read-only',
      title: `读懂一条失败路径（${risk.kind}）`,
      scenario: '正常路径容易读，失败路径决定系统是否可靠。',
      objective: `打开 ${risk.evidence[0].file}:${risk.evidence[0].line}，说明失败时函数返回什么、调用方如何处理。`,
      whyItMatters: '把失败路径说清楚，才有资格改它。',
      target: { file: risk.evidence[0].file, line: risk.evidence[0].line },
      evidence: risk.evidence,
      completion: '能指出失败时的返回值或错误处理位置。',
      readOnly: true,
      action: { type: 'file', file: risk.evidence[0].file, line: risk.evidence[0].line },
    });
  }
  return tasks;
}

export function buildPracticeView(knowledge, generatedTasks = []) {
  const readOnly = readOnlyTasks(knowledge);
  const groups = { understand: readOnly, 'small-change': [], challenge: [] };
  for (const task of generatedTasks) {
    const item = {
      id: task.id,
      category: task.kind === 'refactor' ? 'challenge' : 'small-change',
      kind: task.kind,
      title: task.title,
      scenario: task.objective,
      objective: task.objective,
      whyItMatters: task.kind === 'testing' ? '没有测试就无法证明修改没有回归。' : '这是从源码信号提炼出的候选改动，需要先确认它真实成立。',
      target: task.target,
      evidence: task.evidence,
      currentBehavior: task.currentBehavior,
      expectedBehavior: task.expectedBehavior,
      scope: task.scope,
      invariants: task.invariants,
      risk: task.risk,
      hints: task.hints,
      completion: '能在对话中完成修改，并通过 codementor_practice verify 的真实执行结果证明。',
      readOnly: false,
      confidence: ['testing'].includes(task.kind) ? 'confirmed-gap' : 'candidate',
      confidenceLabel: task.kind === 'testing' ? '已确认的缺口' : '候选风险（需先核对源码）',
      taskId: task.id,
      action: { type: 'file', file: task.target.file, line: task.target.line },
    };
    groups[item.category].push(item);
  }
  return {
    generatedAt: nowIso(),
    defaultCategory: readOnly.length ? 'understand' : groups['small-change'].length ? 'small-change' : 'challenge',
    categories: [
      { id: 'understand', label: '入门理解', description: '只读任务：先学会读入口、调用链、结构和失败路径。', tasks: groups.understand },
      { id: 'small-change', label: '小型修改', description: '低风险改动；候选风险必须先核对源码或需求。', tasks: groups['small-change'] },
      { id: 'challenge', label: '工程挑战', description: '长函数拆分、并发/性能/一致性；不建议新人直接上手。', tasks: groups.challenge },
    ],
    note: groups['small-change'].length + groups.challenge.length === 0
      ? '未发现足够可靠的改动任务；先用入门理解任务建立源码认知。'
      : '候选风险不是已确认 Bug；执行验证必须显式授权。',
  };
}
