/**
 * Interview mentor: source-grounded question bank, one-question-at-a-time
 * sessions, deterministic rubric grading, progressive follow-ups and weak-point
 * tracking.
 *
 * Grading is a keyword/coverage rubric, not an LLM judgement. Its output says so
 * and lists what was missing, so the learner can verify the correction against
 * the cited source instead of trusting a bare score.
 */

import { clamp, nowIso, oneLine, round, truncate, uniqueBy } from './core.js';

const DIMENSIONS = {
  principle: '原理准确性',
  source: '源码理解程度',
  design: '工程设计能力',
  clarity: '表达清晰程度',
};

const DIFFICULTY_LABELS = { junior: '初级', mid: '中级', senior: '高级' };

function fact(text, evidence, keywords) {
  return { text, evidence: evidence || [], keywords: keywords || [] };
}

function baseKeywords(...groups) {
  return uniqueBy(groups.flat().filter(Boolean).map(String), (item) => item.toLowerCase());
}

function evidenceOf(file, line, symbol = '') {
  return { file, line, symbol };
}

function chainFacts(chain) {
  const facts = [];
  const steps = chain.primary || chain.steps || [];
  for (const step of steps) {
    facts.push(fact(
      `${step.from} 在 ${step.fromFile}:${step.line} 调用 ${step.to}（${step.toFile}）`,
      [evidenceOf(step.file, step.line, step.to)],
      baseKeywords(step.from, step.to),
    ));
  }
  if (!steps.length) return facts;
  const last = steps[steps.length - 1];
  facts.push(fact(
    `主链路的终点是 ${last.to}，完整链路共 ${steps.length} 步，每一步都有源码行号。`,
    [evidenceOf(last.file, last.line, last.to)],
    baseKeywords(last.to, '源码', '行号'),
  ));
  return facts;
}

function architectureFacts(knowledge) {
  const modules = knowledge.modules.filter((module) => !module.vendored).slice(0, 5);
  return modules.map((module) => fact(
    `模块 ${module.name} 有 ${module.files} 个文件、${module.symbols} 个符号，依赖 ${module.deps.length} 个模块、被 ${module.dependents.length} 个模块依赖。`,
    module.evidence,
    baseKeywords(module.name, ...module.topFiles.slice(0, 2).map((file) => file.path.split('/').pop())),
  )).concat([
    fact(
      '依赖方向由源码中的 #include/import 语句确定；头文件集中声明接口，实现文件提供符号定义。',
      modules[0]?.evidence || [],
      ['include', 'import', '头文件', '接口', '依赖'],
    ),
  ]);
}

function structureFacts(structure) {
  if (!structure) return [];
  const fields = (structure.fields || []).slice(0, 6).map((field) => field.name);
  const lifecycle = structure.lifecycle || {};
  const facts = [
    fact(
      `${structure.name} 定义在 ${structure.file}:${structure.line}，包含 ${structure.fields?.length || 0} 个字段：${fields.join('、') || '无显式字段'}。`,
      [evidenceOf(structure.file, structure.line, structure.name)],
      baseKeywords(structure.name, ...fields),
    ),
  ];
  if (lifecycle.statics?.length) {
    facts.push(fact(
      `该结构存在静态/全局实例，例如 ${lifecycle.statics[0].file}:${lifecycle.statics[0].line} 的 ${lifecycle.statics[0].variable}。`,
      [evidenceOf(lifecycle.statics[0].file, lifecycle.statics[0].line, lifecycle.statics[0].variable)],
      ['静态', '全局', lifecycle.statics[0].variable],
    ));
  }
  for (const declaration of (lifecycle.declarations || []).slice(0, 2)) {
    facts.push(fact(
      `${declaration.variable} 在 ${declaration.file}:${declaration.line} 以 ${structure.name} 类型声明。`,
      [evidenceOf(declaration.file, declaration.line, declaration.variable)],
      baseKeywords(declaration.variable, '声明', '生命周期'),
    ));
  }
  if (lifecycle.releases?.length) {
    facts.push(fact(
      `在 ${lifecycle.releases[0].file}:${lifecycle.releases[0].line} 能看到释放动作（${lifecycle.releases[0].variable}）。`,
      [evidenceOf(lifecycle.releases[0].file, lifecycle.releases[0].line, lifecycle.releases[0].variable)],
      ['释放', 'free', 'delete'],
    ));
  }
  if (!lifecycle.declarations?.length && !lifecycle.statics?.length) {
    facts.push(fact(
      '当前扫描没有找到该结构的实例化位置，因此生命周期属于待验证信息。',
      [],
      ['待验证', '未找到', '生命周期'],
    ));
  }
  return facts;
}

function concurrencyFacts(knowledge) {
  const facts = [];
  const isrs = (knowledge.concurrency?.isrs || []).slice(0, 3);
  for (const isr of isrs) {
    facts.push(fact(
      `${isr.name} 定义在 ${isr.file}:${isr.line}，属于中断上下文。`,
      [evidenceOf(isr.file, isr.line, isr.name)],
      baseKeywords(isr.name, '中断', 'ISR'),
    ));
  }
  const locks = (knowledge.concurrency?.primitives || []).filter((item) => item.kind === 'lock').slice(0, 3);
  for (const lock of locks) {
    facts.push(fact(
      `在 ${lock.file}:${lock.line} 使用了 ${lock.name} 相关原语。`,
      [evidenceOf(lock.file, lock.line, lock.name)],
      baseKeywords(lock.name, '临界区', '并发'),
    ));
  }
  facts.push(fact(
    `扫描到的并发模型是 ${knowledge.concurrency?.model || 'unknown'}；中断与主循环之间的共享数据需要显式同步。`,
    knowledge.concurrency?.evidence || [],
    ['并发', '中断', '共享', 'volatile', '临界区'],
  ));
  return facts;
}

function performanceFacts(knowledge) {
  const callIn = new Map();
  for (const symbol of knowledge.symbols) {
    for (const call of symbol.calls || []) callIn.set(call.name, (callIn.get(call.name) || 0) + 1);
  }
  const hot = [...callIn.entries()].sort((left, right) => right[1] - left[1]).slice(0, 3);
  const facts = hot.map(([name, count]) => {
    const definition = knowledge.symbols.find((symbol) => symbol.name === name);
    return fact(
      `${name} 被调用 ${count} 次${definition ? `，定义在 ${definition.file}:${definition.line}（约 ${definition.loc} 行）` : ''}。`,
      definition ? [evidenceOf(definition.file, definition.line, name)] : [],
      baseKeywords(name, '调用', '热点'),
    );
  });
  const risky = knowledge.risks.find((risk) => risk.kind === 'complexity');
  if (risky) facts.push(fact(risky.text, risky.evidence, ['复杂度', '行数', '拆分']));
  return facts;
}

function errorFacts(knowledge) {
  const ignored = knowledge.risks.find((risk) => risk.kind === 'error-handling');
  const facts = [];
  if (ignored) {
    facts.push(fact(ignored.text, ignored.evidence, ['返回值', '失败', '错误处理']));
    for (const evidence of ignored.evidence.slice(0, 2)) {
      facts.push(fact(
        `${evidence.file}:${evidence.line} 附近的调用忽略了返回值（${evidence.symbol}）。`,
        [evidence],
        baseKeywords(evidence.symbol, '忽略', '返回值'),
      ));
    }
  } else {
    facts.push(fact('扫描没有发现明显的忽略返回值模式；仍需检查所有外部调用的失败分支。', [], ['返回值', '失败']));
  }
  return facts;
}

function safeKeywords(values) {
  return uniqueBy(values.filter(Boolean).map((value) => String(value)).filter((value) => value.length >= 2), (value) => value.toLowerCase());
}

/* --------------------------------------------------------------- question bank */

export function buildQuestionBank(knowledge) {
  const questions = [];
  const add = (question) => {
    if (!question.prompt) return;
    questions.push({ ...question, id: question.id || `q${questions.length + 1}` });
  };

  /* 1. architecture */
  {
    const facts = architectureFacts(knowledge);
    const modules = knowledge.modules.filter((module) => !module.vendored).slice(0, 3);
    add({
      dimension: 'architecture',
      difficulty: 'junior',
      prompt: `先用一句话说明这个项目解决什么问题，然后说明它如何分层：${modules.map((module) => module.name).join('、') || '主要模块'} 各自负责什么，依赖方向是什么？`,
      context: { modules: modules.map((module) => module.name) },
      expectedFacts: facts,
      rubric: facts.map((item, index) => ({
        id: `arch-${index}`,
        label: item.text,
        dimension: index >= facts.length - 1 ? 'design' : 'source',
        keywords: item.keywords,
        weight: index === facts.length - 1 ? 0.5 : 1,
      })),
      followups: [
        {
          prompt: '如果让你新增一个跨模块功能，你会把代码放在哪个模块？为什么？',
          keywords: safeKeywords(['模块', '依赖', ...modules.map((module) => module.name)]),
          evidence: modules.flatMap((module) => module.evidence).slice(0, 3),
        },
        {
          prompt: '这些模块里，哪一个最适合先读？请给出判断依据而不是直觉。',
          keywords: safeKeywords(['重要度', '依赖', '被依赖', '入口', modules[0]?.name]),
          evidence: modules[0]?.evidence || [],
        },
      ],
      recommended: {
        concise: `这个项目主要由 ${modules.map((module) => `${module.name}（${module.files} 个文件）`).join('、')} 组成。${modules[0] ? `${modules[0].name} 是入口与集成层，${modules[0].deps.length} 条依赖指向下层模块。` : ''}依赖方向以源码 include/import 为准，详见证据行。`,
        deep: `分层上：${modules.map((module) => `${module.name} 依赖 ${module.deps.length} 个模块、被 ${module.dependents.length} 个模块依赖`).join('；')}。这样划分的收益是接口与实现分离，代价是跨模块修改需要同时回归调用方。`,
      },
      evidence: modules.flatMap((module) => module.evidence).slice(0, 6),
    });
  }

  /* 2. call chain */
  const chain = knowledge.analysis?.chain;
  if (chain?.steps?.length) {
    const facts = chainFacts(chain);
    const target = chain.steps[chain.steps.length - 1]?.to || '目标函数';
    add({
      dimension: 'mechanism',
      difficulty: 'mid',
      prompt: `请从入口 ${chain.steps[0].from} 出发，说明到 ${target} 的完整调用链：每一步在哪个文件触发、完成什么动作、失败时如何返回？`,
      context: { chainId: chain.id, steps: chain.steps.length },
      expectedFacts: facts,
      rubric: facts.map((item, index) => ({
        id: `chain-${index}`,
        label: item.text,
        dimension: 'source',
        keywords: item.keywords,
        weight: 1,
      })),
      followups: [
        {
          prompt: `如果 ${target} 执行失败，调用链上的上层如何感知并处理？请指出具体返回路径。`,
          keywords: safeKeywords(['返回', '错误', '失败', target, '调用方']),
          evidence: chain.evidence || [],
        },
        {
          prompt: '这条链路上哪些参数来自外部输入？在哪一层做了校验？',
          keywords: safeKeywords(['参数', '校验', '输入', '边界', target]),
          evidence: chain.evidence || [],
        },
        {
          prompt: '如果要在这条链路上增加超时或重试，你会改哪一层？为什么放在那里？',
          keywords: safeKeywords(['超时', '重试', '层', '幂等', '重复']),
          evidence: chain.evidence || [],
        },
      ],
      recommended: {
        concise: `链路：${chain.steps.map((step) => `${step.from}→${step.to}（${step.fromFile}:${step.line}）`).join('；')}。每一步都有源码行号，${target} 是链路终点。`,
        deep: `${chain.steps.map((step, index) => `${index + 1}. ${step.from} 在 ${step.file}:${step.line} 调用 ${step.to}。`).join(' ')} 失败处理需要沿着返回路径逐层确认；链路上未被扫描到的外部调用不能假设其行为。`,
      },
      evidence: chain.evidence || [],
    });
  }

  /* 3. data structure */
  const structure = knowledge.coreStructures?.[0];
  if (structure) {
    const facts = structureFacts(structure);
    add({
      dimension: 'data-structure',
      difficulty: 'mid',
      prompt: `关键数据结构 ${structure.name} 的字段有哪些？它在哪里被创建、持有和释放？如果释放路径不明确，你会如何验证？`,
      context: { structure: structure.name, file: structure.file },
      expectedFacts: facts,
      rubric: facts.map((item, index) => ({
        id: `data-${index}`,
        label: item.text,
        dimension: index === facts.length - 1 ? 'design' : 'source',
        keywords: item.keywords,
        weight: 1,
      })),
      followups: [
        {
          prompt: `如果 ${structure.name} 的某个字段被并发读写，会出现什么问题？当前代码靠什么保证一致性？`,
          keywords: safeKeywords(['并发', '一致性', '锁', 'volatile', '临界区', structure.name]),
          evidence: knowledge.concurrency?.evidence || [],
        },
        {
          prompt: `新增一个字段时，需要同步修改哪些地方？为什么容易漏？`,
          keywords: safeKeywords(['初始化', 'memset', '初始化函数', '序列化', '测试', structure.name]),
          evidence: [evidenceOf(structure.file, structure.line, structure.name)],
        },
      ],
      recommended: {
        concise: `${structure.name} 定义在 ${structure.file}:${structure.line}，有 ${structure.fields?.length || 0} 个字段。生命周期判定：${structure.lifecycle.verdict}。`,
        deep: `字段：${(structure.fields || []).map((field) => `${field.name}(${field.type})`).join('、') || '无'}。实例证据：${(structure.lifecycle.declarations || []).slice(0, 3).map((item) => `${item.file}:${item.line}`).join('、') || '未找到'}；释放证据：${(structure.lifecycle.releases || []).map((item) => `${item.file}:${item.line}`).join('、') || '未找到'}。`,
      },
      evidence: structure.evidence.slice(0, 5),
    });
  }

  /* 4. concurrency */
  if ((knowledge.concurrency?.isrs || []).length) {
    const facts = concurrencyFacts(knowledge);
    const isr = knowledge.concurrency.isrs[0];
    add({
      dimension: 'concurrency',
      difficulty: 'senior',
      prompt: `以 ${isr.name}（${isr.file}:${isr.line}）为例：中断上下文和主循环之间共享了哪些状态？当前代码如何避免竞态？如果共享变量没有 volatile 或临界区保护，会发生什么？`,
      context: { isr: isr.name, model: knowledge.concurrency.model },
      expectedFacts: facts,
      rubric: facts.map((item, index) => ({
        id: `conc-${index}`,
        label: item.text,
        dimension: index === facts.length - 1 ? 'principle' : 'source',
        keywords: item.keywords,
        weight: 1,
      })),
      followups: [
        {
          prompt: '为什么 ISR 里不应该做阻塞操作或长时间计算？当前 ISR 有没有把工作延迟到主循环？',
          keywords: safeKeywords(['阻塞', '延迟', '标志位', '队列', '主循环', 'ISR']),
          evidence: [evidenceOf(isr.file, isr.line, isr.name)],
        },
        {
          prompt: '如果中断频率高于主循环处理速度，会发生什么？当前代码如何应对积压或丢数据？',
          keywords: safeKeywords(['积压', '丢数据', '覆盖', '背压', '频率']),
          evidence: knowledge.concurrency?.evidence || [],
        },
        {
          prompt: '你会如何验证这个并发路径是正确的？需要什么测试或观测手段？',
          keywords: safeKeywords(['测试', '观测', '逻辑分析仪', '断言', '压力']),
          evidence: [],
        },
      ],
      recommended: {
        concise: `${isr.name} 位于 ${isr.file}:${isr.line}。当前并发模型是 ${knowledge.concurrency.model}；共享状态的保护点需要沿 ISR 与主循环两侧逐一核对。`,
        deep: `中断侧：${knowledge.concurrency.isrs.slice(0, 3).map((item) => `${item.name}@${item.file}:${item.line}`).join('、')}。锁/临界区证据：${(knowledge.concurrency.primitives || []).filter((item) => item.kind === 'lock').slice(0, 3).map((item) => `${item.name}@${item.file}:${item.line}`).join('、') || '未发现显式原语'}。没有源码证据时，不能假设同步已经正确。`,
      },
      evidence: knowledge.concurrency.evidence,
    });
  }

  /* 5. performance */
  {
    const facts = performanceFacts(knowledge);
    if (facts.length) {
      add({
        dimension: 'performance',
        difficulty: 'senior',
        prompt: '这个项目里哪些函数是调用热点？它们的复杂度或调用频率会带来什么风险？你会用哪些证据判断优化是否值得？',
        context: { risks: knowledge.risks.filter((risk) => risk.kind === 'complexity').length },
        expectedFacts: facts,
        rubric: facts.map((item, index) => ({
          id: `perf-${index}`,
          label: item.text,
          dimension: index === facts.length - 1 ? 'design' : 'source',
          keywords: item.keywords,
          weight: 1,
        })),
        followups: [
          {
            prompt: '在嵌入式环境下，优化调用热点时你会优先看 CPU、内存还是实时性？为什么？',
            keywords: safeKeywords(['CPU', '内存', '实时性', '优先级', '中断延迟']),
            evidence: [],
          },
          {
            prompt: '你如何证明优化没有引入回归？请给出可执行的验证步骤。',
            keywords: safeKeywords(['测试', '基准', '构建', '回归', '测量']),
            evidence: [],
          },
        ],
        recommended: {
          concise: `${facts[0].text}优化前先用调用次数、worst-case 执行时间和内存占用建立基线，再决定是否值得改。`,
          deep: '热点函数的风险来自调用频率 × 单次开销。项目里能用源码确认的是调用点数量、函数规模和分支数量；真实耗时必须通过测量获得，不能从源码推断。',
        },
        evidence: facts.flatMap((item) => item.evidence).slice(0, 5),
      });
    }
  }

  /* 6. error handling */
  {
    const facts = errorFacts(knowledge);
    add({
      dimension: 'resilience',
      difficulty: 'mid',
      prompt: '请举出一个真实的失败路径：某个外部调用失败后，当前代码会怎样？如果让你修复，你会改哪一行、如何验证？',
      context: { ignoredReturns: knowledge.risks.find((risk) => risk.kind === 'error-handling') ? 'detected' : 'not-detected' },
      expectedFacts: facts,
      rubric: facts.map((item, index) => ({
        id: `err-${index}`,
        label: item.text,
        dimension: index === 0 ? 'source' : 'design',
        keywords: item.keywords,
        weight: 1,
      })),
      followups: [
        {
          prompt: '失败重试和快速失败，你会怎么选？当前项目适合哪一种？',
          keywords: safeKeywords(['重试', '快速失败', '幂等', '超时', '错误码']),
          evidence: [],
        },
        {
          prompt: '你如何在不引入新缺陷的前提下验证这个失败分支？',
          keywords: safeKeywords(['注入', '模拟', '测试', '断言', '日志']),
          evidence: [],
        },
      ],
      recommended: {
        concise: '先定位被忽略的返回值，再按调用方约定补齐错误返回或日志；验证时至少覆盖成功、失败和一个边界输入。',
        deep: '源码里能看到的是调用点，失败语义需要结合调用方确认。修复后必须实际执行可用的构建/测试命令；没有执行的验证不能算通过。',
      },
      evidence: facts.flatMap((item) => item.evidence).slice(0, 5),
    });
  }

  /* 7. design tradeoff */
  add({
    dimension: 'design',
    difficulty: 'senior',
    prompt: `如果要把这个项目移植到另一个平台，哪些模块必须重写、哪些可以复用？请用真实模块边界说明你的判断。`,
    context: { model: knowledge.concurrency.model },
    expectedFacts: [
      fact('硬件相关代码集中在驱动/启动层，业务逻辑与协议层更可能复用。', knowledge.modules.filter((module) => module.vendored).slice(0, 1).flatMap((module) => module.evidence), ['驱动', '启动', '业务', '复用']),
      fact('移植风险集中在时钟、外设初始化和中断向量，而算法与状态机通常可以保留。', knowledge.modules.filter((module) => !module.vendored).slice(0, 1).flatMap((module) => module.evidence), ['时钟', '外设', '中断', '算法']),
    ],
    rubric: [
      { id: 'design-1', label: '区分硬件相关与业务相关模块', dimension: 'design', keywords: safeKeywords(['驱动', '硬件', '业务', '模块', '复用']), weight: 1 },
      { id: 'design-2', label: '指出移植风险点', dimension: 'principle', keywords: safeKeywords(['时钟', '外设', '中断', '启动', '寄存器']), weight: 1 },
    ],
    followups: [
      {
        prompt: '如果新平台没有当前使用的中断控制器，你会怎么抽象这层差异？',
        keywords: safeKeywords(['抽象', '接口', '适配', '中断', 'HAL']),
        evidence: [],
      },
    ],
    recommended: {
      concise: '按“硬件相关 / 与硬件无关”切分：驱动与启动代码重写，业务与协议层尽量复用；风险最高的是时钟、外设初始化和中断。',
      deep: '从模块依赖图看，业务模块通过驱动接口访问硬件。移植时应保持接口稳定、替换实现；所有依赖寄存器和工具链的代码都需要重新验证。',
    },
    evidence: knowledge.modules.filter((module) => !module.vendored).slice(0, 2).flatMap((module) => module.evidence),
  });

  /* 8. modification scenario */
  const risk = knowledge.risks.find((item) => item.kind === 'error-handling') || knowledge.risks.find((item) => item.kind === 'memory-safety');
  if (risk?.evidence?.length) {
    const target = risk.evidence[0];
    add({
      dimension: 'modification',
      difficulty: 'mid',
      prompt: `现在要修改 ${target.file}:${target.line} 附近的代码（${target.symbol}）：请说明修改前必须确认哪些不变量、改动范围、潜在破坏性和验证方案。`,
      context: { risk: risk.kind },
      expectedFacts: [
        fact(`目标位置是 ${target.file}:${target.line}，属于 ${risk.kind} 风险。`, [target], ['不变量', '范围', '回归']),
        fact('修改前必须确认调用方期望、失败语义和测试入口。', [], ['调用方', '失败', '测试']),
      ],
      rubric: [
        { id: 'mod-1', label: '说明预期行为与当前行为', dimension: 'design', keywords: safeKeywords(['预期', '当前', '行为', '失败']), weight: 1 },
        { id: 'mod-2', label: '说明修改范围与依赖', dimension: 'design', keywords: safeKeywords(['范围', '依赖', '调用方', '影响']), weight: 1 },
        { id: 'mod-3', label: '给出可执行验证方案', dimension: 'design', keywords: safeKeywords(['构建', '测试', '回归', 'git diff', '验证']), weight: 1 },
      ],
      followups: [
        {
          prompt: '如果修改后构建通过但功能仍然错误，你的下一步排查顺序是什么？',
          keywords: safeKeywords(['日志', '断点', '复现', '二分', '输入']),
          evidence: [],
        },
      ],
      recommended: {
        concise: '先写清预期/当前行为，再限定改动范围，最后用构建、测试和 diff 三步验证；不要因为构建通过就宣称功能正确。',
        deep: `目标 ${target.file}:${target.line}。修改前列出调用方与不变量，修改后执行可用的构建/测试命令，并检查 diff 是否只包含预期改动。未覆盖的风险要显式列出。`,
      },
      evidence: [target],
    });
  }

  const unique = uniqueBy(questions, (question) => `${question.dimension}:${question.prompt}`);
  return {
    version: 1,
    generatedAt: nowIso(),
    questions: unique,
    note: '题库由当前源码证据生成；评分使用关键词覆盖规则，不是 LLM 主观打分。',
  };
}

/* ------------------------------------------------------------------- grading */

function normalize(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ');
}

function hit(keyword, answer) {
  const needle = normalize(keyword);
  if (!needle) return false;
  return answer.includes(needle);
}

export function gradeAnswer(question, answer, options = {}) {
  const text = normalize(answer);
  const rubric = Array.isArray(options.rubric) ? options.rubric : question.rubric || [];
  const matched = [];
  const missing = [];
  const byDimension = new Map();
  for (const item of rubric) {
    const keywords = Array.isArray(item.keywords) ? item.keywords : [];
    const ok = keywords.length ? keywords.some((keyword) => hit(keyword, text)) : String(answer || '').length > 0;
    const dimension = item.dimension || 'principle';
    const entry = byDimension.get(dimension) || { dimension, label: DIMENSIONS[dimension] || dimension, weight: 0, hit: 0, matched: [], missing: [] };
    entry.weight += item.weight || 1;
    if (ok) {
      entry.hit += item.weight || 1;
      entry.matched.push(item.label);
      matched.push(item.label);
    } else {
      entry.missing.push(item.label);
      missing.push(item.label);
    }
    byDimension.set(dimension, entry);
  }

  const length = String(answer || '').trim().length;
  const structureMarkers = ['首先', '其次', '然后', '最后', '因为', '所以', '第一', '第二', '一方面', '另一方面', '1.', '2.', '1、', '2、', '-'];
  const markerCount = structureMarkers.filter((marker) => String(answer || '').includes(marker)).length;
  const clarityScore = clamp(
    (length >= 60 ? 0.35 : length / 180)
    + clamp(markerCount / 4, 0, 0.35)
    + (length <= 2000 ? 0.2 : 0.1),
    0, 1,
  );

  const dimensions = {};
  for (const [dimension, entry] of byDimension.entries()) {
    dimensions[dimension] = {
      dimension,
      label: entry.label,
      score: entry.weight ? round(entry.hit / entry.weight, 2) : 0,
      matched: entry.matched,
      missing: entry.missing,
    };
  }
  dimensions.clarity = {
    dimension: 'clarity',
    label: DIMENSIONS.clarity,
    score: round(clarityScore, 2),
    matched: [length >= 60 ? '回答长度足够展开' : '回答偏短', markerCount > 0 ? '有结构标记' : '缺少结构标记'],
    missing: length < 60 ? ['回答过短，面试中通常需要展开到 1-2 分钟'] : [],
  };

  const core = Object.values(dimensions).filter((entry) => entry.dimension !== 'clarity');
  const weightSum = core.reduce((sum, entry) => sum + (entry.weight || 1), 0);
  const coreScore = core.length
    ? core.reduce((sum, entry) => sum + entry.score * (entry.weight || 1), 0) / weightSum
    : 0;
  const overall = round(coreScore * 0.85 + clarityScore * 0.15, 3);
  const verdict = overall >= 0.72 ? 'strong' : overall >= 0.42 ? 'partial' : 'weak';
  const cited = [...String(answer || '').matchAll(/[\w./-]+:\d+/g)].map((match) => match[0]);
  const knownFiles = new Set((question.evidence || []).map((item) => item.file));
  const unverifiedCitations = cited.filter((citation) => {
    const file = citation.replace(/:\d+$/, '');
    return !knownFiles.has(file) && ![...knownFiles].some((candidate) => candidate.endsWith(file));
  });

  return {
    overall,
    verdict,
    dimensions: Object.values(dimensions),
    matched: uniqueBy(matched, (item) => item),
    missing: uniqueBy(missing, (item) => item),
    unverifiedCitations: unverifiedCitations.slice(0, 5),
    feedback: buildFeedback(verdict, dimensions, missing),
    method: 'keyword-coverage',
    caveat: '评分来自关键词覆盖与表达结构启发式；它不能证明技术判断一定正确，请以证据行核对。',
  };
}

function buildFeedback(verdict, dimensions, missing) {
  const sorted = Object.values(dimensions).sort((left, right) => left.score - right.score);
  const weakest = sorted[0];
  if (verdict === 'strong') {
    return `回答覆盖了大部分关键事实${weakest && weakest.score < 0.6 ? `；最薄弱的是「${weakest.label}」` : ''}。下一步可以补充边界条件和失败路径。`;
  }
  if (verdict === 'partial') {
    return `回答方向正确，但遗漏了「${weakest?.label || '部分关键点'}」。请补齐：${missing.slice(0, 3).join('；') || '证据行与设计取舍'}。`;
  }
  return `回答还没有覆盖关键事实。先给出结论，再用源码位置和失败路径支撑；需要补充：${missing.slice(0, 4).join('；') || '项目中的真实模块与调用链'}。`;
}

/* ------------------------------------------------------------------ sessions */

export function ensureBank(knowledge) {
  knowledge.interview = knowledge.interview || { bank: null, sessions: [], weakPoints: [] };
  const bank = knowledge.interview.bank;
  const baseline = knowledge.scan?.generatedAt || knowledge.generatedAt || '';
  if (!bank || bank.version !== 1 || String(bank.generatedAt) < String(baseline)) {
    knowledge.interview.bank = buildQuestionBank(knowledge);
  }
  return knowledge.interview.bank;
}

function activeSession(knowledge) {
  const sessions = knowledge.interview?.sessions || [];
  return [...sessions].reverse().find((session) => session.active) || null;
}

function questionById(bank, id) {
  for (const question of bank.questions) {
    if (question.id === id) return { question, followup: null, followupIndex: -1 };
    for (let index = 0; index < (question.followups || []).length; index += 1) {
      if (`${question.id}:f${index}` === id) {
        const followup = question.followups[index];
        return {
          question,
          followup,
          followupIndex: index,
          rubric: [{
            id: `${question.id}-f${index}`,
            label: followup.prompt,
            dimension: 'principle',
            keywords: followup.keywords || [],
            weight: 1,
          }],
        };
      }
    }
  }
  return null;
}

export function startSession(knowledge, options = {}) {
  const bank = ensureBank(knowledge);
  const difficulty = ['junior', 'mid', 'senior'].includes(options.difficulty) ? options.difficulty : 'mid';
  const focus = typeof options.focus === 'string' ? options.focus.trim() : '';
  const limit = clamp(Number(options.maxQuestions) || 6, 1, 12);
  let pool = bank.questions;
  if (focus) {
    const needle = focus.toLowerCase();
    const filtered = pool.filter((question) => question.dimension.toLowerCase().includes(needle)
      || question.prompt.toLowerCase().includes(needle));
    if (filtered.length) pool = filtered;
  }
  if (difficulty === 'junior') pool = pool.filter((question) => question.difficulty !== 'senior');
  if (difficulty === 'mid') pool = pool.filter((question) => question.difficulty !== 'junior' || pool.length < 4);
  if (!pool.length) pool = bank.questions;

  knowledge.interview.sessions = (knowledge.interview.sessions || []).map((session) => ({ ...session, active: false }));
  const session = {
    id: `session-${Date.now().toString(36)}`,
    startedAt: nowIso(),
    focus,
    difficulty,
    maxQuestions: limit,
    index: 0,
    followupDepth: 0,
    attempts: 0,
    active: true,
    pool: pool.map((question) => question.id),
    history: [],
  };
  knowledge.interview.sessions.push(session);
  knowledge.interview.current = { sessionId: session.id, questionId: currentId(bank, session) };
  const current = currentQuestion(knowledge);
  return {
    session: { id: session.id, difficulty, difficultyLabel: DIFFICULTY_LABELS[difficulty], focus, maxQuestions: limit, total: pool.length },
    question: current,
  };
}

function currentId(bank, session) {
  const question = bank.questions.find((item) => item.id === session.pool[session.index]);
  if (!question) return null;
  if (session.followupDepth > 0) {
    const followup = question.followups?.[session.followupDepth - 1];
    return followup ? `${question.id}:f${session.followupDepth - 1}` : question.id;
  }
  return question.id;
}

export function currentQuestion(knowledge) {
  const bank = ensureBank(knowledge);
  const session = activeSession(knowledge);
  if (!session) return { ok: false, reason: '当前没有进行中的面试会话；先执行 action=start。' };
  const id = currentId(bank, session);
  const found = id ? questionById(bank, id) : null;
  if (!found) return { ok: false, reason: '当前问题不存在（题库可能已重新生成），请重新 start。' };
  const isFollowup = Boolean(found.followup);
  const prompt = isFollowup ? found.followup.prompt : found.question.prompt;
  return {
    ok: true,
    sessionId: session.id,
    questionId: found.followup ? `${found.question.id}:f${found.followupIndex}` : found.question.id,
    kind: isFollowup ? 'followup' : 'base',
    followupIndex: found.followupIndex,
    dimension: found.question.dimension,
    difficulty: found.question.difficulty,
    prompt,
    hints: isFollowup
      ? ['从当前源码证据出发，先给出结论，再说明失败路径。']
      : [
        '先给结论，再给源码位置，最后说明设计取舍。',
        '不要编造未在项目中看到的模块或函数；不确定的地方明确说“待验证”。',
      ],
    progress: {
      index: session.index + 1,
      total: session.pool.length,
      answered: session.history.length,
      followupDepth: session.followupDepth,
    },
  };
}

export function getReport(knowledge) {
  const bank = ensureBank(knowledge);
  const session = activeSession(knowledge) || [...(knowledge.interview.sessions || [])].reverse()[0] || null;
  if (!session) return { ok: false, reason: '还没有面试记录。' };
  const history = session.history || [];
  const byDimension = new Map();
  for (const entry of history) {
    const dimension = entry.dimension || 'unknown';
    const bucket = byDimension.get(dimension) || { dimension, label: entry.dimensionLabel || dimension, scores: [], attempts: 0 };
    bucket.scores.push(entry.overall);
    bucket.attempts += 1;
    byDimension.set(dimension, bucket);
  }
  const dimensions = [...byDimension.values()].map((bucket) => ({
    dimension: bucket.dimension,
    label: bucket.label,
    attempts: bucket.attempts,
    average: round(bucket.scores.reduce((sum, value) => sum + value, 0) / bucket.scores.length, 2),
  })).sort((left, right) => left.average - right.average);

  const weakPoints = (knowledge.interview.weakPoints || []).slice(-12).reverse();
  return {
    ok: true,
    session: {
      id: session.id,
      startedAt: session.startedAt,
      active: session.active,
      asked: session.index + 1,
      total: session.pool.length,
      maxQuestions: session.maxQuestions,
      answered: history.length,
      difficulty: session.difficulty,
    },
    dimensions,
    weakest: dimensions[0] || null,
    weakPoints,
    recent: history.slice(-6).map((entry) => ({
      questionId: entry.questionId,
      prompt: truncate(entry.prompt, 160),
      overall: entry.overall,
      verdict: entry.verdict,
      at: entry.at,
    })),
    recommendation: dimensions.length
      ? `下一轮优先补「${dimensions[0].label}」：再练 2 道该维度题目，并把回答落到源码行号上。`
      : '先完成至少一道题，才能给出薄弱点建议。',
  };
}

export function submitAnswer(knowledge, input = {}) {
  const bank = ensureBank(knowledge);
  const session = activeSession(knowledge);
  if (!session) return { ok: false, reason: '当前没有进行中的面试会话；先执行 action=start。' };
  const answer = String(input.answer || '').trim();
  if (!answer) return { ok: false, reason: 'answer 不能为空。' };
  const id = input.questionId || currentId(bank, session);
  const found = questionById(bank, id);
  if (!found) return { ok: false, reason: `未知题目：${id}` };
  if (id !== currentId(bank, session)) {
    return { ok: false, reason: `当前问题是 ${currentId(bank, session)}；请先回答当前问题。` };
  }

  const question = found.question;
  const prompt = found.followup ? found.followup.prompt : question.prompt;
  const rubric = found.followup
    ? [{ id: `${question.id}-f${found.followupIndex}`, label: found.followup.prompt, dimension: 'principle', keywords: found.followup.keywords || [], weight: 1 }]
    : question.rubric;
  const grading = gradeAnswer(question, answer, { rubric });

  const historyEntry = {
    questionId: id,
    prompt,
    kind: found.followup ? 'followup' : 'base',
    dimension: question.dimension,
    dimensionLabel: DIMENSIONS[question.dimension] || question.dimension,
    answer: truncate(answer, 4000),
    overall: grading.overall,
    verdict: grading.verdict,
    missing: grading.missing,
    at: nowIso(),
  };
  session.history.push(historyEntry);

  if (grading.verdict !== 'strong') {
    session.attempts += 1;
  } else {
    session.attempts = 0;
  }

  const followupAvailable = (question.followups || []).length > session.followupDepth;
  let action;
  if (grading.verdict === 'strong') {
    if (followupAvailable) {
      session.followupDepth += 1;
      action = 'followup';
    } else {
      session.index += 1;
      session.followupDepth = 0;
      action = 'next';
    }
  } else if (session.attempts >= 2) {
    session.index += 1;
    session.followupDepth = 0;
    session.attempts = 0;
    action = 'moved-on-after-retry';
  } else {
    action = 'retry-same';
  }

  if (session.index >= session.pool.length) {
    session.active = false;
  }
  knowledge.interview.current = { sessionId: session.id, questionId: currentId(bank, session) };

  const weakestDimension = grading.dimensions
    .filter((dimension) => dimension.dimension !== 'clarity')
    .sort((left, right) => left.score - right.score)[0];
  if (weakestDimension && weakestDimension.score < 0.6) {
    knowledge.interview.weakPoints = [
      ...(knowledge.interview.weakPoints || []),
      {
        dimension: weakestDimension.dimension,
        label: weakestDimension.label,
        questionId: id,
        missing: weakestDimension.missing.slice(0, 4),
        at: nowIso(),
      },
    ].slice(-50);
  }

  const recommended = found.followup
    ? {
      concise: `参考要点：${(found.followup.keywords || []).slice(0, 5).join('、')}。结合当前问题，先给结论，再给源码位置。`,
      deep: `这道追问考察的是对真实实现的掌握程度。可核对证据：${(found.followup.evidence || question.evidence || []).map((item) => `${item.file}:${item.line}`).join('、') || '见上一问的证据行'}。`,
    }
    : question.recommended;

  const next = session.active
    ? currentQuestion(knowledge)
    : { ok: false, reason: '本轮问题已问完，可执行 action=report 查看评价。', done: true };

  return {
    ok: true,
    grading,
    verdict: grading.verdict,
    feedback: grading.feedback,
    correction: grading.missing.length
      ? `遗漏/需要补齐：${grading.missing.slice(0, 5).join('；')}`
      : '关键点覆盖完整。',
    recommended,
    action,
    next,
    progress: {
      index: Math.min(session.index + 1, session.pool.length),
      total: session.pool.length,
      followupDepth: session.followupDepth,
      answered: session.history.length,
    },
    rule: 'overall ≥ 0.72 视为 strong，≥ 0.42 视为 partial；同一题最多重试一次。',
  };
}

export function hintFor(knowledge) {
  const current = currentQuestion(knowledge);
  if (!current.ok) return current;
  const bank = ensureBank(knowledge);
  const found = questionById(bank, current.questionId);
  if (!found) return current;
  const evidence = (found.followup?.evidence || found.question.evidence || []).slice(0, 3);
  const facts = (found.question.expectedFacts || []).slice(0, 2);
  return {
    ok: true,
    questionId: current.questionId,
    hint: [
      '回到源码：先找入口，再顺着调用点走，不要从函数名猜行为。',
      evidence.length ? `可核对位置：${evidence.map((item) => `${item.file}:${item.line}`).join('、')}` : '当前题目没有直接证据行，需要先扫描项目。',
      facts.length ? `思考方向：${facts.map((item) => truncate(item.text, 90)).join(' / ')}` : '',
    ].filter(Boolean),
  };
}

export { DIMENSIONS, DIFFICULTY_LABELS };
