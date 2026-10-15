/**
 * 奏折: the fixed-format report the eunuch relays. Rendered by code from the
 * ledger, so each 省's one-line summary appears verbatim and a dispute can
 * never be merged into a single sentence by the relaying model.
 */
import { join } from 'node:path'
import type { Phase, TopicState } from './state.ts'
import type { StoredEntry } from './store.ts'

const PIPELINE: readonly { label: string; phases: readonly Phase[] }[] = [
  { label: '转译', phases: ['translated'] },
  { label: '拟旨', phases: ['drafting'] },
  { label: '审核', phases: ['reviewing', 'disputed'] },
  { label: '朱批', phases: ['awaiting_approval'] },
  { label: '执行', phases: ['executing', 'deviation'] },
  { label: '验收', phases: ['accepting'] },
  { label: '复命', phases: ['awaiting_close'] },
]

const PENDING: Partial<Record<Phase, (id: string) => string>> = {
  translated: id => `确认转译：/zhupi ${id} 准 ｜ 退回：/zhupi ${id} 驳 <意见>`,
  awaiting_approval: id => `朱批方案：/zhupi ${id} 准 ｜ 驳回重拟：/zhupi ${id} 驳 <意见> ｜ 否决：/zhupi ${id} 否`,
  disputed: id => `中书门下争议（封驳已达上限）：/zhupi ${id} 准（推翻门下）｜ /zhupi ${id} 驳 <意见> ｜ /zhupi ${id} 否`,
  deviation: id => `尚书偏差待裁：/zhupi ${id} 准（维持原方案继续）｜ /zhupi ${id} 驳 <意见>（开修正案）｜ /zhupi ${id} 否`,
  awaiting_close: id => `结案：/zhupi ${id} 准`,
}

const ROLE_LABEL: Record<string, string> = {
  emperor: '皇帝', eunuch: '太监', zhongshu: '中书', menxia: '门下', shangshu: '尚书', system: '制度层',
}

function progress(phase: Phase): string {
  if (phase === 'closed') return PIPELINE.map(p => `${p.label} ✅`).join(' → ')
  const at = PIPELINE.findIndex(p => p.phases.includes(phase))
  return PIPELINE.map((p, i) => `${p.label} ${i < at ? '✅' : i === at ? '🔄' : '⬜'}`).join(' → ')
}

/**
 * Render the memorial for one topic.
 * @param summaries - one-line summaries keyed by document name, as each 省 wrote them.
 */
export function renderMemorial(
  topicId: string,
  state: TopicState,
  history: readonly StoredEntry[],
  storeRoot: string,
  summaries: Readonly<Record<string, string>> = {},
): string {
  const pending = PENDING[state.phase]?.(topicId) ?? '无'
  const recent = history.slice(-5).map((e) => {
    const summary = e.doc === undefined ? undefined : summaries[e.doc.name]
    return `- ${ROLE_LABEL[e.actor] ?? e.actor} · ${e.event.type}${summary ? `：${summary}` : ''}${e.note ? `（批注：${e.note}）` : ''}`
  })
  return [
    `奏折 · 课题 ${topicId}`,
    '',
    `【待圣裁】${pending}`,
    `【进度】${progress(state.phase)}`,
    `【计数】封驳 ${state.rejections}/2 · 返工 ${state.reworks}/2 · 方案 v${state.planVersion}`,
    '【近况】（各省原文摘要）',
    ...(recent.length === 0 ? ['- 无'] : recent),
    `【原件】${join(storeRoot, topicId)}`,
  ].join('\n')
}
