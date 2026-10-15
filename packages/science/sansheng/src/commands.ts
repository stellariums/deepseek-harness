/**
 * Human-only commands. Command handlers run only from the UI's command
 * channel, never from a model tool call, so these are the emperor's hand:
 *
 *   /xiazhi <标题> | <圣旨原文>        open a topic, words recorded verbatim
 *   /zhupi <课题> 准 | 驳 <意见> | 否   decide whatever the topic awaits
 *   /zouzhe [课题]                     read a memorial without the eunuch
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Env } from './index.ts'
import type { TopicEvent, TopicState } from './state.ts'
import { hashText } from './store.ts'
import { memorial } from './tools.ts'

type Decision = 'approve' | 'reject' | 'veto'

const WORDS: Readonly<Record<string, Decision>> = { 准: 'approve', 驳: 'reject', 否: 'veto' }

export function parseZhupi(raw: string): { topic: string; decision: Decision; note: string } | string {
  const m = /^\s*(?<topic>\d{3,})\s+(?<word>准|驳|否)\s*(?<note>[\s\S]*)$/u.exec(raw)
  const { topic, word, note: rawNote } = m?.groups ?? {}
  const decision = word === undefined ? undefined : WORDS[word]
  if (topic === undefined || decision === undefined) return '用法：/zhupi <课题> 准 | 驳 <意见> | 否'
  /* v8 ignore next -- the note group always participates in a match; ?? only satisfies the type. */
  const note = (rawNote ?? '').trim()
  if (decision === 'reject' && note === '') return '驳回须附意见：/zhupi <课题> 驳 <意见>'
  return { topic, decision, note }
}

/** Map a decision onto the event the current phase expects. */
export function eventFor(
  state: TopicState,
  decision: Decision,
  approval?: { planHash: string; criteriaHash: string },
): TopicEvent | string {
  if (decision === 'veto') return { type: 'vetoed' }
  switch (state.phase) {
    case 'translated':
      return decision === 'approve' ? { type: 'translation_confirmed' } : { type: 'retranslate' }
    case 'awaiting_approval':
      if (decision === 'reject') return { type: 'sent_back' }
      return approval === undefined ? '缺少待批方案' : { type: 'approved', ...approval }
    case 'disputed':
      return decision === 'approve' ? { type: 'overruled' } : { type: 'sent_back' }
    case 'deviation':
      return decision === 'approve' ? { type: 'resume' } : { type: 'sent_back' }
    case 'awaiting_close':
      return decision === 'approve' ? { type: 'closed' } : '复命阶段只能 准 或 否'
    default:
      return `课题处于 ${state.phase}，此时无需朱批`
  }
}

export function registerCommands(c: Context, env: Env): void {
  const { store } = env

  c.commands.register({
    name: 'xiazhi',
    description: '下旨：开一个新课题，原话原样记录',
    input: { hint: '<标题> | <圣旨原文>' },
    handler: async ({ rawInput }) => {
      const [title, ...rest] = rawInput.split('|')
      const decree = rest.join('|').trim()
      if (title === undefined || title.trim() === '' || decree === '') {
        return { kind: 'error', text: '用法：/xiazhi <标题> | <圣旨原文>' }
      }
      const { id } = await store.create(decree, title.trim())
      env.phases.set(id, 'translated')
      return { kind: 'success', text: `已立课题 ${id}。请太监转译：sansheng_translate ${id}` }
    },
  })

  c.commands.register({
    name: 'zhupi',
    description: '朱批：对课题当前待决事项 准 / 驳 / 否',
    input: { hint: '<课题> 准 | 驳 <意见> | 否' },
    handler: async ({ rawInput }) => {
      const parsed = parseZhupi(rawInput)
      if (typeof parsed === 'string') return { kind: 'error', text: parsed }
      try {
        const state = await store.state(parsed.topic)
        const approval = state.phase === 'awaiting_approval' ? await pendingApproval(env, parsed.topic, state) : undefined
        const event = eventFor(state, parsed.decision, approval)
        if (typeof event === 'string') return { kind: 'error', text: event }
        const next = await store.transition(parsed.topic, 'emperor', event, undefined, parsed.note)
        env.phases.set(parsed.topic, next.phase)
        return { kind: 'success', text: `朱批已录：课题 ${parsed.topic} · ${event.type} → ${next.phase}` }
      } catch (e) {
        return { kind: 'error', text: `朱批未录：${(e as Error).message}` }
      }
    },
  })

  c.commands.register({
    name: 'zouzhe',
    description: '直接阅览奏折（不经太监）',
    input: { hint: '[课题]' },
    handler: async ({ rawInput }) => {
      const id = rawInput.trim()
      try {
        if (id === '') {
          const topics = await store.list()
          return { kind: 'success', text: topics.length === 0 ? '暂无课题。' : topics.map(t => `${t.id} · ${t.title} · ${t.state.phase}`).join('\n') }
        }
        const state = await store.state(id)
        env.phases.set(id, state.phase)
        return { kind: 'success', text: await memorial(env, id) }
      } catch (e) {
        return { kind: 'error', text: (e as Error).message }
      }
    },
  })
}

/** Hashes of the plan under review, so the approval binds exactly what was reviewed. */
async function pendingApproval(env: Env, topic: string, state: TopicState): Promise<{ planHash: string; criteriaHash: string }> {
  const text = await env.store.readDoc(topic, `plan-v${state.planVersion}`)
  const { criteria } = JSON.parse(text) as { criteria: string }
  return { planHash: hashText(text), criteriaHash: hashText(criteria) }
}
