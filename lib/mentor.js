/**
 * Human-facing mentor model: module narratives, core findings, a 3-step getting
 * started guide, lesson-based learning paths, and practice grouping.
 *
 * Everything here is derived from source evidence. When the evidence is too thin
 * the field says so instead of inventing a responsibility.
 */

import { nowIso, oneLine, round, toPosix, truncate } from './core.js';
import { buildCapabilities, capabilityForModule } from './capabilities.js';
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

function capabilityTitles(capabilities, ids) {
  return (ids || [])
    .map((id) => (capabilities?.nodes || []).find((capability) => capability.id === id)?.title)
    .filter(Boolean)
    .slice(0, 4);
}

/**
 * A module narrative is capability-first. It never lists symbols as the summary:
 * technical symbols stay in `symbols` for the technical-details fold.
 */
export function moduleNarrative(knowledge, module, capabilities = null) {
  const caps = capabilities || buildCapabilities(knowledge);
  const capability = capabilityForModule(caps, module);
  const symbols = moduleSymbols(knowledge, module);
  const upstream = moduleNames(knowledge, module.deps || []);
  const downstream = moduleNames(knowledge, module.dependents || []);
  const fallbackStart = (module.topFiles || [])[0];

  if (!capability) {
    const structural = /(^|\/)(inc|include|headers?)(\/|$)/i.test(module.path || '')
      ? {
        role: '接口与数据结构声明',
        summary: `${module.name} 是跨模块的声明层：主要存放头文件、类型和函数声明。具体业务职责要结合使用它的模块确认。`,
        responsibility: '为其他模块提供类型、宏和函数声明；它本身通常不执行业务流程。',
        inputs: '被其他模块包含的头文件与声明',
        outputs: '供实现文件使用的类型、宏和接口声明',
        failure: '声明与实现不一致、重复定义或条件编译分支遗漏',
        confidence: 'source',
        confidenceLabel: '目录结构可确认',
      }
      : /(^|\/)(mdk-arm|ewarm|iar|startup)(\/|$)|\.s$/i.test(module.path || '')
        ? {
          role: '启动与工具链文件',
          summary: `${module.name} 存放启动/工具链相关文件；启动顺序由入口与链接配置共同决定。`,
          responsibility: '提供工程或启动配置；业务行为需要沿入口继续阅读。',
          inputs: '工程配置、启动文件或链接脚本',
          outputs: '启动入口、向量表或构建配置',
          failure: '启动/链接配置错误导致无法进入主程序',
          confidence: 'source',
          confidenceLabel: '文件类型可确认',
        }
        : null;
    if (structural) {
      return {
        moduleId: module.id,
        name: module.name,
        ...structural,
        upstream,
        downstream,
        startHere: fallbackStart ? { file: fallbackStart.path, line: 1 } : null,
        files: (module.topFiles || []).slice(0, 4).map((file) => file.path),
        symbols: symbols.slice(0, 8).map((symbol) => ({ name: symbol.name, file: symbol.file, line: symbol.line })),
        evidence: module.evidence || [],
        capabilityId: null,
        capability: null,
      };
    }
    return {
      moduleId: module.id,
      name: module.name,
      role: '功能待确认',
      summary: `${module.name} 的业务功能证据不足，暂不能确认它具体负责什么。`,
      responsibility: '待深入分析：当前只确认了文件组织，缺少足够的调用关系或输入输出证据。',
      inputs: '待核实',
      outputs: '待核实',
      failure: '待核实',
      upstream,
      downstream,
      startHere: fallbackStart ? { file: fallbackStart.path, line: 1 } : null,
      files: (module.topFiles || []).slice(0, 4).map((file) => file.path),
      symbols: symbols.slice(0, 8).map((symbol) => ({ name: symbol.name, file: symbol.file, line: symbol.line })),
      evidence: module.evidence || [],
      confidence: 'unknown',
      confidenceLabel: '功能待确认',
      capabilityId: null,
      capability: null,
    };
  }

  const start = capability.sources?.[0] || (fallbackStart ? { file: fallbackStart.path, line: 1 } : null);
  return {
    moduleId: module.id,
    name: module.name,
    role: capability.title,
    summary: `${capability.title}：${capability.purpose}`,
    responsibility: `触发时机：${capability.trigger}。主要过程：${capability.process}。失败情况：${capability.failure}。`,
    inputs: capability.input,
    outputs: capability.output,
    failure: capability.failure,
    upstream: capabilityTitles(caps, capability.upstream).length ? capabilityTitles(caps, capability.upstream) : upstream,
    downstream: capabilityTitles(caps, capability.downstream).length ? capabilityTitles(caps, capability.downstream) : downstream,
    startHere: start,
    files: (module.topFiles || []).slice(0, 4).map((file) => file.path),
    symbols: symbols.slice(0, 8).map((symbol) => ({ name: symbol.name, file: symbol.file, line: symbol.line })),
    evidence: capability.sources,
    confidence: capability.evidenceLevel,
    confidenceLabel: capability.confidenceLabel,
    capabilityId: capability.id,
    capability,
  };
}

export function buildModuleNarratives(knowledge, capabilities = null) {
  const caps = capabilities || buildCapabilities(knowledge);
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
    .map((module) => moduleNarrative(knowledge, module, caps));
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

function chainForModule(knowledge, module, capability) {
  const byId = capability?.chainId ? (knowledge.chains || []).find((chain) => chain.id === capability.chainId) : null;
  if (byId) return byId;
  return (knowledge.chains || []).find((chain) => (chain.nodes || []).some((node) => node.module === module.id)) || null;
}

function lessonStatus(knowledge, lessonId) {
  return knowledge.learning?.lessons?.[lessonId]?.status || 'not_started';
}

function activityFor(knowledge, module, narrative, capability, chain) {
  const category = capability?.category || 'unknown';
  const start = narrative.startHere || { file: module.topFiles?.[0]?.path || '', line: 1 };
  const evidence = capability?.sources?.length ? capability.sources : [{ file: start.file, line: start.line }];
  const first = evidence[0];
  const chainSteps = (chain?.primary || []).slice(0, 4);
  const traceStep = chainSteps.length ? {
    kind: 'trace',
    title: '沿真实调用点走一遍',
    action: `依次打开 ${chainSteps.map((step) => `${step.file}:${step.line}`).join('、')}，记录每一步的输入、状态变化和返回。`,
    expected: `能复述 ${chainSteps[0]?.from} → ${chainSteps[chainSteps.length - 1]?.to}，并指出一个可能失败的位置。`,
    evidence: chainSteps.map((step) => ({ file: step.file, line: step.line })),
  } : null;

  const templates = {
    command: {
      outcome: '能说明一条命令从输入、解析、校验到执行的完整分支，并指出非法输入在哪里被处理。',
      observe: {
        kind: 'observe',
        title: '先观察一条真实命令',
        action: '如果项目提供串口/CLI/接口，发送一条已知合法命令和一条未知命令；记录屏幕、日志或返回值。',
        expected: '合法命令产生可观察动作；未知命令进入某个错误或忽略分支。',
        evidence,
      },
      inspect: {
        kind: 'inspect',
        title: '检查解析与校验分支',
        action: `打开 ${first.file}:${first.line} 附近，找出前缀匹配、参数解析和范围校验分别在哪几行。`,
        expected: '能指出成功路径与至少一个非法输入分支的源码位置。',
        evidence,
      },
      questions: [
        '一条合法命令和一条未知命令，分别走哪条分支？',
        '参数非法时，系统是返回错误、使用默认值，还是静默忽略？源码依据是什么？',
      ],
      microTask: {
        title: '记录一次命令处理',
        action: '写下一条命令的输入、经过的函数、最终结果；再写一条非法输入的实际表现。',
        readOnly: true,
        acceptance: '记录中有具体输入、可观察结果和至少一个源码位置。',
      },
      acceptance: ['能说明成功与非法两条分支', '能指出解析、校验和执行的对应源码', '能说出失败时的实际行为'],
    },
    control: {
      outcome: '能跟踪一组目标值与反馈如何变成控制量，并说明边界/失败时的行为。',
      observe: {
        kind: 'observe',
        title: '选一组最小输入观察控制结果',
        action: '选择一组目标值与实际反馈（或日志/变量），沿控制周期记录误差、控制量和执行器变化。',
        expected: '能按顺序说出“读反馈 → 算误差 → 算控制量 → 输出”的变量变化。',
        evidence,
      },
      inspect: {
        kind: 'inspect',
        title: '检查控制计算与限制',
        action: `打开 ${first.file}:${first.line} 附近，找出计算式、限幅和状态更新位置。`,
        expected: '能指出哪一行计算控制量、哪一行做边界限制。',
        evidence,
      },
      questions: [
        '目标值变化后，控制量在哪一步被更新？',
        '反馈异常或超差时，当前实现会怎样？',
      ],
      microTask: {
        title: '画一次控制数据流',
        action: '用 4–6 个节点写出反馈、误差、控制量、执行器的流向，节点旁标源码位置。',
        readOnly: true,
        acceptance: '数据流与源码调用/变量一致，至少有两个真实位置。',
      },
      acceptance: ['能复述一次控制周期', '能指出限幅/边界处理', '能说明一个异常场景'],
    },
    network: {
      outcome: '能说明一次请求如何从连接/收包走到业务处理，再返回响应。',
      observe: {
        kind: 'observe',
        title: '发送一个已知请求',
        action: '如果服务可运行，发送一个已知请求并记录连接、接收、处理和响应；不可运行时标注环境阻塞。',
        expected: '能看到或从代码推断出“收包 → 组包 → 处理 → 响应”的路径。',
        evidence,
      },
      inspect: {
        kind: 'inspect',
        title: '检查组包与错误分支',
        action: `打开 ${first.file}:${first.line} 附近，找出发送/接收、半包处理和断连处理。`,
        expected: '能指出至少一个失败分支（断连、发送失败、超时或半包）。',
        evidence,
      },
      questions: ['一次完整请求在哪个函数变成业务动作？', '断连或半包时当前实现会保留还是丢弃状态？'],
      microTask: {
        title: '写一次请求路径观察',
        action: '记录请求从进入到响应的函数顺序；无法运行时明确写“环境阻塞”及原因。',
        readOnly: true,
        acceptance: '路径有源码依据；环境阻塞有明确原因，不宣称运行通过。',
      },
      acceptance: ['能说明请求/响应路径', '能指出一个失败分支', '能区分已运行与仅阅读'],
    },
    storage: {
      outcome: '能说明数据存在哪里、何时写入、何时读回，以及掉电/损坏时如何恢复。',
      observe: {
        kind: 'observe',
        title: '观察一次保存与恢复',
        action: '找到保存/读取入口，选择一个可逆参数，说明写入前后值如何变化；有运行环境时做一次重启观察。',
        expected: '能说出写入介质、触发时机和恢复入口。',
        evidence,
      },
      inspect: {
        kind: 'inspect',
        title: '检查校验与失败回退',
        action: `打开 ${first.file}:${first.line} 附近，找出写入、校验、默认值回退和版本/魔数处理。`,
        expected: '能指出写入失败或数据损坏时的回退路径。',
        evidence,
      },
      questions: ['参数在什么时候写入持久介质？', '写入失败或数据损坏时，系统如何回退？'],
      microTask: {
        title: '写一次持久化生命周期',
        action: '按“产生 → 保存 → 重启/读回 → 校验/回退”写出数据生命周期，并标源码位置。',
        readOnly: true,
        acceptance: '生命周期完整，包含至少一个失败/回退分支。',
      },
      acceptance: ['能说明存储位置与触发时机', '能说明恢复/回退路径', '能指出一个边界条件'],
    },
    concurrency: {
      outcome: '能画出一个任务/中断的交接顺序，并指出共享状态与退出路径。',
      observe: {
        kind: 'observe',
        title: '找一个中断或任务交接点',
        action: '选择一或两个中断/任务入口，记录它们如何把数据交给主循环或其他任务。',
        expected: '能指出生产者、消费者和共享变量/队列。',
        evidence,
      },
      inspect: {
        kind: 'inspect',
        title: '检查共享状态与临界区',
        action: `打开 ${first.file}:${first.line} 附近，找出标志位、临界区、锁或原子操作。`,
        expected: '能指出一个可能的竞态或丢失更新点，并说明当前保护方式。',
        evidence,
      },
      questions: ['中断和主循环共享了哪些状态？', '如果处理速度慢于事件到达，会发生什么？'],
      microTask: {
        title: '画一次交接顺序',
        action: '用“中断/任务 A → 共享状态/队列 → 任务 B”画一次交接，标出保护点和失败场景。',
        readOnly: true,
        acceptance: '顺序有源码依据，至少指出一个保护或未保护点。',
      },
      acceptance: ['能说明交接顺序', '能指出共享状态', '能说明一个积压/丢失风险'],
    },
    startup: {
      outcome: '能按真实顺序说明从复位/入口到主循环发生了什么。',
      observe: {
        kind: 'observe',
        title: '沿启动顺序读一遍',
        action: '从入口开始，记录时钟、外设、业务初始化和主循环的先后顺序。',
        expected: '能说出初始化失败时程序会停在哪一步。',
        evidence,
      },
      inspect: {
        kind: 'inspect',
        title: '检查初始化失败分支',
        action: `打开 ${first.file}:${first.line} 附近，找出初始化返回值/错误处理/死循环。`,
        expected: '能指出至少一个初始化失败的表现。',
        evidence,
      },
      questions: ['启动顺序中哪些步骤有失败处理？', '如果外设未就绪，程序会怎样？'],
      microTask: {
        title: '写一份启动清单',
        action: '按顺序列出启动步骤，每步写负责函数和源码位置；标注一个失败分支。',
        readOnly: true,
        acceptance: '顺序与源码一致，至少包含一个失败分支。',
      },
      acceptance: ['能复述启动顺序', '能指出初始化失败处理', '能说明主循环如何开始'],
    },
    ui: {
      outcome: '能说明一次用户操作如何触发回调并改变界面/状态。',
      observe: {
        kind: 'observe',
        title: '触发一个具体界面操作',
        action: '选一个按钮/页面事件，记录操作前后界面或状态的变化。',
        expected: '能指出事件、回调、状态更新和重绘/显示的关系。',
        evidence,
      },
      inspect: {
        kind: 'inspect',
        title: '检查回调与状态更新',
        action: `打开 ${first.file}:${first.line} 附近，找出注册回调、状态写入和显示更新。`,
        expected: '能区分“注册回调”和“回调真正执行的业务动作”。',
        evidence,
      },
      questions: ['用户操作后哪个回调被触发？', '状态更新后界面如何刷新？'],
      microTask: {
        title: '记录一次交互链路',
        action: '写出“操作 → 回调 → 状态 → 显示”的链路，并标注源码位置。',
        readOnly: true,
        acceptance: '链路有源码依据，能区分注册与执行。',
      },
      acceptance: ['能说明交互链路', '能找到回调与状态更新', '能指出一个异常/空状态'],
    },
    status: {
      outcome: '能说明状态如何被采样、判断、显示或触发告警，以及如何恢复。',
      observe: {
        kind: 'observe',
        title: '触发一次状态变化',
        action: '选择一个按键、传感器或错误码，记录它如何改变显示、日志或告警。',
        expected: '能指出采样入口、判断条件、告警动作和恢复条件。',
        evidence,
      },
      inspect: {
        kind: 'inspect',
        title: '检查阈值与恢复分支',
        action: `打开 ${first.file}:${first.line} 附近，找出阈值判断、去抖、置位和清除位置。`,
        expected: '能指出误报/漏报/无法恢复中的至少一个风险点。',
        evidence,
      },
      questions: ['哪个条件触发告警？', '告警如何被清除或自动恢复？'],
      microTask: {
        title: '写一次状态变化记录',
        action: '记录触发条件、告警动作、恢复动作和对应源码位置。',
        readOnly: true,
        acceptance: '触发与恢复都有源码依据。',
      },
      acceptance: ['能说明状态采样与判断', '能说明告警/恢复', '能指出一个误报或漏报风险'],
    },
    time: {
      outcome: '能说明设置/读取时间的流程、写保护、超时分支和掉电保持。',
      observe: {
        kind: 'observe',
        title: '设置一个已知时间并读回',
        action: '通过真实入口设置时间，再读回；有 RTC 时重启观察是否保持。',
        expected: '能说出写入、读回和掉电保持的实际表现。',
        evidence,
      },
      inspect: {
        kind: 'inspect',
        title: '检查写保护与初始化等待',
        action: `打开 ${first.file}:${first.line} 附近，找出 WPR/INIT/INITF 等待和超时分支。`,
        expected: '能指出超时后是否仍然写入，以及上层是否感知失败。',
        evidence,
      },
      questions: ['设置时间时必须先做什么？', '初始化等待超时后当前实现会怎样？'],
      microTask: {
        title: '写一次时间设置生命周期',
        action: '按“校验 → 解写保护 → 等待就绪 → 写入 → 读回 → 恢复保护”记录源码位置。',
        readOnly: true,
        acceptance: '生命周期完整，并指出一个失败分支。',
      },
      acceptance: ['能复述设置/读取流程', '能指出写保护与超时处理', '能说明掉电保持机制'],
    },
    unknown: {
      outcome: '能指出这组功能对应的真实函数、输入输出和调用方；不能确认的部分明确标注待核实。',
      observe: {
        kind: 'observe',
        title: '从调用方观察输入输出',
        action: '打开推荐入口，找出谁调用它、传入什么、返回或修改了什么。',
        expected: '能写出至少一组真实的输入 → 输出关系。',
        evidence,
      },
      inspect: {
        kind: 'inspect',
        title: '检查失败分支',
        action: `打开 ${first.file}:${first.line} 附近，找出返回值检查、错误处理或提前返回。`,
        expected: '能指出一个失败路径，或明确说明未找到。',
        evidence,
      },
      questions: ['这组函数的真实调用方是谁？', '输入异常时会发生什么？哪些结论仍然待核实？'],
      microTask: {
        title: '写一条待核实清单',
        action: '列出已确认的输入输出、调用方，以及仍需核实的业务含义。',
        readOnly: true,
        acceptance: '已确认与待核实分开，不把推断写成事实。',
      },
      acceptance: ['能指出真实调用关系', '能区分已确认与待核实', '能说明一个失败或边界路径'],
    },
  };

  const template = templates[category] || templates.unknown;
  const walkthrough = [
    template.observe,
    { kind: 'read', title: '阅读推荐入口', action: `打开 ${start.file}:${start.line}，先只看函数边界、参数和返回。`, expected: '能说出这个入口接收什么、产生什么。', evidence: [{ file: start.file, line: start.line }] },
    ...(traceStep ? [traceStep] : []),
    template.inspect,
  ];
  return {
    category,
    outcome: template.outcome,
    walkthrough,
    checkQuestions: template.questions,
    microTask: template.microTask,
    acceptance: template.acceptance,
  };
}

export function buildLessons(knowledge, options = {}) {
  const capabilities = options.capabilities || buildCapabilities(knowledge);
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
    const narrative = moduleNarrative(knowledge, module, capabilities);
    const capability = narrative.capability;
    if (!capability
      && /(^|\/)(mdk-arm|ewarm|startup)(\/|$)|\.s$/i.test(module.path || '')
      && (capabilities.nodes || []).some((node) => node.category === 'startup')) {
      // The startup capability lesson already covers the toolchain/startup files.
      continue;
    }
    const chain = chainForModule(knowledge, module, capability);
    const lessonId = `lesson:${module.id}`;
    const start = narrative.startHere || { file: module.topFiles?.[0]?.path || '', line: 1 };
    const activity = activityFor(knowledge, module, narrative, capability, chain);
    const lessonTitle = capability
      ? capability.title
      : `定位 ${module.name} 中的关键行为（功能待确认）`;
    const concept = capability
      ? `${capability.purpose} 触发时机：${capability.trigger}；输入：${capability.input}；结果：${capability.output}。`
      : narrative.summary;
    const steps = activity.walkthrough.map((step) => (step.kind === 'trace'
      ? { type: 'trace', title: step.title, chainId: chain?.id || null, steps: chain?.primary?.slice(0, 4) || [], instruction: step.action }
      : step.kind === 'read'
        ? { type: 'read', title: step.title, target: step.evidence?.[0] || start, note: step.action }
        : { type: 'verify', title: step.title, instruction: `${step.action} 预期：${step.expected}`, readOnly: true }));
    steps.push({
      type: 'explain',
      title: '回答一个理解问题',
      prompt: activity.checkQuestions[0],
      evidence: narrative.evidence,
    });
    lessons.push({
      lessonId,
      moduleId: module.id,
      title: lessonTitle,
      lessonTitle,
      capabilityId: capability?.id || null,
      priority: item.priority,
      phase: lessons.length === 0 ? 'flow' : 'modules',
      why: capability
        ? `${capability.purpose} 在真实项目中，这个功能通过 ${capability.sources.slice(0, 2).map((source) => source.symbol).join('、') || '已索引函数'} 实现；先理解它，才能定位修改影响。`
        : `${narrative.summary} 当前证据不足，本课的目标是先确认真实调用关系，而不是记住文件位置。`,
      whyLearn: capability?.purpose || narrative.summary,
      expectedOutcome: activity.outcome,
      prerequisites: (item.prerequisites || []).map((prerequisite) => prerequisite.name),
      conceptExplanation: concept,
      learningObjectives: [
        activity.outcome,
        `能指出 ${capability?.sources?.length || 1} 个真实源码依据`,
        '能区分已确认事实与待核实推断',
      ],
      walkthrough: activity.walkthrough,
      steps,
      checkQuestions: activity.checkQuestions,
      microTask: activity.microTask,
      acceptance: activity.acceptance,
      completionCriteria: activity.acceptance,
      estimatedMinutes: item.budgetMinutes || 25,
      status: lessonStatus(knowledge, lessonId),
      evidence: narrative.evidence,
      startHere: start,
      module: { id: module.id, name: module.name, role: narrative.role, confidence: narrative.confidence },
      capability: capability ? { id: capability.id, title: capability.title, evidenceLevel: capability.evidenceLevel } : null,
      next: null,
    });
  }

  // Capability lessons make the route function-first even when a module holds
  // several capabilities or a capability spans modules.
  const covered = new Set(lessons.map((lesson) => lesson.capabilityId).filter(Boolean));
  for (const capability of capabilities.nodes || []) {
    if (!capability.sources?.length || covered.has(capability.id)) continue;
    const module = knowledge.modules.find((item) => (capability.relatedModules || []).includes(item.name))
      || knowledge.modules.find((item) => (capability.sources || []).some((source) => source.file.startsWith(`${item.path}/`)));
    if (!module) continue;
    const planItem = (plan.items || []).find((item) => item.moduleId === module.id);
    const chain = chainForModule(knowledge, module, capability);
    const start = capability.sources[0];
    const narrative = {
      moduleId: module.id,
      name: module.name,
      role: capability.title,
      summary: `${capability.title}：${capability.purpose}`,
      responsibility: `触发时机：${capability.trigger}。主要过程：${capability.process}。失败：${capability.failure}。`,
      inputs: capability.input,
      outputs: capability.output,
      failure: capability.failure,
      upstream: [],
      downstream: [],
      startHere: start,
      evidence: capability.sources,
      symbols: [],
      confidence: capability.evidenceLevel,
      confidenceLabel: capability.confidenceLabel,
      capability,
    };
    const activity = activityFor(knowledge, module, narrative, capability, chain);
    const lessonId = `lesson:cap:${capability.id}`;
    const steps = activity.walkthrough.map((step) => (step.kind === 'trace'
      ? { type: 'trace', title: step.title, chainId: chain?.id || null, steps: chain?.primary?.slice(0, 4) || [], instruction: step.action }
      : step.kind === 'read'
        ? { type: 'read', title: step.title, target: step.evidence?.[0] || start, note: step.action }
        : { type: 'verify', title: step.title, instruction: `${step.action} 预期：${step.expected}`, readOnly: true }));
    steps.push({ type: 'explain', title: '回答一个理解问题', prompt: activity.checkQuestions[0], evidence: capability.sources });
    lessons.push({
      lessonId,
      moduleId: module.id,
      title: capability.title,
      lessonTitle: capability.title,
      capabilityId: capability.id,
      priority: planItem?.priority || 'P1',
      phase: 'modules',
      why: capability.purpose,
      whyLearn: capability.purpose,
      expectedOutcome: activity.outcome,
      prerequisites: [],
      conceptExplanation: `${capability.purpose} 触发：${capability.trigger}；输入：${capability.input}；输出：${capability.output}。`,
      learningObjectives: [activity.outcome, '能指出至少两个真实源码依据', '能说明一个失败/边界分支'],
      walkthrough: activity.walkthrough,
      steps,
      checkQuestions: activity.checkQuestions,
      microTask: activity.microTask,
      acceptance: activity.acceptance,
      completionCriteria: activity.acceptance,
      estimatedMinutes: planItem?.budgetMinutes || 25,
      status: lessonStatus(knowledge, lessonId),
      evidence: capability.sources,
      startHere: start,
      module: { id: module.id, name: module.name, role: capability.title, confidence: capability.evidenceLevel },
      capability: { id: capability.id, title: capability.title, evidenceLevel: capability.evidenceLevel },
      next: null,
    });
  }
  for (let index = 0; index < lessons.length; index += 1) {
    lessons[index].next = index + 1 < lessons.length
      ? { type: 'lesson', lessonId: lessons[index + 1].lessonId, title: lessons[index + 1].lessonTitle }
      : { type: 'practice', title: '完成一个低风险实践任务', stage: 'A' };
  }
  return lessons;
}

export function buildProjectRoute(knowledge, lessons) {
  const build = (knowledge.build?.commands || []).find((command) => command.available);
  const first = lessons[0] || null;
  const rest = lessons.slice(1);
  return [
    { id: 'understand', title: '知道项目能做什么', detail: '先看功能卡与典型流程，不急着记文件名。', lessonId: first?.lessonId || null },
    { id: 'run', title: '能够运行并观察', detail: build ? `可尝试：${build.display}` : '没有可自动执行的构建入口；记录环境阻塞原因。', blocked: !build, command: build?.display || '' },
    { id: 'flow', title: '看懂一条最重要的业务操作', detail: first?.expectedOutcome || '选择一条真实功能链路。', lessonId: first?.lessonId || null },
    { id: 'modules', title: '理解关键功能模块', detail: '按能力差异学习，而不是按目录顺序。', lessonIds: rest.map((lesson) => lesson.lessonId) },
    { id: 'modify', title: '能独立定位和修改', detail: '从观察、定位、复现开始，再进入小改与验证。', stage: 'A' },
    { id: 'interview', title: '能解释设计取舍', detail: '用真实源码与修改经历回答追问。', action: 'interview' },
  ];
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

export function buildPracticeView(knowledge, generatedTasks = [], capabilities = null) {
  const caps = capabilities || buildCapabilities(knowledge);
  const runCommand = (knowledge.build?.commands || []).find((command) => command.available && ['build', 'test', 'run'].includes(command.kind));
  const testCommand = (knowledge.build?.commands || []).find((command) => command.available && command.kind === 'test');
  const capability = caps.nodes.find((item) => ['command', 'network', 'control', 'storage', 'time'].includes(item.category) && item.sources?.length)
    || caps.nodes.find((item) => item.category !== 'startup' && item.sources?.length)
    || caps.nodes[0]
    || null;
  const entry = capability?.sources?.[0] || knowledge.entryPoints?.[0] || null;

  const stageA = {
    id: 'stage:observe',
    stage: 'A',
    stageTitle: '观察',
    title: runCommand ? `运行一个最小功能：${runCommand.label}` : '观察项目实际可运行的最小功能',
    scenario: runCommand
      ? '先让项目真实跑起来，确认一条最小功能；不要一上来就读全部源码。'
      : '当前没有可自动执行的构建/运行入口；本阶段记录环境阻塞原因，并改用静态观察。',
    prerequisites: runCommand ? ['本地工具链/设备可用'] : ['说明缺少的工具链、设备或依赖'],
    steps: runCommand
      ? [
        { action: `执行 ${runCommand.display}`, expected: '记录真实退出码与关键输出，不把“应该能过”当作运行成功。', evidence: [] },
        { action: '选择一个最小功能（例如一条命令、一次请求或一次控制周期）并触发它', expected: '记录输入、可观察输出、失败表现。', evidence: entry ? [entry] : [] },
      ]
      : [
        { action: '尝试确认构建入口与依赖；说明为什么当前无法运行', expected: '写出“环境阻塞”的具体原因，不宣称运行通过。', evidence: knowledge.build?.manifests?.slice(0, 2).map((item) => ({ file: item.manifest, line: 1 })) || [] },
        { action: '静态选一个功能入口，记录它接收什么、产生什么', expected: '得到一条可核对的静态观察。', evidence: entry ? [entry] : [] },
      ],
    pitfalls: runCommand ? ['环境变量/设备权限不满足时误判为代码失败', '只记录成功输出，忽略错误信息'] : ['把静态阅读说成运行验证'],
    acceptance: runCommand ? ['留下真实命令、退出码和关键输出', '能说出一个最小功能的输入与输出'] : ['明确记录环境阻塞原因', '至少完成一条有源码依据的静态观察'],
    codeEntry: entry,
    readOnly: true,
    blocked: !runCommand,
    blockedReason: runCommand ? '' : '没有检测到可自动执行的构建/运行入口。',
    confidence: 'source',
  };

  const stageB = {
    id: 'stage:locate',
    stage: 'B',
    stageTitle: '定位',
    title: capability ? `定位「${capability.title}」的入口与关键路径` : '根据一个具体场景定位相关源码',
    scenario: capability
      ? `从一个真实功能出发，找到它由谁触发、经过哪些函数、最终改变什么状态。`
      : '选择一个具体输入或操作，找到它进入代码的位置。',
    prerequisites: ['已完成 A 阶段或能说明环境阻塞'],
    steps: capability
      ? [
        { action: `打开 ${capability.sources[0].file}:${capability.sources[0].line}，确认入口函数与参数`, expected: '能写出输入的业务含义和返回值。', evidence: capability.sources.slice(0, 2) },
        { action: '查看调用方与被调用方，画出 3–5 个节点的路径', expected: '路径中的每个节点都有源码位置。', evidence: capability.sources.slice(0, 3) },
        { action: '指出一个失败或边界分支', expected: '能说明失败时返回/回退/记录，而不是只看正常路径。', evidence: capability.sources.slice(0, 3) },
      ]
      : [{ action: '从入口或信号入口开始，记录调用关系', expected: '得到一条有源码位置的路径。', evidence: entry ? [entry] : [] }],
    pitfalls: ['把函数名当成业务职责', '只列文件列表，没有输入输出与调用关系'],
    acceptance: ['能说明功能由谁触发', '能给出至少一条带 file:line 的调用路径', '能指出一个失败/边界点'],
    codeEntry: capability?.sources?.[0] || entry,
    readOnly: true,
    blocked: false,
    blockedReason: '',
    confidence: capability?.evidenceLevel || 'unknown',
  };

  let stageC;
  if (capability && ['command', 'network', 'control', 'storage'].includes(capability.category)) {
    const scenarioByCategory = {
      command: '构造一条正常命令和一条非法/未知命令，对比系统行为。',
      network: '发送一个已知请求和一个异常/不完整请求，观察连接与响应。',
      control: '设置一组正常目标值和一组越界/异常反馈，观察控制输出。',
      storage: '修改一个可逆参数并重启/读回，再观察损坏或缺失数据。',
    };
    stageC = {
      id: 'stage:reproduce',
      stage: 'C',
      stageTitle: '复现',
      title: `${capability.title}：构造正常与异常输入`,
      scenario: scenarioByCategory[capability.category],
      prerequisites: ['完成 B 阶段定位', '知道如何触发该功能的输入方式'],
      steps: [
        { action: '先构造一个正常输入，记录实际输出', expected: '实际行为与 B 阶段读到的路径一致。', evidence: capability.sources.slice(0, 2) },
        { action: '构造一个非法/边界输入，记录实际输出', expected: '能指出错误在解析、校验还是执行层被处理。', evidence: capability.sources.slice(0, 2) },
        { action: '写出最小复现步骤：输入、操作、预期、实际', expected: '他人可按步骤重复。', evidence: capability.sources.slice(0, 2) },
      ],
      pitfalls: ['没有记录真实输入，只写“测试一下”', '把预期行为写成实际行为'],
      acceptance: ['正常/异常两组输入都有记录', '能说明差异发生在哪一层', '复现步骤可重复'],
      codeEntry: capability.sources[0],
      readOnly: true,
      blocked: false,
      blockedReason: '',
      confidence: 'inferred',
    };
  } else {
    stageC = {
      id: 'stage:reproduce',
      stage: 'C',
      stageTitle: '复现',
      title: '构造正常与边界输入（输入协议待确认）',
      scenario: '当前证据不足以确认该功能的输入协议；先记录已知输入方式，或明确标为待核实。',
      prerequisites: ['完成 B 阶段定位'],
      steps: [{ action: '从源码入口确认输入来源与格式；无法确认时记录待核实问题', expected: '不编造不存在的命令或接口。', evidence: entry ? [entry] : [] }],
      pitfalls: ['凭空假设输入格式'],
      acceptance: ['明确写出已确认/未确认的输入方式', '给出下一步核对动作'],
      codeEntry: entry,
      readOnly: true,
      blocked: true,
      blockedReason: '输入协议证据不足，不能安全构造复现。',
      confidence: 'unknown',
    };
  }

  const stageD = {
    id: 'stage:small-change',
    stage: 'D',
    stageTitle: '小改',
    title: '在明确授权下完成一个低风险改动',
    scenario: '只有 A–C 阶段确认了真实行为后，才进入修改；候选风险必须先核对调用方与失败语义。',
    prerequisites: ['完成 A–C 或明确说明环境阻塞', '用户明确授权写操作'],
    steps: [
      { action: '从下方候选任务中选择一个，先写预期行为、当前行为、影响范围', expected: '修改前检查完整。', evidence: [] },
      { action: '在独立分支/隔离工作区完成最小改动', expected: 'Diff 只包含预期改动。', evidence: [] },
      { action: '执行可用的验证并记录真实退出码', expected: '区分已执行与仅建议。', evidence: [] },
    ],
    pitfalls: ['把静态扫描信号当成已确认 Bug', '未授权直接修改业务仓库'],
    acceptance: ['有明确授权与 Diff', '有真实验证记录', '未验证风险被列出'],
    codeEntry: generatedTasks[0]?.target || entry,
    readOnly: false,
    blocked: generatedTasks.length === 0,
    blockedReason: generatedTasks.length === 0 ? '未发现足够可靠的改动任务。' : '',
    confidence: 'candidate',
    candidates: generatedTasks.slice(0, 5).map((task) => ({
      id: task.id,
      kind: task.kind,
      title: task.title,
      target: task.target,
      confidence: task.kind === 'testing' ? 'confirmed-gap' : 'candidate',
      confidenceLabel: task.kind === 'testing' ? '已确认的缺口' : '候选风险（需先核对源码）',
      objective: task.objective,
      evidence: task.evidence,
    })),
  };

  const stageE = {
    id: 'stage:verify',
    stage: 'E',
    stageTitle: '验证',
    title: '验证、回归与失败复盘',
    scenario: '修改后必须有可重复的验证；没有执行过的步骤不能算通过。',
    prerequisites: ['完成 D 阶段改动'],
    steps: [
      { action: runCommand ? `执行 ${runCommand.display}` : '说明构建不可用原因', expected: '记录退出码与关键输出。', evidence: [] },
      { action: testCommand ? `执行 ${testCommand.display}` : '说明测试入口缺失或不可自动执行', expected: '记录通过的测试与未覆盖风险。', evidence: [] },
      { action: '生成 Git Diff 审查并核对改动范围', expected: 'Diff 只包含预期文件。', evidence: [] },
    ],
    pitfalls: ['把未执行描述为通过', '只跑一次正常路径'],
    acceptance: ['至少一项真实验证被执行或明确阻塞', '列出未覆盖风险', '可复现的验证步骤'],
    codeEntry: null,
    readOnly: false,
    blocked: !runCommand && !testCommand,
    blockedReason: !runCommand && !testCommand ? '没有可自动执行的构建/测试入口。' : '',
    confidence: 'unknown',
  };

  const stages = [stageA, stageB, stageC, stageD, stageE];
  const understand = [stageA, stageB, stageC];
  const smallChange = stageD.candidates?.length ? [stageD] : [];
  return {
    generatedAt: nowIso(),
    mode: 'staged',
    defaultStage: 'A',
    stages,
    defaultCategory: 'understand',
    categories: [
      { id: 'understand', label: '入门理解（A–C）', description: '观察、定位、复现；不需要改仓库。', tasks: understand },
      { id: 'small-change', label: '小型修改（D–E）', description: '低风险改动 + 真实验证；候选风险先核实。', tasks: smallChange },
      { id: 'challenge', label: '工程挑战', description: '并发/性能/一致性等高风险任务；不建议新人直接上手。', tasks: generatedTasks.filter((task) => task.kind === 'refactor').slice(0, 3) },
    ],
    note: generatedTasks.length
      ? '候选风险不是已确认 Bug；D/E 阶段必须显式授权并执行验证。'
      : '未发现足够可靠的修改任务；先用 A–C 阶段建立可观察的源码认知。',
  };
}
