---
description: "The 三省制 governance plugin: a role-separated planner, reviewer, and executor around a research workspace, with every approval and veto reserved to the human, for deployments that need checks and balances between collaborating agents."
kind: "package-reference"
---

# @deepseek-ai/dsh-sansheng

English | [中文](README.zh.md)

## Summary

`dsh-sansheng` runs one research topic through three separated agents: a planner drafts the plan, an independent reviewer gates it, and an executor carries it out inside a writable workspace. The root session relays between you and them but holds no decision power. Every approval and veto is yours: a topic advances only through your `/zhupi` command, and each approval binds the sealed plan by hash. Choose it when a model-driven workflow needs structural checks and balances; a single-agent session stays simpler and faster.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin when a research workspace needs governed multi-agent execution. The common path: open a topic with `/xiazhi`, let the root session translate it, drive it through the three agents, and decide each gate with `/zhupi`.

### When to choose it

Choose it when one agent drafting, reviewing, and executing its own plan is a risk you cannot accept: here the planner and reviewer run on different models, never see each other's reasoning, and the record survives even a compromised session because it lives outside every agent's reach. Avoid it for quick single-session tasks: the review rounds add minutes even on a small topic.

### Minimal configuration

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

`storeRoot` must lie outside `workspaceRoot` and outside every entry of `protectedRoots`; the tool guard denies every agent read and write under protected roots, so no session can reach the record.

| Field | Default | Meaning |
|---|---|---|
| `storeRoot` | required | Record directory for ledgers and sealed documents; no agent may read or write it |
| `workspaceRoot` | required | The only tree the executor may write while executing |
| `protectedRoots` | `[]` | Further directories no agent may read or write; add the harness home |
| `provider` | `'spawn'` | Subagent provider id the three agents spawn through |
| `routes` | required | Provider and model per role; the reviewer route must differ from the planner route |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-sansheng) is the exhaustive source for every accepted field.

### Human commands and the agent loop

Commands run only from the human command channel; the relaying session cannot issue them.

| Command | Meaning |
|---|---|
| `/xiazhi <title> \| <decree>` | Open a topic; your words are recorded verbatim |
| `/zhupi <topic> 准 \| 驳 <note> \| 否` | Confirm, send back, or veto whatever the topic awaits |
| `/zouzhe [topic]` | Read the memorial directly, without the relaying session |

The root session drives the three agents through the `sansheng_status`, `sansheng_translate`, `sansheng_draft`, `sansheng_review`, `sansheng_execute`, and `sansheng_accept` tools. Two rejections of one plan or two failed acceptances escalate the topic to you instead of looping.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The workflow is one pure state machine over an append-only per-topic ledger: every legal phase/actor/event triple is listed in code, and ledger replay revalidates each transition at read time. A tool guard resolves each calling session to its nearest bound ancestor role and consults the state machine's current phase before allowing any tool call, so isolation is structural: the planner and reviewer write no files and submit through structured output, only the executor writes inside the workspace, and role children inherit their spawner's bounds. Sealed documents (decree, translations, plans, reviews, execution reports) are write-once with recorded hashes; an approval binds the exact reviewed plan hash, and reads verify the bytes against the ledger. The memorial is rendered by code from the ledger so the relaying session cannot merge or rewrite disagreements.

| File | Role |
|---|---|
| [`src/state.ts`](src/state.ts) | Phase/actor/event rules as a pure reducer; rejection and rework limits with escalation; ledger replay |
| [`src/policy.ts`](src/policy.ts) | Role-bound tool policy: reads outside protected roots, writes confined to the executor, shell only while executing or accepting |
| [`src/store.ts`](src/store.ts) | Per-topic ledger, write-once sealed documents with hash verification, serialized transitions |
| [`src/tools.ts`](src/tools.ts) | The six dispatch tools; each spawns one role child and commits its structured result as the next transition |
| [`src/commands.ts`](src/commands.ts) | The human-only `/xiazhi`, `/zhupi`, and `/zouzhe` commands |
| [`src/memorial.ts`](src/memorial.ts) | Memorial rendering from the ledger, each role summary appearing verbatim |
| [`src/prompts.ts`](src/prompts.ts) | Role personas and task prompts; each agent sees only what its prompt carries |
| [`src/index.ts`](src/index.ts) | Plugin entry: config, role bindings, tool guard, root-session system-prompt section |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Subagent runtime](../../subagent/subagent/README.md) — the activation API the three role agents spawn through.
- [Commands runtime](../../interaction/commands/README.md) — the human command channel the governance commands register on.
- [HANDOFF.md](HANDOFF.md) — design goals, a real-model pilot run with measured timings, and the remaining work.

-----

<a id="model-experience"></a>
## Model Experience

### Eunuch system prompt

#### What the model sees

Every root session gains a `sansheng:eunuch` system-prompt section that positions the session as the relay between you and the three agents:

##### Verbatim eunuch persona

```markdown
你是太监：皇帝与三省之间唯一的传令者。你只有传达权，没有决策权。
- 先用 sansheng_status 读取课题与圣旨原文，再把皇帝的人话转译为结构化需求（sansheng_translate），保留原意，标出疑点。
- 记录存放在你无权读取的目录；不要尝试 read 记录目录，一切经 sansheng_* 工具。
- 按宫规推进流程：sansheng_draft 交中书拟旨，sansheng_review 交门下审核，sansheng_execute 交尚书执行，sansheng_accept 交门下验收。
- 不得代皇帝批准；朱批只能由皇帝本人用 /zhupi 下达。
- 汇报时用奏折格式，各省意见按其原文摘要逐条呈报，不得合并或改写分歧，不确定处标明。
```

#### Token effect

Fixed: the section is appended to every root-session request while the plugin is loaded.

#### KV Cache effect

Prefix-stable: the section is written once per session and does not change between turns, so provider cache prefixes survive.

### Governance tools

#### What the model sees

The root session's tool list gains `sansheng_status`, `sansheng_translate`, `sansheng_draft`, `sansheng_review`, `sansheng_execute`, and `sansheng_accept`; each spawned role child sees only its own allowed tools plus `structured_output`.

#### Token effect

Conditional tool tokens on root-session requests; each dispatched child pays only its own prompt, persona, and filtered tool list.

#### KV Cache effect

The root-session tool list is stable across turns; child requests are separate sessions whose prompts derive from sealed documents, so a child's prefix is stable within its own run.

### Role-child dispatch prompts

#### What the model sees

Each spawned agent receives its persona plus a task prompt assembled from sealed documents: the reviewer gets the decree, the confirmed translation, and the sealed plan; the planner additionally gets the previous plan to revise, the latest rejection issues, and your send-back note; the executor gets the approved plan and the locked acceptance criteria. The planner persona caps plan and criteria size to the task and requires revisions over accretion.

#### Token effect

Per-child and proportional to the sealed documents; nothing from the parent conversation is forwarded.

#### KV Cache effect

Independent: child requests share no prefix with the parent or with each other, and a re-run rebuilds the prompt from the same sealed bytes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits mark where the governance guarantee thins out. They are current package constraints, not a task backlog.

- **Acceptance runs in a disposable workspace copy** — the reviewer's shell works in a temporary snapshot of the workspace, removed after the verdict, so re-runs can never alter the executor's delivered files; each acceptance copies the whole workspace, which costs time and disk for large trees.
- **Executor completion is verified at text level only** — before acceptance, the plugin extracts deliverable paths the executor's report claims (code spans and bare file-suffixed paths inside the workspace) and requires each to exist; a report that avoids naming paths falls back to the reviewer's independent re-run.
- **A crash between a document write and its ledger append wedges the topic** — the sealed document exists without its transition, so retrying fails on the existing file and no phase escape covers that stage.
- **Reads outside protected roots are unrestricted** — every role can read the whole workspace; only writes are confined to the executor.
- **Review rounds are slow on reasoning models** — a small topic can take half an hour; no reasoning-effort cap is exposed on the reviewer route.
- **Deferred** — tiered urgency channels, budget and timeout circuit breakers, lightweight amendment review, cross-topic references, and a separate acceptance office.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

[HANDOFF.md](HANDOFF.md) records the design goals, the real-model pilot run with per-role timings, and this machine's environment notes (E-drive layout, key handling, test commands).

</details>
