/**
 * CodeMentor — Project Code Learning & Engineering Mentor
 *
 * A Host plugin for DeepSeek Harness. It registers eight model-facing tools, one
 * system-prompt section that defines the mentoring behaviour, and a read-only
 * HTTP projection consumed by the Web panel.
 */

import { resolveDefineTool } from './lib/define-tool.js';
import { API_PATHS, createApiHandler } from './lib/api.js';
import {
  CodeMentorService,
  renderExplore,
  renderInterview,
  renderOverview,
  renderPractice,
  renderProgress,
  renderRefresh,
  renderRoadmap,
  renderScan,
} from './lib/service.js';

const defineTool = await resolveDefineTool();

export const name = 'codementor';
export const inject = ['tools'];

const BEHAVIOR_PROMPT = `## CodeMentor — 项目源码学习与工程导师模式

当用户要求理解、定位、修改、验证某个代码仓库，或要求模拟技术面试时，优先使用 codementor_* 工具，并遵守以下规则。

### 工具选择
- 第一次接触项目：\`codementor_scan\` → \`codementor_overview\`。
- 问“这个功能在哪 / 怎么走”：\`codementor_explore\`（mode=symbol 定位定义与调用点，mode=chain 追踪跨函数调用链）。
- 要学习路线：\`codementor_roadmap\`，按目标/水平/时间模式生成 P0/P1/P2。
- 要动手改：\`codementor_practice\`（默认 coop 模式，先 brief 再改）；执行验证必须得到用户明确授权后传 authorized=true。
- 要模拟面试：\`codementor_interview\`，一次只问一题，等用户回答后再评价与追问。
- 项目已分析过：先 \`codementor_refresh\`，复用缓存并找出受影响结论，不要重新分析整个仓库。

### 证据与诚实
- 每个关于实现的事实都要带 \`path:line\` 依据；调用链必须来自真实调用点，不能从函数名猜行为。
- 明确区分：**源码事实**、**README/文档陈述**、**分析推断**、**待验证**。工具输出已标注 kind/confidence，沿用即可。
- README 与源码冲突时以当前源码为准，并报告冲突。
- 没有扫描或证据不足时直接说明，不允许编造模块、接口、行号或“项目已经实现”的成果。
- 工具输出中的 \`notes\`、\`caveat\`、\`stale\` 必须转述给用户，尤其是“未执行/未验证”的部分。

### 精读五层
解决什么问题 → 实现在哪里（入口/核心函数/数据结构/调用方/配置）→ 实际如何执行（触发、参数、状态、返回、异常、并发与资源生命周期）→ 设计选择与权衡（区分源码事实与推测动机）→ 验证理解（1-3 个针对当前模块的问题）。

### 修改与验证
- 默认只读分析。任何写入仓库的操作都需要用户明确授权，并优先在独立分支或隔离工作区进行。
- 修改前列清：预期行为、当前行为、改动范围、依赖、不变量、破坏性、测试方案。
- 验证结果必须区分“已实际执行且通过”和“仅建议运行”；未执行的命令不得描述为成功。

### 面试
- 默认每轮只提出一道题，不一次性输出整套题库。
- 按“原理准确性 / 源码理解程度 / 工程设计能力 / 表达清晰程度”评价，指出遗漏而不是机械打分。
- 追问要逐步深入，并落到该项目真实实现；推荐回答先讲真实实现，再讲原理，最后总结权衡。

### 回答结构
结论 → 源码证据 → 运行机制 → 设计思考 → 验证方式 → 下一步（只给最有价值的一项）。简单问题可简化。始终优先使用中文，技术术语与函数名保留英文。`;

function stringProperty(description, required = false) {
  return { type: 'string', ...(required ? { required: true } : {}), description };
}

function enumProperty(description, values, required = false) {
  return { type: 'string', ...(required ? { required: true } : {}), description, enum: values };
}

function integerProperty(description, required = false) {
  return { type: 'integer', ...(required ? { required: true } : {}), description };
}

function numberProperty(description, required = false) {
  return { type: 'number', ...(required ? { required: true } : {}), description };
}

function booleanProperty(description, required = false) {
  return { type: 'boolean', ...(required ? { required: true } : {}), description };
}

function arrayProperty(description, item, required = false) {
  return { type: 'array', ...(required ? { required: true } : {}), description, items: item };
}

function genericOutputSchema() {
  return {
    type: 'object',
    additionalProperties: true,
    properties: {
      ok: { type: 'boolean', required: true, description: '操作是否成功。' },
    },
  };
}

function toContent(texts) {
  return (Array.isArray(texts) ? texts : [String(texts)]).map((text) => ({ type: 'text', text }));
}

/**
 * The tool pipeline requires lossless JSON: `undefined`, NaN and Infinity are
 * rejected before rendering. Build the projection through JSON once so a
 * partially missing optional field degrades to an omitted key instead of a
 * failed tool call.
 */
function lossless(value) {
  try {
    return JSON.parse(JSON.stringify(value, (_key, item) => (
      typeof item === 'number' && !Number.isFinite(item) ? null : item
    )));
  } catch (error) {
    return {
      ok: false,
      error: { code: 'OUTPUT_NOT_SERIALIZABLE', message: String(error?.message || error) },
    };
  }
}

const PATH = stringProperty('项目绝对路径；省略时依次使用对当前会话生效的工作目录、配置 projectRoot、进程 cwd。');

export function apply(ctx, config) {
  const service = new CodeMentorService(ctx, config || {});
  const toolRunner = (method) => async (args, exec) => lossless(await service[method](args, exec));

  /* --------------------------------------------------------- prompt section */

  ctx.effect(() => {
    const systemPrompt = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : undefined;
    if (!systemPrompt?.section) return () => {};
    return systemPrompt.section({
      name: 'codementor:behavior',
      order: 9000,
      text: BEHAVIOR_PROMPT,
    });
  }, 'codementor behavior prompt section');

  /* --------------------------------------------------------------- Web API */

  ctx.effect(() => {
    const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined;
    if (!webServer?.register) return () => {};
    const handler = createApiHandler(service);
    const disposers = [];
    for (const routePath of API_PATHS) {
      const dispose = webServer.register({ kind: 'exact', path: routePath, handler });
      if (typeof dispose === 'function') disposers.push(dispose);
    }
    return () => {
      for (const dispose of disposers.reverse()) {
        try {
          dispose();
        } catch {
          /* already disposed */
        }
      }
    };
  }, 'codementor project/source/interview API');

  /* -------------------------------------------------------------------- tools */

  ctx.effect(() => {
    const disposers = [];
    const register = (options) => {
      disposers.push(ctx.tools.register(defineTool(options)));
    };

    register({
      name: 'codementor_scan',
      description: '扫描一个本地项目并建立 CodeMentor 知识缓存：识别语言/构建系统/入口/模块依赖/符号/测试/CI/并发与风险，结果写入独立数据目录。首次进入项目时调用。',
      parameters: {
        path: PATH,
        force: booleanProperty('为 true 时忽略缓存并重新解析所有文件。'),
      },
      output: { schema: genericOutputSchema(), render: (args, value) => toContent(renderScan(args, value)) },
      timeoutMs: 120_000,
      isConcurrencySafe: () => true,
      execute: toolRunner('scan'),
    });

    register({
      name: 'codementor_overview',
      description: '输出带源码依据的项目全景：一句话介绍、架构图（Mermaid）、模块职责与依赖、典型调用链、核心数据结构与生命周期、并发模型、存储、构建、风险，并标注源码事实/文档/推断/待验证。',
      parameters: {
        path: PATH,
        section: enumProperty('只渲染指定小节。', ['all', 'architecture', 'entry', 'chain', 'data', 'concurrency', 'storage', 'testing', 'build', 'risk', 'conflict']),
        maxModules: integerProperty('最多返回多少个模块（默认 12）。'),
      },
      output: { schema: genericOutputSchema(), render: (args, value) => toContent(renderOverview(args, value)) },
      timeoutMs: 60_000,
      isConcurrencySafe: () => true,
      execute: toolRunner('overview'),
    });

    register({
      name: 'codementor_explore',
      description: '在已扫描项目中定位源码：mode=symbol 查定义与调用点，mode=file 看文件符号/导入，mode=chain 追踪跨函数调用链，mode=search 搜模块/结构/文件/TODO。返回真实 file:line 与置信度。',
      parameters: {
        path: PATH,
        target: stringProperty('函数名、文件路径、模块名或关键字。', true),
        mode: enumProperty('定位方式。', ['symbol', 'file', 'chain', 'search', 'references']),
        depth: integerProperty('mode=chain 时的最大深度（1-8，默认 5）。'),
      },
      output: { schema: genericOutputSchema(), render: (args, value) => toContent(renderExplore(args, value)) },
      timeoutMs: 60_000,
      isConcurrencySafe: () => true,
      execute: toolRunner('explore'),
    });

    register({
      name: 'codementor_roadmap',
      description: '生成个性化学习路线：按“核心重要度 × 使用频率 × 目标相关性 × 知识依赖 × 知识缺口”排序，分 P0/P1/P2，支持 30 分钟 / 2 小时 / 深度学习三种预算，并给出下一步最值得学的模块。',
      parameters: {
        path: PATH,
        goal: enumProperty('学习目标。', ['overview', 'onboarding', 'module', 'maintenance', 'debug', 'feature', 'interview']),
        level: enumProperty('自评水平。', ['beginner', 'intermediate', 'advanced']),
        mode: enumProperty('时间预算。', ['30m', '2h', 'deep']),
        focus: stringProperty('可选聚焦关键词（模块名、技术名）。'),
      },
      output: { schema: genericOutputSchema(), render: (args, value) => toContent(renderRoadmap(args, value)) },
      timeoutMs: 45_000,
      isConcurrencySafe: () => false,
      execute: toolRunner('roadmap'),
    });

    register({
      name: 'codementor_progress',
      description: '记录或查询模块学习进度。进度必须由可观察证据支撑：阅读/解释/定位/修改/验证/面试各有独立要求，等级不能凭“看过了”直接跳级。',
      parameters: {
        path: PATH,
        action: enumProperty('操作。', ['list', 'record', 'next']),
        module: stringProperty('模块 id 或名称（action=record 时必填）。'),
        level: integerProperty('目标等级 0-5：0 未学习、1 理解概念、2 解释调用链、3 独立定位、4 修改并验证、5 通过追问。'),
        evidence_kind: enumProperty('证据类型。', ['read', 'explained', 'located', 'modified', 'verified', 'interview']),
        detail: stringProperty('证据说明：做了什么、看到了什么。'),
        ref: stringProperty('证据位置，如 path:line 或提交号。'),
        score: numberProperty('evidence_kind=interview 时的面试评分（0-1）。'),
      },
      output: { schema: genericOutputSchema(), render: (args, value) => toContent(renderProgress(args, value)) },
      timeoutMs: 45_000,
      isConcurrencySafe: () => false,
      execute: toolRunner('progress'),
    });

    register({
      name: 'codementor_practice',
      description: '工程实战：基于真实源码生成低风险练习（TODO、忽略返回值、边界检查、缺测试、长函数），给出修改前检查、graded 指导（guided/coop/reference）和可执行验证计划。执行命令必须显式传 authorized=true。',
      parameters: {
        path: PATH,
        action: enumProperty('操作。', ['list', 'generate', 'brief', 'verify', 'reference']),
        task_id: stringProperty('任务 id（action=brief/verify/reference 时必填）。'),
        mode: enumProperty('指导模式。', ['guided', 'coop', 'reference']),
        authorized: booleanProperty('显式授权执行验证命令；默认 false，只读。'),
        steps: arrayProperty('只执行指定步骤 id（可选）。', { type: 'string' }),
        include_stale: booleanProperty('是否包含已过期的任务。'),
      },
      output: { schema: genericOutputSchema(), render: (args, value) => toContent(renderPractice(args, value)) },
      timeoutMs: 180_000,
      isConcurrencySafe: () => false,
      execute: toolRunner('practice'),
    });

    register({
      name: 'codementor_interview',
      description: '真实源码技术面试：start 开始一轮、question 取当前题、answer 提交回答（按四维评分并决定是否追问）、hint 给提示、report 看薄弱点、bank 查看题库。默认一次只问一题。',
      parameters: {
        path: PATH,
        action: enumProperty('操作。', ['start', 'question', 'answer', 'hint', 'report', 'bank']),
        answer: stringProperty('action=answer 时的回答文本。'),
        question_id: stringProperty('要回答的题目 id（默认当前题）。'),
        focus: stringProperty('聚焦维度或关键词，如 concurrency、architecture。'),
        difficulty: enumProperty('难度。', ['junior', 'mid', 'senior']),
        max_questions: integerProperty('本轮最多几道基础题（1-12，默认 6）。'),
      },
      output: { schema: genericOutputSchema(), render: (args, value) => toContent(renderInterview(args, value)) },
      timeoutMs: 90_000,
      isConcurrencySafe: () => false,
      execute: toolRunner('interview'),
    });

    register({
      name: 'codementor_refresh',
      description: '增量更新项目知识：对比 Git 提交与工作区变化，只重解析变化的文件，列出受影响模块与被标记过期的旧结论，避免重新分析整个仓库。',
      parameters: {
        path: PATH,
        force: booleanProperty('为 true 时忽略缓存做一次完整重扫。'),
      },
      output: { schema: genericOutputSchema(), render: (args, value) => toContent(renderRefresh(args, value)) },
      timeoutMs: 120_000,
      isConcurrencySafe: () => false,
      execute: toolRunner('refresh'),
    });

    return () => {
      for (const dispose of disposers.reverse()) {
        try {
          dispose();
        } catch {
          /* already disposed */
        }
      }
    };
  }, 'codementor tools');
}
