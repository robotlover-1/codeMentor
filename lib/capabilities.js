/**
 * Capability graph: group real symbols/call edges into user-visible capabilities.
 *
 * This is deliberately not a directory mirror. One capability can span files and
 * modules; one file can serve several capabilities. Every node keeps source
 * evidence and an evidence level. When the evidence only supports "there is a
 * feature named X", the fields say unknown instead of inventing the business.
 */

import { nowIso, oneLine, round, toPosix } from './core.js';

const ROLE_DEFS = [
  {
    id: 'command',
    tokens: ['cmd', 'command', 'dispatch', 'parse', 'parser', 'shell', 'console', 'protocol'],
    title: '接收并执行控制命令',
    purpose: '把外部输入解析成具体动作，再交给对应处理函数执行。',
    trigger: '上位机、串口或操作界面发来一条命令时',
    input: '命令文本与参数',
    output: '执行对应动作，并可能返回处理结果或状态变化',
    process: '匹配命令前缀 → 解析参数 → 校验范围 → 调用具体处理函数',
    failure: '未知命令、参数缺失或参数越界时的处理分支',
    category: 'command',
  },
  {
    id: 'control',
    tokens: ['pid', 'motor', 'step', 'control', 'servo', 'pwm', 'encoder', 'motion', 'speed', 'loop'],
    title: '闭环运动控制',
    purpose: '根据目标值和反馈计算控制量，并驱动电机或执行器。',
    trigger: '启动运动、更新目标值或定时控制周期到达时',
    input: '目标位置/速度与当前反馈',
    output: '控制量、执行器动作或新的运动状态',
    process: '读取反馈 → 计算误差 → 计算控制量 → 更新执行器输出',
    failure: '反馈丢失、超差、限位或计算异常时的保护分支',
    category: 'control',
  },
  {
    id: 'network',
    tokens: ['net', 'eth', 'tcp', 'udp', 'socket', 'server', 'client', 'lwip', 'http'],
    title: '网络通信与请求处理',
    purpose: '建立连接、收发数据，并把完整报文交给上层处理。',
    trigger: '客户端连接、收到报文或需要主动发送响应时',
    input: '网络报文、连接状态或发送数据',
    output: '响应报文、连接状态或交给业务层的完整消息',
    process: '建立/接收连接 → 读取并组包 → 交给处理逻辑 → 发送响应',
    failure: '断连、半包、发送失败或超时时的处理',
    category: 'network',
  },
  {
    id: 'storage',
    tokens: ['flash', 'eeprom', 'param', 'save', 'load', 'persist', 'storage', 'config', 'setting', 'backup'],
    title: '参数与掉电保存',
    purpose: '把运行参数保存到持久介质，并在启动或需要时恢复。',
    trigger: '参数变更、保存命令或设备启动时',
    input: '需要保存的参数、默认值或存储介质',
    output: '持久化后的参数、恢复后的运行状态',
    process: '收集参数 → 校验 → 写入存储 → 读回验证或恢复',
    failure: '写入失败、校验失败、存储介质损坏时的回退',
    category: 'storage',
  },
  {
    id: 'time',
    tokens: ['rtc', 'time', 'clock', 'date'],
    title: '时间维护与 RTC',
    purpose: '维护设备时间，并支持设置、读取和掉电保持。',
    trigger: '设置时间命令、读取时间或需要时间戳时',
    input: '年月日时分秒或内部时钟源',
    output: 'RTC 寄存器状态、时间字符串或时间戳',
    process: '校验时间 → 解除写保护 → 写入 RTC → 读回确认',
    failure: '时钟未就绪、写保护未解除或写入超时时',
    category: 'time',
  },
  {
    id: 'timer',
    tokens: ['tim', 'timer', 'isr', 'irq', 'interrupt', 'tick', 'delay', 'systick'],
    title: '定时与中断节拍',
    purpose: '用定时器或中断产生稳定节拍，驱动周期任务和实时响应。',
    trigger: '定时器溢出、比较匹配或中断触发时',
    input: '时钟源、计数值或中断标志',
    output: '周期回调、节拍计数或触发后续任务',
    process: '中断触发 → 清标志 → 更新计数/状态 → 触发周期处理',
    failure: '中断丢失、计数溢出或临界区竞争',
    category: 'concurrency',
  },
  {
    id: 'bus',
    tokens: ['usart', 'uart', 'serial', 'spi', 'i2c', 'can', 'dma', 'adc'],
    title: '串口与总线数据收发',
    purpose: '通过串口/总线与外部设备交换数据。',
    trigger: '收到数据、需要发送数据或外设事件到达时',
    input: '字节流、寄存器状态或待发送缓冲区',
    output: '解析后的数据、发送结果或外设状态',
    process: '配置外设 → 收发数据 → 处理中断/状态 → 交给上层',
    failure: '溢出、校验错误、超时或总线忙',
    category: 'network',
  },
  {
    id: 'status',
    tokens: ['debug', 'log', 'led', 'key', 'alarm', 'error', 'fault', 'status', 'monitor', 'photo', 'ele'],
    title: '状态监测与告警',
    purpose: '采集设备状态、显示或上报告警，并处理异常。',
    trigger: '状态变化、按键操作、故障发生或周期采样时',
    input: '传感器/按键状态、错误码或日志文本',
    output: '显示状态、告警动作或诊断信息',
    process: '采样 → 判断阈值/状态 → 更新显示或触发保护',
    failure: '误报、漏报、日志丢失或告警无法恢复',
    category: 'status',
  },
  {
    id: 'startup',
    tokens: ['startup', 'boot', 'reset_handler'],
    title: '启动与初始化',
    purpose: '从复位入口完成时钟、外设和业务模块初始化，然后进入主循环。',
    trigger: '设备上电、复位或软件重启时',
    input: '复位入口、时钟配置和初始化顺序',
    output: '可运行的系统状态与主循环',
    process: '复位 → 系统初始化 → 外设初始化 → 业务初始化 → 主循环',
    failure: '初始化失败、外设未就绪或启动超时',
    category: 'startup',
  },
  {
    id: 'ui',
    tokens: ['gui', 'ui', 'view', 'page', 'render', 'callback', 'plot', 'button', 'screen'],
    title: '界面展示与交互',
    purpose: '接收用户操作、更新显示，并把交互结果交给处理逻辑。',
    trigger: '用户点击、页面事件或数据需要刷新时',
    input: '用户操作、显示数据或界面事件',
    output: '更新后的显示、状态或回调动作',
    process: '接收事件 → 更新界面状态 → 调用业务回调',
    failure: '事件丢失、回调异常或界面状态不一致',
    category: 'ui',
  },
];

const GENERIC_TOKENS = new Set([
  'get', 'set', 'init', 'reset', 'handle', 'handler', 'process', 'update', 'read', 'write',
  'is', 'has', 'main', 'run', 'start', 'stop', 'open', 'close', 'create', 'delete', 'new',
  'hal', 'll', 'stm32', 'stm32f4', 'mx', 'system', 'app', 'util', 'utils', 'common', 'core',
  'data', 'value', 'values', 'index', 'id', 'ptr', 'buf', 'buffer', 'size', 'len', 'count',
]);

function tokensOf(name) {
  const spaced = String(name || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .toLowerCase();
  return spaced.split(/\s+/).filter(Boolean);
}

function featureTokens(name) {
  const all = tokensOf(name);
  const meaningful = all.filter((token) => token.length >= 2 && !GENERIC_TOKENS.has(token));
  return meaningful.length ? meaningful : all.filter((token) => token.length >= 3);
}

function roleOf(name) {
  const candidates = featureTokens(name);
  const primary = candidates[0];
  if (!primary) return null;
  for (const role of ROLE_DEFS) {
    if (role.tokens.includes(primary)) return role;
  }
  return null;
}

function symbolEvidence(symbol) {
  return { file: toPosix(symbol.file), line: symbol.line, symbol: symbol.name };
}

function chainForSymbols(knowledge, names) {
  const chains = knowledge.chains || [];
  return chains.find((chain) => (chain.primary || []).some((step) => names.has(step.from) || names.has(step.to)))
    || null;
}

function capabilityFromGroup(knowledge, role, group, index) {
  const symbols = group.slice().sort((left, right) => (right.loc + (right.calls?.length || 0) * 3) - (left.loc + (left.calls?.length || 0) * 3));
  const names = new Set(symbols.map((symbol) => symbol.name));
  const sources = symbols.slice(0, 6).map(symbolEvidence).filter((item) => item.file);
  const chain = chainForSymbols(knowledge, names);
  const chainSteps = (chain?.primary || []).filter((step) => names.has(step.from) || names.has(step.to)).slice(0, 5);
  const moduleIds = [...new Set(symbols.map((symbol) => symbol.module).filter(Boolean))];
  const relatedModules = moduleIds
    .map((id) => knowledge.modules.find((module) => module.id === id)?.name)
    .filter(Boolean)
    .slice(0, 5);
  const entryNames = new Set((knowledge.entryPoints || []).map((entry) => entry.name));
  const isEntry = symbols.some((symbol) => entryNames.has(symbol.name)) || (role?.id === 'startup' && chainSteps.length > 0);
  const roleDef = role || {
    id: `feature:${index}`,
    title: `${symbols[0]?.name || '功能'} 相关功能（待确认）`,
    purpose: '扫描到一组同名功能函数，但业务含义需要结合调用方与输入输出确认。',
    trigger: '待确认',
    input: '待确认',
    output: '待确认',
    process: '查看相关函数与调用方后确认',
    failure: '待确认',
    category: 'unknown',
  };
  const risk = (knowledge.risks || []).find((item) => (item.evidence || []).some((evidence) => sources.some((source) => source.file === evidence.file && Math.abs((source.line || 0) - (evidence.line || 0)) < 40)));
  const evidenceLevel = isEntry && chainSteps.length ? 'verified' : sources.length >= 2 ? 'inferred' : 'unknown';
  const id = `cap-${roleDef.id}-${index}`;
  return {
    id,
    title: roleDef.title,
    purpose: roleDef.purpose,
    trigger: roleDef.trigger,
    input: roleDef.input,
    process: chainSteps.length
      ? chainSteps.map((step) => `${step.from} → ${step.to}（${step.file}:${step.line}）`).join('；')
      : roleDef.process,
    output: roleDef.output,
    failure: risk?.text || roleDef.failure,
    upstream: [],
    downstream: [],
    sources,
    evidenceLevel,
    confidenceLabel: evidenceLevel === 'verified' ? '源码+调用链可确认' : evidenceLevel === 'inferred' ? '基于真实符号的推断' : '功能待确认',
    category: roleDef.category,
    relatedModules,
    chainId: chain?.id || null,
    symbolCount: symbols.length,
    symbols: symbols.slice(0, 8).map((symbol) => ({ name: symbol.name, file: symbol.file, line: symbol.line })),
    evidence: sources,
    generatedAt: nowIso(),
  };
}

export function buildCapabilities(knowledge) {
  const symbols = (knowledge.symbols || []).filter((symbol) => symbol.kind !== 'prototype' && !symbol.vendored);
  const groups = new Map();
  const unknownGroups = new Map();
  for (const symbol of symbols) {
    const role = roleOf(symbol.name);
    if (role) {
      const list = groups.get(role.id) || { role, symbols: [] };
      list.symbols.push(symbol);
      groups.set(role.id, list);
      continue;
    }
    const tokens = featureTokens(symbol.name);
    const key = tokens[0];
    if (!key) continue;
    const list = unknownGroups.get(key) || [];
    list.push(symbol);
    unknownGroups.set(key, list);
  }

  const capabilities = [];
  for (const [roleId, group] of groups.entries()) {
    if (!group.symbols.length) continue;
    capabilities.push(capabilityFromGroup(knowledge, group.role, group.symbols, capabilities.length));
  }
  for (const [key, list] of unknownGroups.entries()) {
    if (list.length < 2 || capabilities.length >= 6) continue;
    capabilities.push(capabilityFromGroup(knowledge, null, list, capabilities.length));
  }
  // Guarantee an entry capability even when no symbol matched a known role.
  if (!capabilities.some((capability) => capability.evidenceLevel === 'verified')) {
    const entry = (knowledge.entryPoints || []).find((item) => item.kind === 'program-entry') || knowledge.entryPoints?.[0];
    if (entry) {
      const symbol = symbols.find((item) => item.name === entry.name && item.file === entry.file)
        || symbols.find((item) => item.name === entry.name);
      if (symbol) {
        const cap = capabilityFromGroup(knowledge, ROLE_DEFS.find((role) => role.id === 'startup'), [symbol], capabilities.length);
        capabilities.unshift(cap);
      }
    }
  }
  capabilities.sort((left, right) => {
    const rank = { verified: 0, inferred: 1, unknown: 2 };
    return (rank[left.evidenceLevel] - rank[right.evidenceLevel]) || right.symbolCount - left.symbolCount;
  });
  const limited = capabilities.slice(0, 6);

  const symbolToCapability = new Map();
  for (const capability of limited) {
    for (const symbol of capability.symbols) symbolToCapability.set(`${symbol.file}:${symbol.name}`, capability.id);
  }
  const edges = [];
  const seen = new Set();
  for (const capability of limited) {
    for (const symbol of capability.symbols) {
      const definition = (knowledge.symbols || []).find((item) => item.name === symbol.name && item.file === symbol.file);
      for (const call of definition?.calls || []) {
        const targetKey = [...symbolToCapability.keys()].find((key) => key.endsWith(`:${call.name}`));
        if (!targetKey) continue;
        const targetId = symbolToCapability.get(targetKey);
        if (!targetId || targetId === capability.id) continue;
        const edgeKey = `${capability.id}->${targetId}`;
        if (seen.has(edgeKey)) continue;
        seen.add(edgeKey);
        edges.push({ id: edgeKey, from: capability.id, to: targetId, label: '调用', evidence: { file: definition.file, line: call.line, symbol: call.name } });
      }
    }
  }
  for (const edge of edges) {
    const from = limited.find((capability) => capability.id === edge.from);
    const to = limited.find((capability) => capability.id === edge.to);
    if (from && !from.downstream.includes(edge.to)) from.downstream.push(edge.to);
    if (to && !to.upstream.includes(edge.from)) to.upstream.push(edge.from);
  }

  const entryCapability = limited.find((capability) => capability.evidenceLevel === 'verified') || limited[0] || null;
  const categoryRank = { command: 0, network: 1, control: 2, ui: 3, storage: 4, concurrency: 5, status: 6, startup: 7, unknown: 8 };
  const flow = [];
  if (entryCapability) {
    flow.push({ id: entryCapability.id, title: entryCapability.title, purpose: entryCapability.purpose, evidenceLevel: entryCapability.evidenceLevel, sources: entryCapability.sources });
    const downstream = entryCapability.downstream
      .map((id) => limited.find((capability) => capability.id === id))
      .filter(Boolean)
      .sort((left, right) => (categoryRank[left.category] ?? 9) - (categoryRank[right.category] ?? 9));
    let cursor = downstream[0] || null;
    const seenFlow = new Set(flow.map((item) => item.id));
    while (cursor && flow.length < 6 && !seenFlow.has(cursor.id)) {
      seenFlow.add(cursor.id);
      flow.push({ id: cursor.id, title: cursor.title, purpose: cursor.purpose, evidenceLevel: cursor.evidenceLevel, sources: cursor.sources });
      const nextId = cursor.downstream.find((id) => !seenFlow.has(id));
      cursor = nextId ? limited.find((capability) => capability.id === nextId) : null;
    }
    if (flow.length === 1) {
      const business = limited
        .filter((capability) => capability.id !== entryCapability.id && capability.category !== 'unknown')
        .sort((left, right) => (categoryRank[left.category] ?? 9) - (categoryRank[right.category] ?? 9))[0];
      if (business) flow.push({ id: business.id, title: business.title, purpose: business.purpose, evidenceLevel: business.evidenceLevel, sources: business.sources });
    }
  }
  return {
    generatedAt: nowIso(),
    nodes: limited,
    edges,
    flow,
    stats: { capabilities: limited.length, verified: limited.filter((item) => item.evidenceLevel === 'verified').length, symbols: symbols.length },
    note: limited.length
      ? '功能节点由真实符号、调用点与调用链组合；字段中的业务解释属于推断，已用 evidenceLevel 标注。'
      : '没有找到足够证据形成功能节点；请先查看源码结构。',
  };
}

export function capabilityForModule(capabilities, module) {
  if (!capabilities?.nodes?.length) return null;
  return capabilities.nodes.find((capability) => (capability.sources || []).some((source) => source.file.startsWith(`${module.path}/`) || source.file === module.path))
    || capabilities.nodes.find((capability) => (capability.relatedModules || []).includes(module.name))
    || null;
}

export function capabilitySummaryLine(capability) {
  if (!capability) return '';
  return `${capability.title}：${oneLine(capability.purpose, 120)}`;
}

export { ROLE_DEFS, tokensOf, featureTokens, roleOf };
