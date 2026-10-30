/**
 * Learning planner: priority scoring, time-budgeted roadmaps, evidence-based
 * progress and the "what to learn next" recommendation.
 *
 * The priority formula is a weighted sum of five normalized components. It is a
 * ranking device, not a measurement: every component is reported so a learner
 * can see why an item is P0 instead of trusting a mysterious score.
 */

import { clamp, nowIso, round, truncate, weightedScore } from './core.js';

export const GOALS = {
  overview: '快速了解项目',
  onboarding: '准备加入项目开发',
  module: '学习某一技术模块',
  maintenance: '接手已有模块维护',
  debug: '排查故障',
  feature: '实现新功能',
  interview: '准备技术面试',
};

export const LEVELS = {
  beginner: '初级',
  intermediate: '中级',
  advanced: '高级',
};

export const MODES = {
  '30m': { label: '30 分钟：项目全景速览', maxItems: 4, depth: 'concept', minutes: 30 },
  '2h': { label: '2 小时：主调用链和核心模块入门', maxItems: 9, depth: 'flow', minutes: 120 },
  deep: { label: '深度学习：逐模块精读、修改练习与面试训练', maxItems: 20, depth: 'deep', minutes: 0 },
};

export const PROGRESS_LABELS = [
  '未学习',
  '已理解基本概念',
  '能解释真实调用链',
  '能独立定位相关代码',
  '能独立修改并验证',
  '能通过技术追问',
];

export const EVIDENCE_KINDS = {
  read: '阅读了源码或文档',
  explained: '复述/解释了模块作用',
  located: '从需求或符号定位到具体位置',
  modified: '完成了代码修改',
  verified: '执行了验证（构建/测试/差分检查）',
  interview: '通过了对应模块的面试追问',
};

export const DEFAULT_WEIGHTS = {
  importance: 0.35,
  frequency: 0.2,
  goalRelevance: 0.2,
  dependency: 0.1,
  gap: 0.15,
};

/* ------------------------------------------------------------------ helpers */

function moduleDepth(modules) {
  const byId = new Map(modules.map((module) => [module.id, module]));
  const memo = new Map();
  const visit = (id, stack = new Set()) => {
    if (memo.has(id)) return memo.get(id);
    if (stack.has(id)) return 0;
    stack.add(id);
    const module = byId.get(id);
    let depth = 0;
    for (const dep of module?.deps || []) {
      if (!byId.has(dep)) continue;
      depth = Math.max(depth, 1 + visit(dep, stack));
    }
    stack.delete(id);
    memo.set(id, depth);
    return depth;
  };
  for (const module of modules) visit(module.id);
  return memo;
}

function tokenizeGoal(goal, focus) {
  const words = new Set();
  const pool = `${GOALS[goal] || ''} ${focus || ''}`.toLowerCase();
  for (const token of pool.split(/[^\p{L}\p{N}_-]+/u)) {
    if (token.length >= 2) words.add(token);
  }
  return words;
}

function moduleText(module) {
  return `${module.name} ${module.path} ${module.languages.join(' ')}`.toLowerCase();
}

function goalRelevance(module, goal, focus, knowledge) {
  const text = moduleText(module);
  const tokens = tokenizeGoal(goal, focus);
  let relevance = 0.45;
  for (const token of tokens) {
    if (text.includes(token)) relevance += 0.25;
  }

  const hasIsr = (knowledge.concurrency?.isrs || []).some((isr) => isr.file.startsWith(`${module.path}/`) || isr.file === module.path);
  const riskFiles = new Set((knowledge.risks || []).flatMap((risk) => (risk.evidence || []).map((item) => item.file)));
  const hasRisk = (module.topFiles || []).some((file) => riskFiles.has(file.path)) || riskFiles.has(module.path);
  const hasTests = (knowledge.tests?.files || []).some((file) => file.startsWith(`${module.path}/`));
  const isEntry = (knowledge.entryPoints || []).some((entry) => entry.module === module.id);

  switch (goal) {
    case 'overview':
      relevance += module.importance.score * 0.3;
      break;
    case 'onboarding':
      if (module.deps.length || module.dependents.length) relevance += 0.2;
      if (hasTests) relevance += 0.1;
      break;
    case 'module':
      relevance += focus && text.includes(String(focus).toLowerCase()) ? 0.35 : 0;
      break;
    case 'maintenance':
      if (module.dependents.length >= 2) relevance += 0.2;
      if (isEntry) relevance += 0.15;
      if (hasTests) relevance += 0.1;
      break;
    case 'debug':
      if (hasIsr) relevance += 0.3;
      if (hasRisk) relevance += 0.2;
      if (knowledge.storage?.evidence?.some((item) => item.file.startsWith(`${module.path}/`))) relevance += 0.15;
      break;
    case 'feature':
      if (module.importance.score >= 0.5) relevance += 0.25;
      if (module.dependents.length === 0) relevance += 0.1;
      break;
    case 'interview':
      if (hasIsr) relevance += 0.2;
      if ((module.topFiles || []).some((file) => (file.symbols || 0) >= 10)) relevance += 0.15;
      if (module.importance.score >= 0.4) relevance += 0.1;
      break;
    default:
      break;
  }
  return clamp(relevance, 0, 1);
}

function priorityOf(item, rank, total) {
  if (item.vendored) return 'P2';
  if (item.utility) return 'P2';
  if (!item.substantive) return 'P2';
  if (item.entryModule) return 'P0';
  if (item.score >= 0.55) return 'P0';
  if (rank < Math.max(1, Math.ceil(total * 0.5)) && item.score >= 0.2) return 'P1';
  if (item.score >= 0.35) return 'P1';
  return 'P2';
}

const UTILITY_PATH = /(^|\/)(docs?|examples?|samples?|demos?|tests?|specs?|benchmarks?|benches|tools|scripts?)(\/|$)/i;

function isUtilityModule(module, knowledge) {
  if (module.path && UTILITY_PATH.test(module.path)) return true;
  if (!module.path) {
    const otherModules = knowledge.modules.filter((item) => item.id !== module.id && !item.vendored && item.symbols >= 3);
    if (!otherModules.length) return false;
    return module.importance.score < 0.15;
  }
  return false;
}

function levelLabel(level) {
  return PROGRESS_LABELS[clamp(Number(level) || 0, 0, 5)] || PROGRESS_LABELS[0];
}

function progressLevel(knowledge, moduleId) {
  return clamp(Number(knowledge.learning?.progress?.[moduleId]?.level) || 0, 0, 5);
}

/* ------------------------------------------------------------------ roadmap */

export function buildRoadmap(knowledge, options = {}) {
  const goal = Object.hasOwn(GOALS, options.goal) ? options.goal : 'overview';
  const level = Object.hasOwn(LEVELS, options.level) ? options.level : 'beginner';
  const mode = Object.hasOwn(MODES, options.mode) ? options.mode : '30m';
  const weights = { ...DEFAULT_WEIGHTS, ...(options.weights || {}) };
  const focus = typeof options.focus === 'string' ? options.focus : '';
  const modeSpec = MODES[mode];

  const modules = knowledge.modules.filter((module) => !module.vendored && module.files > 0);
  const depthMap = moduleDepth(modules);
  const maxDepth = Math.max(1, ...depthMap.values());
  const maxFanIn = Math.max(1, ...modules.map((module) => module.dependents.length + module.metrics.callIn));
  const moduleIds = new Set(modules.map((module) => module.id));
  const entryModules = new Set((knowledge.entryPoints || []).map((entry) => entry.module).filter(Boolean));

  const scored = modules.map((module) => {
    const gap = 1 - progressLevel(knowledge, module.id) / 5;
    const depth = depthMap.get(module.id) || 0;
    const utility = isUtilityModule(module, knowledge);
    const relevance = utility ? Math.min(0.2, goalRelevance(module, goal, focus, knowledge)) : goalRelevance(module, goal, focus, knowledge);
    const components = {
      importance: module.importance.score,
      frequency: clamp((module.dependents.length + module.metrics.callIn) / maxFanIn, 0, 1),
      goalRelevance: relevance,
      dependency: clamp(1 - (depth / Math.max(1, maxDepth)) * 0.5, 0, 1),
      gap,
    };
    const score = weightedScore(components, weights);
    return {
      module,
      depth,
      components,
      score,
      utility,
      substantive: module.importance.score >= 0.08 || module.dependents.length > 0 || module.symbols >= 3,
      entryModule: entryModules.has(module.id),
    };
  });

  scored.sort((left, right) => right.score - left.score);

  const items = [];
  for (let rank = 0; rank < scored.length; rank += 1) {
    const entry = scored[rank];
    const module = entry.module;
    const priority = priorityOf(entry, rank, scored.length);
    const prerequisites = module.deps
      .filter((dep) => moduleIds.has(dep))
      .map((dep) => knowledge.modules.find((candidate) => candidate.id === dep))
      .filter(Boolean)
      .sort((left, right) => right.importance.score - left.importance.score)
      .slice(0, 3)
      .map((dep) => ({ id: dep.id, name: dep.name, learned: progressLevel(knowledge, dep.id) >= 3 }));

    const rationale = [];
    rationale.push(`重要度 ${module.importance.score}（被 ${module.dependents.length} 个模块依赖，跨模块调用 ${module.metrics.callIn} 次）`);
    rationale.push(`目标相关性 ${round(entry.components.goalRelevance, 2)}（目标：${GOALS[goal]}）`);
    rationale.push(`依赖层级 ${entry.depth}（${prerequisites.length ? `先学 ${prerequisites.map((item) => item.name).join('、')}` : '无前置模块'}）`);
    rationale.push(`知识缺口 ${round(entry.components.gap, 2)}（当前状态：${levelLabel(progressLevel(knowledge, module.id))}）`);

    items.push({
      order: 0,
      moduleId: module.id,
      module: module.name,
      priority,
      score: round(entry.score, 3),
      entryModule: entry.entryModule,
      utility: entry.utility,
      substantive: entry.substantive,
      components: {
        importance: round(entry.components.importance, 3),
        frequency: round(entry.components.frequency, 3),
        goalRelevance: round(entry.components.goalRelevance, 3),
        dependency: round(entry.components.dependency, 3),
        gap: round(entry.components.gap, 3),
      },
      rationale,
      objective: objectiveFor(module, priority, goal),
      prerequisites,
      files: (module.topFiles || []).slice(0, 3).map((file) => file.path),
      evidence: module.evidence,
      status: {
        level: progressLevel(knowledge, module.id),
        label: levelLabel(progressLevel(knowledge, module.id)),
      },
      budgetMinutes: 0,
    });
  }

  const filtered = selectForBudget(items, mode, level);
  const ordered = orderByPrerequisites(filtered);
  ordered.forEach((item, index) => {
    item.order = index + 1;
    item.budgetMinutes = modeSpec.minutes
      ? Math.max(5, Math.round(modeSpec.minutes / Math.max(1, ordered.length)))
      : 25;
  });

  const plan = {
    generatedAt: nowIso(),
    goal,
    goalLabel: GOALS[goal],
    level,
    levelLabel: LEVELS[level],
    mode,
    modeLabel: modeSpec.label,
    depth: modeSpec.depth,
    weights,
    items: ordered,
    skipped: items.filter((item) => !ordered.includes(item)).slice(0, 20).map((item) => ({
      moduleId: item.moduleId,
      module: item.module,
      priority: item.priority,
      score: item.score,
      reason: item.priority === 'P2' ? 'P2 按需掌握，本次时间预算未纳入' : '时间预算未纳入，可在深度学习模式继续',
    })),
    summary: `${GOALS[goal]} · ${LEVELS[level]} · ${modeSpec.label}：共 ${ordered.length} 个模块，P0 ${ordered.filter((item) => item.priority === 'P0').length} 个。`,
    caveat: '时间模式是内容预算，不保证在对应时间内完全掌握；优先级是排序原则，不是能力测量。',
  };
  return plan;
}

function orderByPrerequisites(items) {
  const byId = new Map(items.map((item) => [item.moduleId, item]));
  const visited = new Set();
  const result = [];
  const visit = (item, stack) => {
    if (!item || visited.has(item.moduleId) || stack.has(item.moduleId)) return;
    stack.add(item.moduleId);
    const prerequisites = (item.prerequisites || [])
      .map((prerequisite) => byId.get(prerequisite.id))
      .filter(Boolean)
      .sort((left, right) => right.score - left.score);
    for (const prerequisite of prerequisites) visit(prerequisite, stack);
    stack.delete(item.moduleId);
    visited.add(item.moduleId);
    result.push(item);
  };
  for (const item of [...items].sort((left, right) => right.score - left.score)) visit(item, new Set());
  return result;
}

function objectiveFor(module, priority, goal) {
  if (priority === 'P0') {
    return `能不看笔记说明 ${module.name} 的职责、入口和它在主调用链中的位置，并指出至少 3 个真实文件:行号。`;
  }
  if (priority === 'P1') {
    return `能解释 ${module.name} 的关键实现和设计取舍，并能在修改后说明需要回归的调用方。`;
  }
  return `按需了解 ${module.name}：知道它解决什么问题、什么时候会用到即可。`;
}

function selectForBudget(items, mode, level) {
  const p0 = items.filter((item) => item.priority === 'P0');
  const p1 = items.filter((item) => item.priority === 'P1');
  const p2 = items.filter((item) => item.priority === 'P2');
  const pool = level === 'beginner' ? [...p0, ...p1] : level === 'intermediate' ? [...p0, ...p1, ...p2] : [...p0, ...p1, ...p2];
  if (mode === '30m') return pool.filter((item) => item.priority === 'P0').slice(0, MODES['30m'].maxItems);
  if (mode === '2h') return [...p0, ...p1].slice(0, MODES['2h'].maxItems);
  return [...p0, ...p1].slice(0, MODES.deep.maxItems);
}

/* ----------------------------------------------------------------- progress */

export function recordProgress(knowledge, input = {}) {
  const requested = clamp(Number(input.level ?? 0), 0, 5);
  const kind = String(input.evidenceKind || input.kind || '').trim();
  if (!Object.hasOwn(EVIDENCE_KINDS, kind)) {
    return {
      ok: false,
      reason: `evidenceKind 必须是 ${Object.keys(EVIDENCE_KINDS).join('/')} 之一`,
      accepted: false,
    };
  }
  const module = findModule(knowledge, input.module);
  if (!module) {
    return {
      ok: false,
      reason: `未找到模块：${input.module || '(empty)'}`,
      accepted: false,
      candidates: knowledge.modules.slice(0, 8).map((item) => ({ id: item.id, name: item.name })),
    };
  }

  knowledge.learning = knowledge.learning || { plan: null, progress: {} };
  const progress = knowledge.learning.progress[module.id] || { level: 0, evidence: [], updatedAt: null };
  const evidence = {
    kind,
    level: requested,
    detail: truncate(String(input.detail || ''), 500),
    ref: truncate(String(input.ref || ''), 240),
    score: Number.isFinite(Number(input.score)) ? round(Number(input.score), 3) : null,
    at: nowIso(),
  };
  progress.evidence = [...(progress.evidence || []), evidence].slice(-80);

  const kinds = new Set(progress.evidence.map((item) => item.kind));
  const interviewScore = Math.max(0, ...progress.evidence.filter((item) => item.kind === 'interview').map((item) => item.score || 0));
  let allowed = 0;
  if (kinds.has('read') || kinds.has('explained')) allowed = 1;
  if (kinds.has('explained')) allowed = 2;
  if (kinds.has('located')) allowed = 3;
  if (kinds.has('modified') && kinds.has('verified')) allowed = 4;
  if (kinds.has('interview') && interviewScore >= 0.6) allowed = 5;

  const requirement = requirementFor(requested);
  const applied = requested <= allowed;
  progress.level = Math.max(progress.level || 0, applied ? requested : allowed);
  progress.updatedAt = nowIso();
  if (!progress.startedAt) progress.startedAt = progress.updatedAt;
  progress.module = module.name;
  knowledge.learning.progress[module.id] = progress;

  const next = nextBestModule(knowledge);
  return {
    ok: true,
    accepted: true,
    applied,
    requested,
    allowedLevel: allowed,
    level: progress.level,
    label: levelLabel(progress.level),
    module: { id: module.id, name: module.name },
    evidence,
    requirement,
    reason: applied
      ? `已记录证据并将 ${module.name} 推进到「${levelLabel(progress.level)}」。`
      : `证据不足以支撑等级 ${requested}（「${levelLabel(requested)}」）。需要：${requirement.join('；')}。已记录证据，但等级保持在「${levelLabel(progress.level)}」。`,
    missingEvidence: applied ? [] : requirement,
    next,
  };
}

function requirementFor(level) {
  if (level <= 0) return ['无需证据：等级 0 表示未学习'];
  if (level === 1) return ['read 或 explained 证据'];
  if (level === 2) return ['explained 证据：能解释模块作用与真实调用链'];
  if (level === 3) return ['located 证据：能从需求/符号定位到真实文件与行号'];
  if (level === 4) return ['modified 证据与 verified 证据：完成修改并实际执行验证'];
  return ['interview 证据且评分 ≥ 0.6：通过该模块的技术追问'];
}

export function findModule(knowledge, query) {
  if (!query) return null;
  const needle = String(query).toLowerCase();
  return knowledge.modules.find((module) => module.id === query)
    || knowledge.modules.find((module) => module.name.toLowerCase() === needle)
    || knowledge.modules.find((module) => module.name.toLowerCase().includes(needle))
    || knowledge.modules.find((module) => (module.topFiles || []).some((file) => file.path.toLowerCase().includes(needle)))
    || null;
}

export function listProgress(knowledge) {
  const progress = knowledge.learning?.progress || {};
  const items = knowledge.modules
    .filter((module) => !module.vendored)
    .map((module) => {
      const entry = progress[module.id];
      return {
        moduleId: module.id,
        module: module.name,
        priority: knowledge.learning?.plan?.items?.find((item) => item.moduleId === module.id)?.priority || '—',
        level: entry?.level || 0,
        label: levelLabel(entry?.level || 0),
        evidenceCount: entry?.evidence?.length || 0,
        lastEvidence: entry?.evidence?.length ? entry.evidence[entry.evidence.length - 1] : null,
        updatedAt: entry?.updatedAt || null,
      };
    })
    .sort((left, right) => right.level - left.level || left.module.localeCompare(right.module));
  return {
    items,
    counts: PROGRESS_LABELS.map((label, index) => ({ level: index, label, count: items.filter((item) => item.level === index).length })),
    next: nextBestModule(knowledge),
  };
}

export function nextBestModule(knowledge) {
  const plan = knowledge.learning?.plan;
  const items = plan?.items?.length ? plan.items : buildRoadmap(knowledge, { goal: 'onboarding', level: 'beginner', mode: '2h' }).items;
  if (!items.length) return null;
  const ranked = items
    .map((item) => {
      const level = progressLevel(knowledge, item.moduleId);
      const gain = item.score * (1 - level / 5);
      const blocked = (item.prerequisites || []).some((prerequisite) => progressLevel(knowledge, prerequisite.id) < 3);
      return { item, level, gain, blocked };
    })
    .filter((entry) => entry.level < 5)
    .sort((left, right) => (left.blocked === right.blocked ? right.gain - left.gain : left.blocked ? 1 : -1));
  const best = ranked[0];
  if (!best) return null;
  const module = knowledge.modules.find((item) => item.id === best.item.moduleId);
  return {
    moduleId: best.item.moduleId,
    module: best.item.module,
    priority: best.item.priority,
    level: best.level,
    label: levelLabel(best.level),
    score: round(best.gain, 3),
    blocked: best.blocked,
    reason: best.blocked
      ? `前置模块尚未达到「能独立定位」：${(best.item.prerequisites || []).filter((prerequisite) => progressLevel(knowledge, prerequisite.id) < 3).map((prerequisite) => prerequisite.name).join('、')}。先补齐前置再学 ${best.item.module}。`
      : `当前状态下收益最高：优先级 ${best.item.priority}、评分 ${best.item.score}、知识缺口 ${round(1 - best.level / 5, 2)}。`,
    files: (module?.topFiles || []).slice(0, 3).map((file) => file.path),
    evidence: module?.evidence || [],
    suggestedGoal: best.item.priority === 'P0' ? 'overview' : 'module',
  };
}

export { levelLabel, moduleDepth };
