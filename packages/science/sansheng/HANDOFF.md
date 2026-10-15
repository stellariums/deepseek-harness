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
| `tests/ustc.e2e.ts` | 真实模型试点（需 key，约 30 分钟），把逐步轨迹写入 `$SANSHENG_TRACE` |

已验证的设计决定：
- 审查发现按路径文本匹配有多种 Windows 绕过，因此**改为结构隔离**：中书和门下不写任何文件，经 `structured_output` 提交；门下只看插件放进提示词的圣旨、转译与封存方案。
- 子 Agent 的 SessionId 预先保留（`childId`），在子 Agent 运行前就绑定好角色，没有竞态。
- 每个省在派出时用 `toolFilter` 隐藏它永远不能用的工具，避免模型在拒绝上浪费步数。

## 3. 真实模型试点结果（第 7 轮）

任务：统计 1 到 10000 的素数（答案 1229）。从下旨走到执行，用时约 28 分钟。

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

## 4. 未完成（按优先级）

1. **给尚书加载 shell 再跑完整试点。** `tests/ustc.e2e.ts` 的 `boot()` 只加载了 `ToolFs`，需要再加载 pwsh 工具与执行器（参考 `packages/subagent/subagent-spawn-in-process/tests/harness.ts`，Windows 上用 pwsh，不用 bash）。目标：把执行、验收、复命也走完。
2. **约束中书的方案规模。** 在 `src/prompts.ts` 的 `PERSONAS.zhongshu` 加上"方案与验收标准的规模须与任务相称，回应封驳时修正而非叠加条款"。另外，`draftPrompt` 目前只传给中书**最近一次**封驳意见，可以考虑附上一版方案，让它在原方案上修订，而不是重写。
3. **在 dsh 网页界面里实际使用。** 命令写在 `profile/sansheng.patch.yml` 的注释里。需要确认：`/xiazhi`、`/zhupi`、`/zouzhe` 在网页的斜杠命令菜单里出现；`dshHomePath('sansheng')` 能正确解析；`DSH_HOME` 在 E 盘（见第 6 节）。还没有人在网页界面里跑过。
4. **性能。** 一个小课题要 30 分钟以上，主要花在门下推理和多轮封驳上。可选做法：门下设推理强度上限（`agentOptions.reasoningEffort`）；或者门下封驳时必须区分"致命"和"建议"，只有致命问题才算封驳。
5. **门下验收时的读权限。** 现在门下验收时可以用 shell，能读到整个工作区，这是 MVP 里有意接受的漏洞：这时方案已经定稿，不影响审核的独立性。如果要收紧，可以让验收在一个只读副本里跑。
6. **执行完成的硬校验。** 现在尚书说 `done` 就进入验收，由门下复核。可以加一条：验收前由插件按锁定的验收标准，检查列出的交付物文件是否存在。
7. **暂缓的功能**（MVP 有意不做）：T0/T1/T2 分级通道、预算与超时熔断、修正案的轻量审核、跨课题引用、为审核者单设一个独立的验收司。

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
