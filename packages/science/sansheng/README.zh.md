---
description: "三省制治理插件：围绕研究工作区的起草、审核、执行三权分立 agent，批准与否决全部保留给人，面向需要 agent 协作相互制衡的部署。"
kind: "package-reference"
---

# @deepseek-ai/dsh-sansheng

[English](README.md) | 中文

## 概述

`dsh-sansheng` 把一个研究课题交给三个相互分离的 agent 运行：起草者拟方案，独立审核者把关，执行者在可写工作区里落地。根会话只在你和三者之间传达，没有决策权。每一次批准和否决都属于你：课题只有通过你的 `/zhupi` 命令才能推进，且每次批准都按哈希绑定封存的方案。当模型驱动的工作流需要结构性制衡时选择它；单会话任务保持更简单也更快。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与暂缓工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当研究工作区需要受治理的多 agent 执行时挂载本插件。常见路径：用 `/xiazhi` 立课题，让根会话转译，驱动三省推进，每次待决事项用 `/zhupi` 裁定。

### 何时选择它

当一个 agent 自己拟方案、自己审核、自己执行的风险不可接受时选择它：这里起草者与审核者运行在不同模型上，彼此看不到对方的推理，记录存放在所有 agent 都够不到的地方，即使会话被攻破也能留存。快速的单会话任务不要用它：即使小课题，审核轮次也会增加数分钟。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-sansheng'
  config:
    storeRoot: /absolute/path/outside/the/workspace
    workspaceRoot: /absolute/path/of/the/research/workspace
    protectedRoots: [/absolute/path/of/the/harness-home]
    provider: spawn
    routes:
      zhongshu: { provider: my-llm, model: planner-model }
      menxia: { provider: my-llm, model: reviewer-model }
      shangshu: { provider: my-llm, model: executor-model }
```

`storeRoot` 必须位于 `workspaceRoot` 之外，也不得落在 `protectedRoots` 的任何条目之内；工具门禁拒绝任何 agent 对保护根的读写，因此没有会话能碰到记录。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `storeRoot` | 必填 | 账本与封存文档的记录目录；任何 agent 不得读写 |
| `workspaceRoot` | 必填 | 执行阶段执行者唯一可写的目录树 |
| `protectedRoots` | `[]` | 其余任何 agent 不得读写的目录；应加入 harness 主目录 |
| `provider` | `'spawn'` | 三个角色 agent 派生所用的 subagent 提供方 |
| `routes` | 必填 | 每个角色的提供方与模型；审核者路由必须与起草者不同 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-sansheng)是每个可配置字段的完备来源。

### 人类命令与 agent 循环

命令只能由人类的命令通道触发；传达会话无法发出它们。

| 命令 | 含义 |
|---|---|
| `/xiazhi <标题> \| <圣旨>` | 立一个课题；你的原话逐字记录 |
| `/zhupi <课题> 准 \| 驳 <意见> \| 否` | 对课题当前待决事项裁定：确认、退回或否决 |
| `/zouzhe [课题]` | 不经传达会话，直接阅览奏折 |

根会话通过 `sansheng_status`、`sansheng_translate`、`sansheng_draft`、`sansheng_review`、`sansheng_execute`、`sansheng_accept` 六个工具驱动三省。同一方案两次封驳或两次验收不通过都会把课题升级给你裁定，而不是继续循环。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 — 点击展开</summary>

整个工作流是一个纯状态机，运转在每课题只追加的账本之上：每个合法的 阶段/触发者/事件 三元组都在代码里列明，账本重放时对每次转换重新校验。工具门禁把每次调用的会话解析到最近绑定了角色的祖先，再按状态机的当前阶段裁决每一次工具调用，因此隔离是结构性的：起草者和审核者不写任何文件、经 structured output 提交，只有执行者在工作区内写，角色子代继承其派生者的边界。封存文档（圣旨、转译、方案、审核、执行报告）一次写入并记录哈希；朱批绑定被审核方案的确切哈希，读取时按账本校验字节。奏折由代码从账本渲染，传达会话无法合并或改写分歧。

| 文件 | 职责 |
|---|---|
| [`src/state.ts`](src/state.ts) | 纯 reducer 形式的阶段/触发者/事件规则；封驳与返工上限及升级；账本重放 |
| [`src/policy.ts`](src/policy.ts) | 角色绑定的工具门禁：保护根外可读、写入限于执行者、shell 仅在执行或验收阶段 |
| [`src/store.ts`](src/store.ts) | 每课题账本、带哈希校验的一次写入封存文档、串行化转换 |
| [`src/tools.ts`](src/tools.ts) | 六个调度工具；各自派生一个角色子代，并把其结构化结果提交为下一次转换 |
| [`src/commands.ts`](src/commands.ts) | 仅限人类的 `/xiazhi`、`/zhupi`、`/zouzhe` 命令 |
| [`src/memorial.ts`](src/memorial.ts) | 从账本渲染奏折，各省摘要原文呈现 |
| [`src/prompts.ts`](src/prompts.ts) | 角色设定与任务提示词；每个 agent 只看到其提示词携带的内容 |
| [`src/index.ts`](src/index.ts) | 插件入口：配置、角色绑定、工具门禁、根会话系统提示词章节 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Subagent runtime](../../subagent/subagent/README.zh.md) — 三个角色 agent 派生所经过的 activation API。
- [Commands runtime](../../interaction/commands/README.zh.md) — 治理命令注册所在的人类命令通道。
- [HANDOFF.md](HANDOFF.md) — 设计目标、带实测耗时的真实模型试点，以及未完成的工作。

-----

<a id="model-experience"></a>
## 模型体验

### 太监系统提示词

#### 模型看到什么

每个根会话都会获得 `sansheng:eunuch` 系统提示词章节，把会话定位为你与三省之间的传达者：

##### 太监 persona 原文

```markdown
你是太监：皇帝与三省之间唯一的传令者。你只有传达权，没有决策权。
- 先用 sansheng_status 读取课题与圣旨原文，再把皇帝的人话转译为结构化需求（sansheng_translate），保留原意，标出疑点。
- 记录存放在你无权读取的目录；不要尝试 read 记录目录，一切经 sansheng_* 工具。
- 按宫规推进流程：sansheng_draft 交中书拟旨，sansheng_review 交门下审核，sansheng_execute 交尚书执行，sansheng_accept 交门下验收。
- 不得代皇帝批准；朱批只能由皇帝本人用 /zhupi 下达。
- 汇报时用奏折格式，各省意见按其原文摘要逐条呈报，不得合并或改写分歧，不确定处标明。
```

#### Token effect

固定：插件加载期间，该章节附加到根会话的每个请求。

#### KV Cache effect

前缀稳定：该章节每会话写入一次、轮次之间不变，提供商缓存前缀得以保留。

### 治理工具

#### 模型看到什么

根会话的工具列表新增 `sansheng_status`、`sansheng_translate`、`sansheng_draft`、`sansheng_review`、`sansheng_execute`、`sansheng_accept`；每个派生的角色子代只看到自己被允许的工具加 `structured_output`。

#### Token effect

根会话请求上的条件性工具 token；每个被派发的子代只支付自己的提示词、persona 和过滤后的工具列表。

#### KV Cache effect

根会话工具列表跨轮次稳定；子代请求是独立会话，提示词来自封存文档，因此子代自身运行期间前缀稳定。

### 角色子代派发提示词

#### 模型看到什么

每个被派发的 agent 收到自己的 persona 加一份由封存文档拼装的任务提示词：审核者拿到圣旨、已确认的转译和封存方案；起草者另加供修订的上一版方案、最近一次封驳的问题清单与你的退回意见；执行者拿到已朱批的方案与锁定的验收标准。起草者 persona 要求方案与验收标准的规模与任务相称，修订优先于叠加条款。

#### Token effect

按子代计，与封存文档成正比；不转发父会话对话的任何内容。

#### KV Cache effect

相互独立：子代请求与父会话、与其他子代都不共享前缀，重跑时由同样的封存字节重建提示词。

## 已知限制与暂缓工作

<a id="known-limitations-and-deferred-work"></a>

这些限制标出治理保证变薄的地方。它们是当前的包约束，不是任务清单。

- **验收阶段可以读整个工作区** —— 审核者需要 shell 复跑交付物，门禁授权范围是整个工作区而不只是交付物；因方案此时已封存，暂且接受。
- **执行完成没有硬校验** —— 进入验收依赖执行者自己的 `done` 报告；没有任何检查确认列出的交付物文件存在。
- **文档写入与账本追加之间崩溃会卡死课题** —— 封存文档已存在但其转换未记录，重试会撞上已有文件，也没有覆盖该阶段的脱困路径。
- **保护根之外的读取不受限制** —— 每个角色都能读整个工作区；只有写入被限制给执行者。
- **推理模型上的审核轮次很慢** —— 小课题也可能花半小时；审核者路由没有暴露推理强度上限。
- **暂缓** —— 分级紧急通道、预算与超时熔断、修正案轻量审核、跨课题引用、独立的验收司。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文 — 点击展开</summary>

[HANDOFF.md](HANDOFF.md) 记录设计目标、带各角色实测耗时的真实模型试点，以及本机的环境注意事项（E 盘布局、key 处理、测试命令）。

</details>
