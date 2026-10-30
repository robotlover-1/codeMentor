/**
 * Teaching layer: turn evidence into learner-facing explanations.
 *
 * Model calls are on demand only, validated, cached by project snapshot + evidence
 * hash + model + prompt version, and always have a conservative deterministic
 * fallback. The homepage never blocks on a model call.
 */

import { nowIso, oneLine, sha1, toPosix, truncate } from './core.js';
import { moduleNarrative } from './mentor.js';

const TEACHING_VERSION = 1;
const MAX_SNIPPET_CHARS = 6000;

const MODULE_SYSTEM = `你是 CodeMentor 的技术导师，只能基于给出的源码证据解释，不得编造业务。
只输出一个 JSON 对象：
{
  "summary": "50-120 字，先讲功能/场景，再讲怎么实现；不要以符号清单开头",
  "responsibility": "这个功能在项目中承担什么责任",
  "scenario": "一个具体使用场景，说明谁在什么时候用它",
  "inputs": "业务意义上的输入，不写参数类型表",
  "outputs": "业务意义上的结果或状态变化",
  "failure": "主要失败情况与系统应对；证据不足写待核实",
  "confidence": "verified | inferred | unknown",
  "evidence": [{"file": "给出的文件", "line": 1}]
}
禁止在正文堆砌“包含 A、B 等符号”；禁止编造文件和行号；不确定内容写进 failure 或明确标待核实。`;

const FUNCTION_SYSTEM = `你是 CodeMentor 的源码导师，只能基于给出的源码片段和调用关系解释。
只输出一个 JSON 对象：
{
  "oneLine": "一句话说明它完成什么操作",
  "when": "谁在什么场景触发它",
  "inputOutput": "关键参数的业务含义、返回或修改的状态",
  "steps": ["按真实条件分支的 3-6 步执行流程"],
  "failure": "失败时的返回/回退/日志/资源释放",
  "sideEffects": "副作用或状态变化",
  "relation": "它在功能链中的位置",
  "uncertainties": ["宏、函数指针、外部依赖等无法确认的点"],
  "evidence": [{"file": "给出的文件", "line": 1}]
}
禁止把签名或调用方列表当作解释；禁止编造文件/行号。`;

function parseJson(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first === -1 || last <= first) throw new Error('模型未返回 JSON 对象');
  return JSON.parse(raw.slice(first, last + 1));
}

function evidenceSet(knowledge) {
  const set = new Set();
  for (const file of knowledge.files || []) set.add(toPosix(file.path));
  for (const symbol of knowledge.symbols || []) set.add(toPosix(symbol.file));
  return set;
}

function validateEvidence(list, knowledge, fallback = []) {
  const known = evidenceSet(knowledge);
  const accepted = [];
  const rejected = [];
  for (const item of Array.isArray(list) ? list : []) {
    const file = typeof item?.file === 'string' ? toPosix(item.file) : '';
    const line = Number(item?.line);
    if (!file || !known.has(file) || !Number.isFinite(line) || line <= 0) {
      if (file) rejected.push(`${file}:${Number.isFinite(line) ? line : '?'}`);
      continue;
    }
    accepted.push({ file, line: Math.round(line) });
    if (accepted.length >= 8) break;
  }
  return { accepted: accepted.length ? accepted : fallback, rejected };
}

function hashOf(parts) {
  return sha1(JSON.stringify(parts), 16);
}

function moduleFilesHash(knowledge, module) {
  return (module.topFiles || []).map((file) => {
    const record = (knowledge.files || []).find((item) => item.path === file.path);
    return [file.path, record?.mtimeMs || 0, record?.size || 0];
  });
}

function cacheOf(knowledge) {
  knowledge.teaching = knowledge.teaching || { version: TEACHING_VERSION, modules: {}, functions: {} };
  if (knowledge.teaching.version !== TEACHING_VERSION) knowledge.teaching = { version: TEACHING_VERSION, modules: {}, functions: {} };
  knowledge.teaching.modules = knowledge.teaching.modules || {};
  knowledge.teaching.functions = knowledge.teaching.functions || {};
  return knowledge.teaching;
}

export function moduleFallback(knowledge, module, capabilities) {
  const narrative = moduleNarrative(knowledge, module, capabilities);
  const capability = narrative.capability;
  return {
    summary: narrative.summary,
    responsibility: narrative.responsibility,
    scenario: capability ? capability.trigger : '待核实：当前证据不足以确认具体使用场景。',
    inputs: narrative.inputs,
    outputs: narrative.outputs,
    failure: narrative.failure,
    confidence: narrative.confidence === 'unknown' ? 'unknown' : narrative.confidence,
    evidence: narrative.evidence?.length ? narrative.evidence.slice(0, 6) : narrative.startHere ? [{ ...narrative.startHere }] : [],
    source: 'fallback',
    note: '未使用模型：以下内容由真实证据与功能规则生成；业务解释仍需结合源码核对。',
  };
}

export async function moduleTeaching({ knowledge, module, capabilities, reviewer, level = 'beginner', readSnippet, capability: capabilityOverride, signal }) {
  const cache = cacheOf(knowledge);
  const fallback = moduleFallback(knowledge, module, capabilities);
  const capability = capabilityOverride || moduleNarrative(knowledge, module, capabilities).capability;
  if (capability) {
    fallback.summary = `${capability.title}：${capability.purpose}`;
    fallback.responsibility = `触发时机：${capability.trigger}。主要过程：${capability.process}。失败：${capability.failure}。`;
    fallback.scenario = capability.trigger;
    fallback.inputs = capability.input;
    fallback.outputs = capability.output;
    fallback.failure = capability.failure;
    fallback.confidence = capability.evidenceLevel === 'unknown' ? 'unknown' : capability.evidenceLevel;
    fallback.evidence = capability.sources?.length ? capability.sources : fallback.evidence;
  }
  if (!reviewer?.available?.()) return fallback;
  const modelKey = reviewer.modelKey?.() || '';
  const hash = hashOf([
    TEACHING_VERSION, knowledge.git?.commit || '', knowledge.git?.dirtyCount || 0,
    module.id, capability?.id || '-', level, modelKey, moduleFilesHash(knowledge, module),
  ]);
  const cacheKey = `${module.id}:${capability?.id || '-'}`;
  const cached = cache.modules[cacheKey];
  if (cached?.hash === hash && cached.value) return { ...cached.value, cached: true };

  const snippets = [];
  for (const source of (fallback.evidence || []).slice(0, 3)) {
    const snippet = await readSnippet?.(source.file, source.line, 8);
    if (snippet) snippets.push(`# ${source.file}\n${snippet}`);
  }
  const prompt = [
    `项目：${knowledge.name}${knowledge.git?.commit ? ` @ ${String(knowledge.git.commit).slice(0, 10)}` : ''}`,
    `模块/目录：${module.name}`,
    `功能名称（可能来自证据推断）：${capability?.title || '待确认'}`,
    `已确认能力：${capability ? `${capability.purpose} 触发：${capability.trigger} 输入：${capability.input} 输出：${capability.output}` : '无'}`,
    `真实证据：\n${(fallback.evidence || []).map((item) => `${item.file}:${item.line}${item.symbol ? ` (${item.symbol})` : ''}`).join('\n') || '无'}`,
    `相关源码（只读，不能执行）：\n${truncate(snippets.join('\n\n'), MAX_SNIPPET_CHARS)}`,
    `学习者水平：${level}`,
    '请只输出约定 JSON。',
  ].join('\n');
  const completion = await reviewer.complete({ system: MODULE_SYSTEM, prompt, signal, maxTokens: 2200 });
  if (!completion.ok) return { ...fallback, note: `模型讲解不可用：${completion.reason}` };
  let parsed;
  try {
    parsed = parseJson(completion.text);
  } catch (error) {
    return { ...fallback, note: `模型讲解 JSON 无效：${error.message}` };
  }
  const check = validateEvidence(parsed.evidence, knowledge, fallback.evidence || []);
  const value = {
    summary: truncate(String(parsed.summary || fallback.summary), 600),
    responsibility: truncate(String(parsed.responsibility || fallback.responsibility), 600),
    scenario: truncate(String(parsed.scenario || fallback.scenario), 500),
    inputs: truncate(String(parsed.inputs || fallback.inputs), 400),
    outputs: truncate(String(parsed.outputs || fallback.outputs), 400),
    failure: truncate(String(parsed.failure || fallback.failure), 500),
    confidence: ['verified', 'inferred', 'unknown'].includes(parsed.confidence) ? parsed.confidence : 'inferred',
    evidence: check.accepted,
    rejectedEvidence: check.rejected,
    source: 'model',
    model: completion.model,
    note: '由 Host 模型基于有限源码证据生成；业务含义仍需回源码核对。',
  };
  cache.modules[cacheKey] = { hash, value, generatedAt: nowIso(), model: modelKey };
  return value;
}

export function functionFallback(knowledge, symbol, context = {}) {
  const module = knowledge.modules.find((item) => item.id === symbol.module);
  const callers = (context.callers || []).slice(0, 5);
  const callees = (context.callees || []).slice(0, 5);
  return {
    oneLine: `${symbol.name} 是 ${module?.name || '项目'} 中的一个${symbol.kind === 'function' ? '函数' : '符号'}；它的具体业务作用需要结合调用方确认。`,
    when: callers.length ? `当前可见调用方：${callers.map((caller) => `${caller.name}（${caller.file}:${caller.line}）`).join('、')}。` : '未找到项目内调用方；可能由外部、中断或回调触发，待核实。',
    inputOutput: symbol.signature ? `签名：${symbol.signature}` : '签名缺少完整类型信息，待核实。',
    steps: callees.length ? callees.map((callee) => `调用 ${callee.name}（${callee.file}:${callee.line}）`) : ['未解析到项目内被调用方；需要阅读函数体确认步骤。'],
    failure: '待核实：未执行与异常分支分析。',
    sideEffects: '待核实：需要阅读函数体中的写入、外设或全局状态。',
    relation: context.capability ? `属于功能「${context.capability.title}」。` : '未映射到明确功能节点。',
    uncertainties: ['当前为保守回退解释，未使用模型语义分析。'],
    evidence: [{ file: symbol.file, line: symbol.line }],
    source: 'fallback',
    note: '未使用模型：只给出可从元数据确认的内容，不编造业务行为。',
  };
}

export async function explainFunction({ knowledge, symbol, context, reviewer, snippets, level = 'beginner', signal }) {
  const cache = cacheOf(knowledge);
  const fallback = functionFallback(knowledge, symbol, context);
  if (!reviewer?.available?.()) return fallback;
  const modelKey = reviewer.modelKey?.() || '';
  const record = (knowledge.files || []).find((file) => file.path === symbol.file);
  const hash = hashOf([
    TEACHING_VERSION, knowledge.git?.commit || '', knowledge.git?.dirtyCount || 0,
    symbol.id, level, modelKey, record?.mtimeMs || 0, record?.size || 0,
  ]);
  const cached = cache.functions[symbol.id];
  if (cached?.hash === hash && cached.value) return { ...cached.value, cached: true };
  const prompt = [
    `项目：${knowledge.name}`,
    `函数：${symbol.name}（${symbol.kind}）`,
    `位置：${symbol.file}:${symbol.line}-${symbol.endLine || symbol.line}`,
    `签名：${symbol.signature || '未知'}`,
    `所属模块：${knowledge.modules.find((item) => item.id === symbol.module)?.name || '未知'}`,
    `功能节点：${context?.capability?.title || '未映射'}`,
    `调用方：${(context?.callers || []).map((item) => `${item.name}@${item.file}:${item.line}`).join('、') || '未找到'}`,
    `被调用方：${(context?.callees || []).map((item) => `${item.name}@${item.file}:${item.callLine || item.line}`).join('、') || '未找到'}`,
    `源码片段（只读，不能执行）：\n${truncate(snippets || '', MAX_SNIPPET_CHARS)}`,
    `学习者水平：${level}`,
    '请只输出约定 JSON。',
  ].join('\n');
  const completion = await reviewer.complete({ system: FUNCTION_SYSTEM, prompt, signal, maxTokens: 2200 });
  if (!completion.ok) return { ...fallback, note: `函数解释不可用：${completion.reason}` };
  let parsed;
  try {
    parsed = parseJson(completion.text);
  } catch (error) {
    return { ...fallback, note: `函数解释 JSON 无效：${error.message}` };
  }
  const check = validateEvidence(parsed.evidence, knowledge, fallback.evidence);
  const strings = (list, limit = 6) => (Array.isArray(list) ? list.filter((item) => typeof item === 'string' && item.trim()).map((item) => truncate(item, 500)).slice(0, limit) : []);
  const value = {
    oneLine: truncate(String(parsed.oneLine || fallback.oneLine), 600),
    when: truncate(String(parsed.when || fallback.when), 600),
    inputOutput: truncate(String(parsed.inputOutput || fallback.inputOutput), 700),
    steps: strings(parsed.steps, 6),
    failure: truncate(String(parsed.failure || fallback.failure), 600),
    sideEffects: truncate(String(parsed.sideEffects || fallback.sideEffects), 600),
    relation: truncate(String(parsed.relation || fallback.relation), 400),
    uncertainties: strings(parsed.uncertainties, 6),
    evidence: check.accepted,
    rejectedEvidence: check.rejected,
    source: 'model',
    model: completion.model,
    note: '由 Host 模型基于有限源码片段生成；关键行为仍应以源码为准。',
  };
  cache.functions[symbol.id] = { hash, value, generatedAt: nowIso(), model: modelKey };
  return value;
}

export function teachingStatus(knowledge) {
  const cache = cacheOf(knowledge);
  return {
    version: TEACHING_VERSION,
    modules: Object.keys(cache.modules).length,
    functions: Object.keys(cache.functions).length,
    note: '模型讲解按需生成并缓存；源码/Commit/模型变化后失效。',
  };
}
