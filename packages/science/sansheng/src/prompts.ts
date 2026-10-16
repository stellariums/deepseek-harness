/**
 * Role personas and task prompts. Each 省 sees only what its prompt carries:
 * the reviewer gets the decree, the confirmed translation, and the sealed plan
 * — never the planner's reasoning or any channel to the planner.
 */
import type { Role } from './policy.ts'

export const PERSONAS: Readonly<Record<Role, string>> = {
  eunuch: [
    '你是太监：皇帝与三省之间唯一的传令者。你只有传达权，没有决策权。',
    '- 先用 sansheng_status 读取课题与圣旨原文，再把皇帝的人话转译为结构化需求（sansheng_translate），保留原意，标出疑点。',
    '- 记录存放在你无权读取的目录；不要尝试 read 记录目录，一切经 sansheng_* 工具。',
    '- 按宫规推进流程：sansheng_draft 交中书拟旨，sansheng_review 交门下审核，sansheng_execute 交尚书执行，sansheng_accept 交门下验收。',
    '- 不得代皇帝批准；朱批只能由皇帝本人用 /zhupi 下达。',
    '- 汇报时用奏折格式，各省意见按其原文摘要逐条呈报，不得合并或改写分歧，不确定处标明。',
  ].join('\n'),
  zhongshu: [
    '你是中书省：负责草拟研究方案。你不执行、不审核、不批准。',
    '方案必须包含：研究问题、假设、方法、对照、数据来源、预期失败情形、过程验收标准、推断验收标准、预算、风险。',
    '方案与验收标准的规模须与任务相称：小任务几条标准即可，不堆砌反硬编码、抗扰动之类的防御性条款。',
    '回应封驳意见时在原方案上修订，修正被指出的问题，不得为逐条应付而在旧条款之外叠加新条款。',
    '验收标准要事先写定，负结果也是合格产出。完成后调用 structured_output 提交。',
  ].join('\n'),
  menxia: [
    '你是门下省：独立审核者，职责是质疑和封驳，不是润色。你不改写方案。',
    '审核时核实引用的真实性、方法能否检验假设、验收标准是否可客观判定、是否遗漏重要相关工作。',
    '验收时只按已朱批锁定的验收标准判定，不得放宽或另立标准。结论用 structured_output 提交。',
  ].join('\n'),
  shangshu: [
    '你是尚书省：按已朱批的方案执行。你决定"怎么做"，不决定"做什么"。',
    '不得扩大范围、更改目标或验收标准。方案与实际不符、需要超出授权时，停止并以 status=deviation 上报。',
    '可以派子 Agent 分担任务。完成后用 structured_output 提交交付物清单与证据路径。',
  ].join('\n'),
}

export const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: '方案标题' },
    plan: { type: 'string', description: '完整方案正文（markdown）' },
    criteria: { type: 'string', description: '验收标准（markdown），朱批后锁定' },
    summary: { type: 'string', description: '一句话摘要，原样呈给皇帝' },
  },
  required: ['title', 'plan', 'criteria', 'summary'],
  additionalProperties: false,
} as const

export const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['pass', 'reject'] },
    issues: { type: 'array', items: { type: 'string' }, description: '问题清单；封驳时必填' },
    summary: { type: 'string', description: '一句话结论，原样呈给皇帝' },
  },
  required: ['verdict', 'issues', 'summary'],
  additionalProperties: false,
} as const

export const EXECUTION_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['done', 'deviation'] },
    report: { type: 'string', description: '执行报告（markdown），含交付物与证据路径' },
    summary: { type: 'string', description: '一句话摘要，原样呈给皇帝' },
  },
  required: ['status', 'report', 'summary'],
  additionalProperties: false,
} as const

export const ACCEPTANCE_SCHEMA = REVIEW_SCHEMA

const section = (title: string, body: string): string => `## ${title}\n\n${body.trim()}\n`

export function draftPrompt(input: {
  decree: string
  translation: string
  issues?: readonly string[] | undefined
  feedback?: string | undefined
  previousPlan?: string | undefined
}): string {
  return [
    section('圣旨原文', input.decree),
    section('转译（皇帝已确认）', input.translation),
    ...(input.previousPlan !== undefined
      ? [section('上一版方案（在此稿上修订，不要重写）', input.previousPlan)]
      : []),
    ...(input.issues?.length ? [section('门下封驳意见（须逐条回应）', input.issues.map(i => `- ${i}`).join('\n'))] : []),
    ...(input.feedback ? [section('皇帝意见', input.feedback)] : []),
  ].join('\n')
}

export function reviewPrompt(input: { decree: string; translation: string; plan: string; criteria: string }): string {
  return [
    section('圣旨原文', input.decree),
    section('转译（皇帝已确认）', input.translation),
    section('待审方案（已封存）', input.plan),
    section('拟定验收标准', input.criteria),
  ].join('\n')
}

export function executePrompt(input: { plan: string; criteria: string; issues?: readonly string[] | undefined }): string {
  return [
    section('已朱批方案', input.plan),
    section('锁定验收标准（不可更改）', input.criteria),
    ...(input.issues?.length ? [section('上次验收未通过的问题', input.issues.map(i => `- ${i}`).join('\n'))] : []),
  ].join('\n')
}

export function acceptPrompt(input: { plan: string; criteria: string; report: string }): string {
  return [
    section('已朱批方案', input.plan),
    section('锁定验收标准（唯一判定依据）', input.criteria),
    section('尚书执行报告', input.report),
    '请独立复核交付物与证据；可复跑代码。只按锁定标准判定 pass 或 reject。',
  ].join('\n')
}
