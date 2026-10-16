/**
 * Eunuch-facing governance tools. Each tool checks the state machine through
 * the store, spawns one role child with that role's route, persona, and a
 * structured-output schema, then commits the child's result as the next
 * transition. The child never writes the record itself.
 */
import { randomUUID } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Env } from './index.ts'
import { GOVERNANCE_TOOLS } from './policy.ts'
import type { Role } from './policy.ts'
import {
  ACCEPTANCE_SCHEMA, EXECUTION_SCHEMA, PERSONAS, PLAN_SCHEMA, REVIEW_SCHEMA,
  acceptPrompt, draftPrompt, executePrompt, reviewPrompt,
} from './prompts.ts'
import { hashText } from './store.ts'
import type { StoredEntry } from './store.ts'
import { renderMemorial } from './memorial.ts'

type ChildRole = Exclude<Role, 'eunuch'>

const TEXT_OUTPUT = {
  schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
  render: (_args: unknown, out: { text: string }) => [{ type: 'text' as const, text: out.text }],
} as const

/** Spawn one bound role child and return its validated structured result. */
async function runRole(
  env: Env,
  parent: Agent,
  role: ChildRole,
  topicId: string,
  prompt: string,
  schema: object,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  // The guard reads phases from the cache; load it before the child's first call.
  await refresh(env, topicId)
  const childId = SessionId(`sansheng-${topicId}-${role}-${randomUUID()}`)
  const unbind = env.bindings.bind(childId, { role, topicId })
  try {
    const run = await env.ctx.subagents.startActivation({
      provider: env.config.provider,
      label: `${role} · ${topicId}`,
      childId,
      delivery: 'caller',
      signal,
      request: {
        prompt: [{ type: 'text', text: prompt }],
        parent,
        cwd: env.config.workspaceRoot,
        agentOptions: env.config.routes[role],
        persona: PERSONAS[role],
        outputSchema: schema as never,
        // Executors may delegate one level further; others may not delegate at all.
        maxDepth: role === 'shangshu' ? 2 : 1,
        // Hide what the role may never call, so it does not spend steps on refusals.
        toolFilter: { deny: hiddenTools(env, role) },
      },
    })
    try {
      const result = await run.result
      if (result.stopReason !== 'completed' || typeof result.structured !== 'object' || result.structured === null) {
        /* v8 ignore next -- diagnostic presence is provider-authored; the in-process test provider omits it. */
        throw new Error(`${role} did not return a structured result (${result.stopReason}${result.diagnostic ? `: ${result.diagnostic}` : ''})`)
      }
      return result.structured as Record<string, unknown>
    } finally {
      await run.dispose()
    }
  } finally {
    unbind()
  }
}

/** Tools always denied to this role, restricted to names actually registered. */
const ROLE_HIDDEN: Readonly<Record<ChildRole, readonly string[]>> = {
  zhongshu: ['write', 'edit', 'str_replace_editor', 'bash', 'pwsh', 'run_code', 'subagent', 'subagent_fork'],
  menxia: ['write', 'edit', 'str_replace_editor', 'subagent', 'subagent_fork'],
  shangshu: ['subagent_fork'],
}

export function hiddenTools(env: Env, role: ChildRole): string[] {
  return [...GOVERNANCE_TOOLS, ...ROLE_HIDDEN[role]].filter(name => env.ctx.tools.get(name) !== undefined)
}

async function refresh(env: Env, topicId: string): Promise<string> {
  const phase = (await env.store.state(topicId)).phase
  env.phases.set(topicId, phase)
  return phase
}

function latest(history: readonly StoredEntry[], type: string): StoredEntry | undefined {
  return [...history].reverse().find(e => e.event.type === type)
}

function str(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`structured result field "${field}" must be a non-empty string`)
  return value
}

function strList(value: unknown): string[] {
  /* v8 ignore next -- schema-validated output always sends an array; non-arrays are treated as empty. */
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.trim() !== '') : []
}

function requireAgent(exec: { agent?: Agent }): Agent {
  /* v8 ignore next -- the guard already refuses agent-less calls before any tool body runs. */
  if (exec.agent === undefined) throw new Error('sansheng tools require a calling agent')
  return exec.agent
}

/** Render a memorial with each 省's own one-line summary, read from its sealed document. */
export async function memorial(env: Env, topicId: string): Promise<string> {
  const history = await env.store.history(topicId)
  const summaries: Record<string, string> = {}
  for (const e of history) {
    if (e.doc === undefined || e.doc.name.startsWith('translation')) continue
    const parsed = JSON.parse(await env.store.readDoc(topicId, e.doc.name)) as { summary?: unknown }
    /* v8 ignore next -- every sealed role document is written by this module with a summary. */
    if (typeof parsed.summary === 'string') summaries[e.doc.name] = parsed.summary
  }
  return renderMemorial(topicId, await env.store.state(topicId), history, env.config.storeRoot, summaries)
}

export function registerTools(env: Env): void {
  const { ctx, store } = env
  const topicParam = { topic: { type: 'string', required: true, description: '课题编号，如 001' } } as const

  ctx.tools.register(defineTool({
    name: 'sansheng_status',
    description: '列出全部课题及其阶段；给出 topic 时返回该课题的奏折与圣旨原文（转译前先调用）。',
    parameters: { topic: { type: 'string', description: '课题编号（可选）' } },
    output: TEXT_OUTPUT,
    execute: async (args) => {
      if (args.topic !== undefined) {
        await refresh(env, args.topic)
        // The eunuch is the translator, so it reads the decree verbatim here;
        // the record store itself stays closed to every agent.
        const decree = await store.readDoc(args.topic, 'decree')
        return { text: `${await memorial(env, args.topic)}

【圣旨原文】
${decree}` }
      }
      const topics = await store.list()
      for (const t of topics) env.phases.set(t.id, t.state.phase)
      return { text: topics.length === 0 ? '暂无课题。' : topics.map(t => `${t.id} · ${t.title} · ${t.state.phase}`).join('\n') }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'sansheng_translate',
    description: '提交对圣旨的结构化转译，等待皇帝 /zhupi 确认。皇帝的原话由 /xiazhi 记录，太监无法改动。',
    parameters: {
      ...topicParam,
      translation: { type: 'string', required: true, description: '结构化需求（markdown），含研究问题、范围、约束与疑点' },
    },
    output: TEXT_OUTPUT,
    execute: async (args) => {
      const s = await store.state(args.topic)
      const name = `translation-v${s.translationVersion + 1}`
      await store.transition(args.topic, 'eunuch', { type: 'translation_submitted' }, { name, text: args.translation })
      await refresh(env, args.topic)
      return { text: `已呈转译 ${name}。请皇帝以 /zhupi ${args.topic} 准 确认，或 /zhupi ${args.topic} 驳 <意见> 退回。` }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'sansheng_draft',
    description: '交中书省拟旨。仅在课题处于 drafting 时可用。',
    parameters: topicParam,
    output: TEXT_OUTPUT,
    execute: async (args, exec) => {
      const parent = requireAgent(exec)
      const before = await store.state(args.topic)
      if (before.phase !== 'drafting') throw new Error(`topic ${args.topic} is ${before.phase}, not drafting`)
      const history = await store.history(args.topic)
      const translation = await confirmedTranslation(env, args.topic, history)
      const lastReview = latest(history, 'review_rejected')
      // Resubmission revises the previous plan instead of rewriting from scratch.
      const previousPlan = before.planVersion > 0
        ? (JSON.parse(await store.readDoc(args.topic, `plan-v${before.planVersion}`)) as { plan: string }).plan
        : undefined
      const out = await runRole(env, parent, 'zhongshu', args.topic, draftPrompt({
        decree: await store.readDoc(args.topic, 'decree'),
        translation,
        previousPlan,
        issues: lastReview?.doc ? await sealedIssues(env, args.topic, lastReview.doc.name) : undefined,
        feedback: feedbackSince(history),
      }), PLAN_SCHEMA, exec.signal)
      const version = before.planVersion + 1
      const plan = `# ${str(out.title, 'title')}\n\n${str(out.plan, 'plan')}`
      const criteria = str(out.criteria, 'criteria')
      const doc = JSON.stringify({ plan, criteria, summary: str(out.summary, 'summary') })
      await store.transition(args.topic, 'zhongshu', { type: 'plan_submitted', version, hash: hashText(doc) }, { name: `plan-v${version}`, text: doc })
      await refresh(env, args.topic)
      return { text: `中书已呈方案 v${version}（已封存）。摘要：${String(out.summary)}` }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'sansheng_review',
    description: '交门下省审核最新方案。门下只看到圣旨、转译与封存方案。',
    parameters: topicParam,
    output: TEXT_OUTPUT,
    execute: async (args, exec) => {
      const parent = requireAgent(exec)
      const s = await store.state(args.topic)
      if (s.phase !== 'reviewing') throw new Error(`topic ${args.topic} is ${s.phase}, not reviewing`)
      const history = await store.history(args.topic)
      const sealed = JSON.parse(await store.readDoc(args.topic, `plan-v${s.planVersion}`)) as { plan: string; criteria: string }
      const out = await runRole(env, parent, 'menxia', args.topic, reviewPrompt({
        decree: await store.readDoc(args.topic, 'decree'),
        translation: await confirmedTranslation(env, args.topic, history),
        plan: sealed.plan,
        criteria: sealed.criteria,
      }), REVIEW_SCHEMA, exec.signal)
      const passed = out.verdict === 'pass'
      const issues = strList(out.issues)
      if (!passed && issues.length === 0) throw new Error('门下封驳必须附问题清单')
      const round = history.filter(e => e.event.type === 'review_passed' || e.event.type === 'review_rejected').length + 1
      await store.transition(args.topic, 'menxia', { type: passed ? 'review_passed' : 'review_rejected' }, {
        name: `review-r${round}`,
        text: JSON.stringify({ verdict: out.verdict, issues, summary: str(out.summary, 'summary'), planVersion: s.planVersion }),
      })
      const phase = await refresh(env, args.topic)
      return { text: `门下${passed ? '建议通过' : '封驳'}（第 ${round} 轮）：${String(out.summary)}\n当前阶段：${phase}` }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'sansheng_execute',
    description: '交尚书省按已朱批方案执行。仅在 executing 时可用。',
    parameters: topicParam,
    output: TEXT_OUTPUT,
    execute: async (args, exec) => {
      const parent = requireAgent(exec)
      const s = await store.state(args.topic)
      if (s.phase !== 'executing' || s.approval === undefined) throw new Error(`topic ${args.topic} is ${s.phase}, not executing under an approval`)
      const sealed = await approvedPlan(env, args.topic, s.planVersion, s.approval)
      const history = await store.history(args.topic)
      const lastFail = latest(history, 'acceptance_failed')
      const out = await runRole(env, parent, 'shangshu', args.topic, executePrompt({
        plan: sealed.plan,
        criteria: sealed.criteria,
        issues: lastFail?.doc ? await sealedIssues(env, args.topic, lastFail.doc.name) : undefined,
      }), EXECUTION_SCHEMA, exec.signal)
      const n = history.filter(e => e.event.type === 'execution_submitted' || e.event.type === 'deviation_reported').length + 1
      const deviation = out.status === 'deviation'
      await store.transition(args.topic, 'shangshu', { type: deviation ? 'deviation_reported' : 'execution_submitted' }, {
        name: `execution-${n}`,
        text: JSON.stringify({ status: out.status, report: str(out.report, 'report'), summary: str(out.summary, 'summary') }),
      })
      const phase = await refresh(env, args.topic)
      return { text: `尚书${deviation ? '上报偏差' : '提交成果'}：${String(out.summary)}\n当前阶段：${phase}` }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'sansheng_accept',
    description: '交门下省按锁定的验收标准验收尚书成果。',
    parameters: topicParam,
    output: TEXT_OUTPUT,
    execute: async (args, exec) => {
      const parent = requireAgent(exec)
      const s = await store.state(args.topic)
      if (s.phase !== 'accepting' || s.approval === undefined) throw new Error(`topic ${args.topic} is ${s.phase}, not accepting`)
      const sealed = await approvedPlan(env, args.topic, s.planVersion, s.approval)
      const history = await store.history(args.topic)
      const submitted = latest(history, 'execution_submitted')
      /* v8 ignore next -- accepting is reachable only through execution_submitted, which always carries its report. */
      if (submitted?.doc === undefined) throw new Error('no execution report on record')
      const report = (JSON.parse(await store.readDoc(args.topic, submitted.doc.name)) as { report: string }).report
      const out = await runRole(env, parent, 'menxia', args.topic, acceptPrompt({ plan: sealed.plan, criteria: sealed.criteria, report }), ACCEPTANCE_SCHEMA, exec.signal)
      const passed = out.verdict === 'pass'
      const issues = strList(out.issues)
      if (!passed && issues.length === 0) throw new Error('验收不通过必须附问题清单')
      const n = history.filter(e => e.event.type === 'acceptance_passed' || e.event.type === 'acceptance_failed').length + 1
      await store.transition(args.topic, 'menxia', { type: passed ? 'acceptance_passed' : 'acceptance_failed' }, {
        name: `acceptance-${n}`,
        text: JSON.stringify({ verdict: out.verdict, issues, summary: str(out.summary, 'summary') }),
      })
      const phase = await refresh(env, args.topic)
      return { text: `门下验收${passed ? '通过' : '不通过'}：${String(out.summary)}\n当前阶段：${phase}` }
    },
  }))
}

/** The issue list sealed in a review or acceptance document. */
async function sealedIssues(env: Env, topicId: string, doc: string): Promise<string[]> {
  return strList((JSON.parse(await env.store.readDoc(topicId, doc)) as { issues?: unknown }).issues)
}

/** The translation the emperor confirmed: the last one submitted before confirmation. */
async function confirmedTranslation(env: Env, topicId: string, history: readonly StoredEntry[]): Promise<string> {
  const confirmAt = history.findIndex(e => e.event.type === 'translation_confirmed')
  const submitted = history.slice(0, confirmAt).filter(e => e.event.type === 'translation_submitted' && e.doc !== undefined)
  const doc = submitted.at(-1)?.doc
  /* v8 ignore next -- the state machine admits drafting only after a confirmed submitted translation. */
  if (confirmAt < 0 || doc === undefined) throw new Error(`topic ${topicId} has no confirmed translation`)
  return env.store.readDoc(topicId, doc.name)
}

/** Load the plan the approval binds, refusing if its hash no longer matches. */
async function approvedPlan(
  env: Env,
  topicId: string,
  version: number,
  approval: { planHash: string; criteriaHash: string },
): Promise<{ plan: string; criteria: string }> {
  // readDoc verifies the bytes against the ledger hash, which the approval bound.
  const text = await env.store.readDoc(topicId, `plan-v${version}`)
  /* v8 ignore next -- defense in depth: readDoc already matched these bytes to the ledger hash the approval bound. */
  if (hashText(text) !== approval.planHash) throw new Error('approved plan hash does not match the record')
  const sealed = JSON.parse(text) as { plan: string; criteria: string }
  /* v8 ignore next -- defense in depth: criteria live inside the hashed plan document. */
  if (hashText(sealed.criteria) !== approval.criteriaHash) throw new Error('approved criteria hash does not match the record')
  return sealed
}

/** Emperor feedback attached to the most recent send-back, if any. */
function feedbackSince(history: readonly StoredEntry[]): string | undefined {
  const last = latest(history, 'sent_back')
  return last?.note
}
