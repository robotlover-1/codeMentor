# CodeMentor v3 — Capability-first Project Mentor

把代码仓库转化为**先讲功能、再讲流程、最后落到源码**的工程训练环境。CodeMentor 是 DeepSeek Harness（DSH）的 Cordis 插件，不修改 Agent Loop，不重复实现文件读取、搜索、终端、模型调用与会话持久化。

- 包：`@local/codementor` **3.0.0**
- 形态：Host 插件（8 个工具 + 提示段 + 项目/源码/教学/面试 API）+ Client 面板
- 数据：`~/.dsh/codementor`（可用 `dataDir` 覆盖），**不写入业务仓库**
- 测试：**45 passed, 0 failed**

---

## 1. v3 核心变化

v2 已经具备项目导入、源码树、交互面试；v3 解决“内容仍以文件/符号为中心”的问题。

| 问题 | v3 实现 |
|---|---|
| 首页像目录清单 | 新增**能力图**：按真实符号、调用点与调用链聚合“能完成什么事”；目录/依赖/重要度折叠到技术详情 |
| 模块介绍是符号拼接 | 模块叙事改为 `功能标题 + 目的 + 触发 + 输入/输出 + 失败 + 证据`；正文不再出现“包含 A、B 等符号” |
| 调用链硬凑 | 删除 `|| chains[0]`；只有链节点真正属于本模块才使用 `trace`，否则改用观察/数据流/输入输出活动 |
| 课程千篇一律 | 每种能力有独立活动：命令（合法/非法输入）、控制（目标/反馈/限幅）、网络（请求/半包）、存储（保存/重启/损坏）、并发（交接/积压）、启动（顺序/失败）等 |
| 函数解释只有签名 | 新增 `explain/function`：模型解释“做什么、何时调用、输入输出、步骤、失败、副作用”，附源码片段和证据；无模型时给保守回退，绝不编造 |
| 首页技术细节过多 | 功能卡只显示标题/目的/输入→输出/查看实现；技术细节、模块、claims 折叠 |
| 实践像静态找 Bug | 改为 **A 观察 → B 定位 → C 复现 → D 小改 → E 验证**；环境不可运行明确标为阻塞；静态信号只进入 D 候选 |
| 内容质量缺测试 | 新增能力/叙事/课程/教学缓存/实践阶段测试，并检查“不得出现符号清单”“不得借用无关链路” |

---

## 2. 快速开始

### 安装

```text
plugin_manager action=install_bundle target="C:/Users/28935/Documents/deepseek-harness/default-workspace/codementor"
```

修改 Host 代码后：

```text
plugin_manager action=set_plugin target=include:codementor enabled=false
plugin_manager action=set_plugin target=include:codementor enabled=true
```

修改 `client.js` 后需刷新浏览器页面。

### 面板

1. 侧边栏打开 **CodeMentor**。
2. 输入本地目录（如 `C:\work\project`）→ 导入并扫描。
3. 首页先看“能完成什么事”的能力卡与典型流程；点“查看实现”展开触发、处理、失败与源码。
4. 点“开始第一课”进入差异化课程；课程步骤包含观察、阅读、必要时追踪真实链路、检查失败分支、回答理解问题。
5. “源码”页可看真实文件；“解释本函数”生成语义解释。
6. “实践”页按 A–E 阶段推进。
7. “面试”页输入回答，获得语义点评、纠错和基于回答的追问。

---

## 3. 能力图模型

```json
{
  "id": "cap-command-1",
  "title": "接收并执行控制命令",
  "purpose": "把外部输入解析成具体动作，再交给对应处理函数执行。",
  "trigger": "上位机、串口或操作界面发来一条命令时",
  "input": "命令文本与参数",
  "process": "main → cmd_dispatch（Core/Src/main.c:249）；cmd_dispatch → cmd_set_time（Core/Src/cmd_handler.c:856）",
  "output": "执行对应动作，并可能返回处理结果或状态变化",
  "failure": "未知命令、参数缺失或参数越界时的处理分支",
  "upstream": [],
  "downstream": ["cap-control-3"],
  "sources": [
    {"file": "Core/Src/cmd_handler.c", "line": 849, "symbol": "cmd_dispatch"},
    {"file": "Core/Src/cmd_handler.c", "line": 242, "symbol": "cmd_set_time"}
  ],
  "evidenceLevel": "inferred",
  "relatedModules": ["Core/Src"],
  "category": "command"
}
```

- 节点来自**真实符号 + 调用边 + 调用链**，不按目录命名。
- `evidenceLevel`：`verified`（入口/调用链可确认）、`inferred`（基于真实符号与调用关系的推断）、`unknown`（仅命名证据）。
- 业务职责/触发/输入输出属于教学推断，不冒充源码事实；`process` 中引用真实 `file:line`。
- 一个能力可跨文件/目录；一个文件可服务多个能力。
- 首页只显示 `title + purpose + 输入→输出`；其余在“查看实现”中。

### 能力合成

1. 只使用项目内已解析符号（排除 prototype、第三方）。
2. 按函数名主 token 映射到能力族：命令、控制、网络、存储、时间、定时/中断、总线、状态/告警、启动、界面。
3. 未命中能力族的函数按主特征 token 聚合；少于 2 个符号不单独成节点。
4. 入口符号确保生成 `verified` 的“启动与初始化”。
5. 用调用边连接能力；流程优先选择业务能力（命令/网络/控制），而不是固定目录顺序。

---

## 4. 内容引擎三层

| 层 | 实现 | 特点 |
|---|---|---|
| 证据层 | `analyze.js` / `parse.js` / `capabilities.js` | 确定性；每个节点带 `sources`；无证据写 unknown |
| 教学层（模型） | `teaching.js` + `reviewer.js` 的 `complete()` | 独立 prompt、超时、JSON 校验、证据校验、缓存、降级 |
| 展示层 | `mentor.js` / `client.js` | 新人语言；技术细节折叠；不新增事实 |

### 模型讲解缓存

- 缓存键：`projectId + commit + dirtyCount + module/symbol id + 文件 mtime/size + level + model + prompt version`。
- 模型输出中的 `file:line` 必须命中当前知识索引，否则移入 `rejectedEvidence`，不显示为事实。
- 文件/Commit/模型变化自动失效；页面刷新不重复调用模型。
- 无模型/失败/JSON 非法 → 保守回退，并明确标注“未使用模型”。

### 函数解释

```json
{
  "oneLine": "一句话说明完成什么操作",
  "when": "谁在什么场景触发",
  "inputOutput": "参数业务含义、返回/修改状态",
  "steps": ["按条件分支的执行步骤"],
  "failure": "失败返回/回退/资源释放",
  "sideEffects": "副作用或状态变化",
  "relation": "在功能链中的位置",
  "uncertainties": ["宏/函数指针/外部依赖待核实"],
  "evidence": [{"file": "Core/Src/rtc.c", "line": 145}],
  "source": "model | fallback"
}
```

无模型时只给可确认内容（签名、调用方、被调用方），不写“大概率做了什么”。

---

## 5. 差异化课程

每课结构：

```json
{
  "lessonTitle": "接收并执行控制命令",
  "capabilityId": "cap-command-1",
  "expectedOutcome": "能说明一条命令从输入、解析、校验到执行的完整分支……",
  "conceptExplanation": "这个功能解决什么问题，触发时机、输入、输出……",
  "walkthrough": [
    {"kind": "observe", "title": "先观察一条真实命令", "action": "发送合法/未知命令并记录", "expected": "合法有动作，非法进错误分支", "evidence": [{"file": "...", "line": 249}]},
    {"kind": "read", "title": "阅读推荐入口", "action": "打开函数边界、参数与返回", "evidence": [...]},
    {"kind": "trace", "title": "沿真实调用点走一遍", "evidence": [...]},
    {"kind": "inspect", "title": "检查解析与校验分支", "action": "...", "expected": "..."}
  ],
  "checkQuestions": ["合法/未知命令分别走哪条分支？", "参数非法时返回、默认还是忽略？"],
  "microTask": {"title": "记录一次命令处理", "action": "...", "acceptance": "..."},
  "acceptance": ["...", "...", "..."],
  "next": {"type": "lesson", "lessonId": "lesson:core-inc"}
}
```

- **只有链节点属于该模块**时才加入 `trace`；否则使用观察、数据流、输入输出或失败分支活动。
- 活动按能力类别不同：命令/控制/网络/存储/并发/启动/界面/未知。
- 课程路线：了解项目 → 运行观察（可阻塞）→ 业务流程 → 模块机制 → 小改验证 → 面试表达。

---

## 6. 实践 A–E

| 阶段 | 目标 | 输出 |
|---|---|---|
| A 观察 | 运行最小功能，记录真实输入/输出；不能运行时明确写环境阻塞 | 命令、退出码、观察记录 |
| B 定位 | 从场景找到入口、调用路径、失败分支 | 带 `file:line` 的路径 |
| C 复现 | 构造正常/异常输入，记录实际差异 | 最小复现步骤 |
| D 小改 | 用户授权后做最小改动；静态信号只作为候选 | Diff、修改前检查 |
| E 验证 | 构建/测试/Diff 审查；未执行为阻塞/未覆盖 | 真实结果与剩余风险 |

- 候选风险不是已确认 Bug；D 阶段必须先核对源码/需求。
- 长函数、TODO、忽略返回值等信号只进入候选，不作为首页任务。
- 真正修改/执行仍在 `codementor_practice` 工具中，需 `authorized=true`。

---

## 7. API

写操作需要 `x-codementor-action: 1` + `content-type: application/json`；携带 `Origin` 时必须同源。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/codementor/state` | 插件/项目/评审器状态 |
| GET | `/api/codementor/projects` | 已导入项目 |
| POST | `/api/codementor/projects/scan` | `{path}` 导入扫描 |
| GET | `/api/codementor/project?id=` | 首页/能力/课程/实践/面试视图 |
| POST | `/api/codementor/project/refresh` | 增量刷新 |
| GET | `/api/codementor/capabilities?projectId=` | 能力图 |
| GET | `/api/codementor/tree?projectId=` | 文件树 |
| GET | `/api/codementor/file?projectId=&path=&start=&end=` | 真实源码范围 |
| GET | `/api/codementor/symbol?projectId=&symbolId=` | 符号技术元数据 |
| POST | `/api/codementor/explain/function` | 语义函数解释（缓存/回退） |
| POST | `/api/codementor/teaching/module` | 模块/功能导师讲解（缓存/回退） |
| GET | `/api/codementor/lessons?projectId=` | 课程/路线/进度 |
| POST | `/api/codementor/lesson/update` | 开始/完成课程（完成需证据） |
| POST | `/api/codementor/learning/save` | 收藏源码位置 |
| POST | `/api/codementor/interview/start` | 开始面试 |
| GET | `/api/codementor/interview?projectId=` | 当前题/历史/报告 |
| POST | `/api/codementor/interview/answer` | 提交回答（语义评审+追问） |
| POST | `/api/codementor/interview/finish` | 结束本轮 |
| POST | `/api/codementor/practice/review` | 实践解释评审 |

---

## 8. 安全

- 项目只从 `ProjectRegistry` approved root 解析；客户端只传 `projectId`。
- 文件路径拒绝 `..`、绝对路径、NUL；realpath 后再次校验；符号链接逃逸拒绝。
- 拒绝 `.env`、私钥、证书、keystore；单文件 ≤2 MiB、单次 ≤600 行。
- 写请求同源 + action 头 + JSON；跨站 `Sec-Fetch-Site` 拒绝；请求体 ≤512 KiB。
- 模型只在 Host 调用：浏览器无 Key；只发送题目/回答/证据片段，不发送整仓库。
- 源码与 README 是不可信数据，不作为指令执行。
- 修改、终端、Git 写操作仍需显式授权；不自动提交/推送。

---

## 9. 真实仓库验收

仓库：`C:\Users\28935\Desktop\pp\批量转台球式\自研开发板STM32F407`（C / Keil / IAR / CubeMX）。

| 验收 | 实测 |
|---|---|
| 能力图 | 6 个节点：启动与初始化（verified）、接收并执行控制命令、状态监测与告警、闭环运动控制、定时与中断节拍、时间维护与 RTC（inferred） |
| 流程 | 启动与初始化 → 接收并执行控制命令 → 闭环运动控制 → 时间维护与 RTC |
| 功能卡 | 标题/目的/输入→输出；不出现目录名或符号数量 |
| 模块叙事 | 不出现“包含 … 等符号”；无证据模块显示“功能待确认” |
| 课程 | Core/Inc 无相关链路 → 不使用 trace；启动/命令/控制课程的活动与问题不同 |
| 实践 | A 阶段因 Keil 不可自动运行而 `blocked`；D 候选全部标注 candidate |
| 函数解释 | 无模型测试为 fallback；真实模型路径已验证结构化 JSON + 证据过滤 |
| 面试 | v2 语义面试保持；错误回答被指出偏离题目并生成不同追问 |
| 源码 | 树 1678 项；`Core/Src/main.c` 真实行；越界路径 403 |
| 模型讲解 | 单元测试验证缓存：第二次不调用模型；文件 mtime 变化后失效 |

> 未执行 Keil 构建；UI 没有浏览器级自动化/像素验收；需要刷新页面加载 v3 客户端。

---

## 10. 测试

```bash
node tests/run.mjs
node --check client.js
```

**45 passed, 0 failed**。新增覆盖：

- 能力图：来源命中、非目录镜像、证据等级、流程节点有效
- 叙事：禁止“包含…等符号”、未知模块标待确认
- 课程：无无关链路 fallback、每课有独特问题/任务/验收
- 教学：模型 JSON 解析、证据过滤、缓存命中、证据变化失效、无模型回退
- 实践：A–E 阶段、环境阻塞、候选风险不等于确认 Bug
- API：能力/教学/函数解释/项目/源码/课程/面试
- 真实仓库：能力标题/流程/课程/阻塞/回退解释

---

## 11. 已知限制与回滚

1. 能力合成是确定性的功能族映射；未知项目会出现“功能待确认”，不会编造业务。
2. 模型讲解按需触发；首页不阻塞。无模型时只给证据版回退。
3. 函数解释依赖源码片段；宏/函数指针/复杂条件编译可能标注待核实。
4. 课程需要真实输入协议；证据不足时 C 阶段会标阻塞，而不是伪造命令。
5. 未实现 UI 内修改/执行；这些走工具 + 显式授权。
6. 文件树包含第三方目录；受 6000 节点上限保护。
7. 浏览器需刷新才能加载新 client bundle；Host 需禁用/启用或重启。

回滚：上一版 v2 为 `0e938c7`；可 `git revert` 本次提交，或 `git checkout 0e938c7 -- .` 后重新安装。知识缓存 schema 兼容，必要时删除 `~/.dsh/codementor`。

---

## 12. 开发

不引入第三方依赖；不修改 DSH 核心；不直接写 profile 的 `package.json` / `cordis.patch.yml`。图标 `icon.svg` 为原创 SVG。
