# 三省制 Agent 治理插件 · 交接文档

更新于 2026-10-15。分支 `sansheng-mvp`，基于 deepseek-harness（dsh）`0.2.1-alpha.2`。

## 1. 目标

科研用多 Agent 系统，核心是**权力制衡**：Agent 能高效协作，但不能通过信息垄断、相互串通或自改规则架空人类决策者。

| 角色 | 实现 | 权力 | 禁止 |
|---|---|---|---|
| 皇帝（用户） | 人 | 唯一的批准、否决、推翻权 | — |
| 太监 | 根会话 Agent | 转译、调度三省、汇报 | 批准、改写各省意见、读写记录 |
| 中书 | 子 Agent | 起草研究方案与验收标准 | 写文件、执行、看门下 |
| 门下 | 子 Agent（不同厂商模型） | 审核/封驳、按锁定标准验收 | 改方案、写文件、看中书推理 |
| 尚书 | 子 Agent，可再派子 Agent | 决定"怎么做"、写工作区 | 改目标、改验收标准、自己验收 |

四条底线：朱批只能出自用户本人；中书门下隔离且用不同模型；验收标准朱批后锁定；原件永远可查。

## 2. 已完成（全部已提交）

代码在 `packages/science/sansheng/`，118 个单元/集成测试通过，src 覆盖率 100%，tsc 与 oxlint 通过。

| 文件 | 职责 |
|---|---|
| `src/state.ts` | 宫规状态机（纯 reducer）。10 个阶段、16 种事件，每个事件规定允许的阶段与触发者；封驳上限 k=2、返工上限 N=2，超限自动交皇帝；朱批绑定方案哈希；ledger 重放时做运行时校验 |
| `src/policy.ts` | 门禁（纯函数，白名单）。记录存放在工作区外的受保护目录，任何 Agent 不可读写；只有尚书在 executing 阶段能写工作区；shell 只给执行中的尚书和验收中的门下；路径经 realpath 规范化，Windows 别名写法（`\\?\`、8.3 短名、尾随点/空格、`::$`、驱动器相对路径）直接拒绝 |
| `src/store.ts` | 账本。每个课题一个目录：`_ledger.jsonl` 只追加，文档一次写入并记哈希，读取时校验；同课题转换串行化 |
| `src/tools.ts` | 太监的工具：`sansheng_status/translate/draft/review/execute/accept`。每个工具先查状态机，再用该省的模型、persona、structured-output schema 派出子 Agent，最后把结果提交为下一次转换 |
| `src/commands.ts` | 只有人能触发的命令：`/xiazhi <标题> \| <圣旨>` 下旨，`/zhupi <课题> 准\|驳 <意见>\|否` 朱批，`/zouzhe [课题]` 绕过太监直接看奏折 |
| `src/memorial.ts` | 奏折由代码按账本生成，各省摘要原文呈现，太监无法合并分歧 |
| `src/prompts.ts` | 各省 persona、structured-output schema、任务提示 |
| `src/index.ts` | 插件入口。`ctx.tools.guard` 对每次工具调用执行门禁；子 Agent 继承最近祖先的角色绑定（尚书的子 Agent 仍受尚书约束，已有测试）；孤儿 Agent 一律拒绝 |
| `profile/*.yml` | dsh 启动叠加配置（模型路由、插件挂载） |
| `profile/probe_models.py` | 网关模型工具调用探测脚本 |
| `tests/ustc.e2e.ts` | 真实模型全流程试点（需 key，约 21 分钟）：从下旨到结案，尚书有 pwsh shell；断言 `result.txt` 存在且含正确答案；逐步轨迹写入 `$SANSHENG_TRACE` |

已验证的设计决定：
- 审查发现按路径文本匹配有多种 Windows 绕过，因此**改为结构隔离**：中书和门下不写任何文件，经 `structured_output` 提交；门下只看插件放进提示词的圣旨、转译与封存方案。
- 子 Agent 的 SessionId 预先保留（`childId`），在子 Agent 运行前就绑定好角色，没有竞态。
- 每个省在派出时用 `toolFilter` 隐藏它永远不能用的工具，避免模型在拒绝上浪费步数。

## 3. 真实模型试点结果

### 第 8 轮（2026-10-15，shell 已加载，全流程走通）

任务同下。从下旨到结案，用时约 21 分钟，测试断言全过。

- 挂载链：`subprocess-local → shell-env → pwsh-local 执行器（提供 ctx.shell）→ tool-pwsh`，已写进 `tests/ustc.e2e.ts` 的 `boot()`。
- 全流程：下旨 → 转译 → 朱批确认 → 中书 v1 → 门下封驳 → 中书 v2 → 门下通过 → 朱批 → 尚书执行 → 门下验收通过 → 复命 → 结案。
- 尚书这次有 shell，用 pwsh 交付四件：`prime_count.py`、`result.txt`、`execution_log.txt`、`conclusion.md`。
- 门下封驳再次言之有物：指出 v1 验收标准 P7/C5 要求 [1,9999] 计数 ≠ 1229，但 10000 是合数、π(9999) 本就该等于 1229，任何正确实现必验收失败；中书 v2 改为 [1,10007] → 1230 后通过。
- 门下验收做了真实复核：独立重跑（退出码 0）、源码审计确认无 1229 硬编码写盘、`result.txt` 字节级为 `1229\n`、PowerShell 独立试除重算。测试也断言了 `result.txt` 存在且含 1229。
- 遗留观察：验收标准仍写到 P1–P10、C1–C8、I1–I5，中书规模问题（第 4 节第 2 项）未做；全程 21 分钟，性能问题（第 4 节第 4 项）仍在。

### 第 7 轮（shell 未加载，走到执行为止）

- 转译、确认、拟旨、三轮封驳、自动转为争议、推翻门下、准奏、执行，全部按宫规发生。
- 门下的封驳言之有物，例如指出 sympy 被误称为"标准库"、验收标准之间自相矛盾。
- 尚书没有 shell（测试环境未加载），于是上报偏差、拒绝伪造日志。这是期望行为。
- 中书把小任务越做越复杂（A1 到 A12、B1 到 B8 条验收），每次被封驳都加条款。

模型分配（`USTC_LLM_API_KEY`，网关 `https://api.llm.ustc.edu.cn/v1`，OpenAI 兼容）：

| 角色 | 模型 | 实测 |
|---|---|---|
| 太监、中书 | `deepseek-flash` | 单步 3 到 20 秒；拟一份方案 1.5 到 3 分钟 |
| 门下 | `qwen3.8-reasoner` | 单次审核 1.5 到 5 分钟（推理量大） |
| 尚书 | `qwen3.8-flash-next` | 单步 2 到 55 秒 |
| 不用 | `glm-5.3-flash` | 单次请求约 4 分钟，dsh 内两次卡死超过 10 分钟 |

### 3.5 网页界面实测（2026-10-16）

用 `profile/sansheng.patch.yml` 注释里的启动方式（修正版）在浏览器里完整实测，全部通过：

- 斜杠命令菜单里 `/xiazhi`、`/zhupi`、`/zouzhe` 三项都出现，带中文描述。
- `/xiazhi 网页试点 | …`：立课题 001，圣旨逐字存档，返回"已立课题 001"。
- `/zouzhe 001`：返回完整奏折（阶段、计数、待圣裁提示）。
- `/zhupi 001 准`（转译前）：被状态机拒绝，错误信息"朱批未录：no translation has been submitted yet"——宫规在网页通道同样生效。
- `/zhupi 001 否`：结案成功，账本记录 `{"actor":"emperor","event":{"type":"vetoed"}}`。
- 所有结果以 `command/run`/`command/done` 事件持久化在会话日志中（可用逐帧 zstd 解码验证）。

实测发现并修正了两处启动陷阱（已写进 profile 注释）：`pnpm -C` 会把进程 cwd 重置为仓库根，导致 `workspaceRoot` 覆盖整个仓库，必须从工作区目录直接启动 bin；工作区在仓库外时必须设 `TSX_TSCONFIG_PATH`，否则 tsx 把 `@deepseek-ai/cordis` 解析到 vendor lib/ 而崩溃（lib 缺 `FiberState`）。另注意：网页 UI 的工作区选择器独立于进程 cwd，纯命令会话的主区不渲染 flow node。

## 4. 未完成（按优先级）

1. **性能（实测数据见第 3 节）。** 已做规模约束：中书 persona 要求方案与任务相称、修订而非叠加；重拟时把上一版方案附进提示词（见 `draftPrompt` 的 `previousPlan`）。**不做**降低门下推理强度的方案——审核深度是治理层的立身之本，第 8 轮正是深推理抓到了 π(9999) 的数学错误。若仍需提速，考虑并行化（如转译与预读）或换更快的审核模型（需重新验证审核质量）。
2. **网页界面的会话视图体验。** 命令结果只以 `command/run`/`command/done` 会话事件持久化（设计如此），但纯命令会话在网页主区不渲染 flow node，用户只能靠 toast 一瞬或翻会话日志确认结果（见第 3.5 节）。若要改善，属于 dsh 上游客户端的展示问题，不是本插件的问题。
3. **门下验收时的读权限。** 现在门下验收时可以用 shell，能读到整个工作区，这是 MVP 里有意接受的漏洞：这时方案已经定稿，不影响审核的独立性。如果要收紧，可以让验收在一个只读副本里跑。
4. **执行完成的硬校验。** 现在尚书说 `done` 就进入验收，由门下复核。可以加一条：验收前由插件按锁定的验收标准，检查列出的交付物文件是否存在。
5. **暂缓的功能**（MVP 有意不做）：T0/T1/T2 分级通道、预算与超时熔断、修正案的轻量审核、跨课题引用、为审核者单设一个独立的验收司。

## 5. 已知风险

- dsh 是 developer preview，会有破坏兼容的改动。本插件只通过公开的扩展点接入，没有改 dsh 的核心代码，只在根目录 `tsconfig.base.json` 和 `tsconfig.host.json` 各登记了一行。
- `ctx.tools.guard` 只管工具调用。shell 命令内部做什么，靠的是 dsh 的写沙箱，以及"记录放在工作区外"这个设计。
- 网页服务没有鉴权（dsh 本身如此）。`/zhupi` 能保证是人发起的，前提是只有你能访问这个网页界面。

## 6. 环境与操作（重要）

- **C 盘空间紧张，所有东西都必须放在 E 盘。** 每次执行命令前先运行 `source .local/env.sh`，它会把 TEMP、`DSH_HOME`、`PNPM_HOME` 和各类缓存重定向到 `E:\Science-harness\.local\`（这个目录不进 git）。
- key 放在 `.local/secrets.env`（`export USTC_LLM_API_KEY=...`），不进 git。这个 key 曾经在聊天记录里出现过，建议到平台上重新生成一个。
- 单元测试：`pnpm vitest run packages/science/sansheng`（加 `--coverage --coverage.include='packages/science/sansheng/src/**'` 检查覆盖率是否为 100%）。
- 类型检查：`node ./node_modules/typescript/bin/tsc -b packages/science/sansheng`。lint：`pnpm exec oxlint packages/science/sansheng`。
- 真实试点：`source .local/env.sh && source .local/secrets.env && SANSHENG_TRACE='E:\Science-harness\.local\tmp\trace.log' pnpm vitest run --config vitest.e2e.config.ts packages/science/sansheng/tests/ustc.e2e.ts`。vitest 会缓存控制台输出，要看进度就去看 trace 文件。
- 在 Windows 上终止残留的 vitest 进程：`powershell -Command "Get-CimInstance Win32_Process | ? { $_.CommandLine -match 'vitest' -and $_.CommandLine -match 'Science-harness' } | % { Stop-Process -Id $_.ProcessId -Force }"`（没有 pkill）。
- 仓库规则见根目录的 `AGENTS.md`：每个文件覆盖率 100%，每处 `v8 ignore` 都要写明理由；提交信息用 conventional commits 格式；pre-commit hook 由 lefthook 执行。
