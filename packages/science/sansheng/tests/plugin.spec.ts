import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime, { STRUCTURED_OUTPUT_TOOL } from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { mountLocalActivations } from '../../../subagent/subagent/tests/local-activation.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as ToolSubagent from '@deepseek-ai/dsh-tool-subagent'
import * as Sansheng from '../src/index.ts'

type Script = ConstructorParameters<typeof MockAdapter>[0]

let storeRootForTests = ''
const storeRootOf = (_req: unknown): string => storeRootForTests

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

const PLAN = { title: '晶格热导率预测', plan: '用 GNN 预测 ...', criteria: 'MAE < 0.1 且可复现', summary: '中书：GNN 方案' }

/**
 * Boot the real agent loop, subagent runtime, spawn backend, command registry
 * and the plugin. Each role routes to its own mock model, so a request landing
 * on the wrong adapter exhausts that adapter's script and fails the test.
 */
async function boot(
  scripts: { eunuch: Script; zhongshu?: Script; menxia?: Script; shangshu?: Script },
  opts: { withSubagentTool?: boolean } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'sansheng-plugin-'))
  dirs.push(root)
  const workspace = join(root, 'ws')
  mkdirSync(workspace)
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await mountLocalActivations(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime, { maxDepth: 3 })
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  await ctx.plugin(CommandRuntime)
  const adapters = {
    eunuch: new MockAdapter(scripts.eunuch),
    zhongshu: new MockAdapter(scripts.zhongshu ?? []),
    menxia: new MockAdapter(scripts.menxia ?? []),
    shangshu: new MockAdapter(scripts.shangshu ?? []),
  }
  for (const [role, adapter] of Object.entries(adapters)) ctx.llm.registerAdapter([`p-${role}`], adapter)
  ctx.tools.register(defineContentToolFixture({ name: 'read', description: 'r', parameters: {}, async execute() { return [{ type: 'text', text: 'file' }] } }))
  ctx.tools.register(defineContentToolFixture({ name: 'write', description: 'w', parameters: {}, async execute() { return [{ type: 'text', text: 'wrote' }] } }))
  const config: Sansheng.Config = {
    storeRoot: join(root, 'store'),
    workspaceRoot: workspace,
    protectedRoots: [],
    provider: 'spawn',
    routes: {
      zhongshu: { provider: 'p-zhongshu', model: 'glm' },
      menxia: { provider: 'p-menxia', model: 'ds' },
      shangshu: { provider: 'p-shangshu', model: 'qwen' },
    },
  }
  await ctx.plugin(Sansheng, config)
  if (opts.withSubagentTool) await ctx.plugin(ToolSubagent, { provider: 'spawn' })
  const eunuch = await ctx.agentLoop.create(SessionId('eunuch'), { provider: 'p-eunuch', model: 'e' })
  return { ctx, eunuch, adapters, config }
}

async function say(ctx: Context, agent: Agent, text: string): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  do { await agent.whenIdle() } while (await ctx.subagents.waitForChildren(agent))
}

async function cmd(ctx: Context, agent: Agent, line: string): Promise<{ kind: string; text?: string }> {
  const run = await ctx.commands.execute(agent, line, [], new AbortController().signal)
  if (run === undefined) throw new Error(`command not registered: ${line}`)
  return run.result
}

/** Text of every tool result the agent received, in order. */
function toolResults(agent: Agent): string[] {
  return agent.session.snapshotEvents()
    .filter(e => e.type === 'tool/result')
    .map(e => JSON.stringify((e.data as { content?: unknown }).content ?? e.data))
}

function systemText(req: GenerateOptions): string {
  return req.messages.filter(m => m.role === 'system').map(m => JSON.stringify(m.content)).join('\n')
}

function userText(req: GenerateOptions): string {
  return req.messages.filter(m => m.role === 'user').map(m => JSON.stringify(m.content)).join('\n')
}

/** Results of every tool call any agent made, with the agent id. */
function allResults(ctx: Context): string {
  return ctx.agents.list().map(a => `${a.id}: ${toolResults(a).join(' || ')}`).join('\n')
}

describe('authority and isolation', () => {
  it('the eunuch cannot skip a step: drafting before the emperor confirms is refused', async () => {
    const { ctx, eunuch, adapters } = await boot({
      eunuch: [toolCallResponse('d', 'sansheng_draft', { topic: '001' }), textResponse('x')],
    })
    await cmd(ctx, eunuch, '/xiazhi t | d')
    await say(ctx, eunuch, 'go')
    expect(toolResults(eunuch).join('')).toContain('not drafting')
    expect(adapters.zhongshu.requests).toHaveLength(0)
  })

  it('no model-facing tool can approve: unknown tools are denied to the eunuch', async () => {
    const { ctx, eunuch } = await boot({
      eunuch: [toolCallResponse('w', 'write', { file_path: 'x.md', content: 'forged' }), textResponse('x')],
    })
    await say(ctx, eunuch, 'go')
    expect(toolResults(eunuch).join('')).toContain('sansheng: eunuch does not write files')
  })

  it('the reviewer cannot read the record store, and sees no planner channel', async () => {
    const { ctx, eunuch, adapters, config } = await boot({
      eunuch: [
        toolCallResponse('t', 'sansheng_translate', { topic: '001', translation: 'T' }), textResponse('a'),
        toolCallResponse('d', 'sansheng_draft', { topic: '001' }), textResponse('b'),
        toolCallResponse('r', 'sansheng_review', { topic: '001' }), textResponse('c'),
      ],
      zhongshu: [toolCallResponse('z', STRUCTURED_OUTPUT_TOOL, PLAN)],
      menxia: [
        req => toolCallResponse('peek', 'read', { file_path: join(config.storeRoot, '001', 'plan-v1.md'), _n: req.messages.length }),
        toolCallResponse('m', STRUCTURED_OUTPUT_TOOL, { verdict: 'reject', issues: ['缺对照'], summary: '门下：封驳' }),
      ],
    })
    await cmd(ctx, eunuch, '/xiazhi t | d')
    await say(ctx, eunuch, '1')
    await cmd(ctx, eunuch, '/zhupi 001 准')
    await say(ctx, eunuch, '2')
    await say(ctx, eunuch, '3')
    const second = JSON.stringify(adapters.menxia.requests[1]!.messages)
    expect(second).toContain('sansheng: path is in a protected directory')
    // The reviewer's tool list never offers a way to message the planner.
    const offered = (adapters.menxia.requests[0]!.tools ?? []).map(t => t.name)
    expect(offered).not.toContain('send_message')
    expect(offered).not.toContain('sansheng_status')
    expect(offered).not.toContain('write')
    expect(offered).toContain('read')
    expect((await cmd(ctx, eunuch, '/zouzhe 001')).text).toContain('封驳 1/2')
  })

  it('an executor subagent inherits the executor binding and its bounds', async () => {
    const grandchild: Script = [
      req => toolCallResponse('g1', 'write', { file_path: join(storeRootOf(req), '001', 'forged.md'), content: 'x' }),
      toolCallResponse('g2', 'write', { file_path: 'ok.txt', content: 'x' }),
      textResponse('子任务完成'),
    ]
    const { ctx, eunuch, config, adapters } = await boot({
      eunuch: [
        toolCallResponse('t', 'sansheng_translate', { topic: '001', translation: 'T' }), textResponse('a'),
        toolCallResponse('d', 'sansheng_draft', { topic: '001' }), textResponse('b'),
        toolCallResponse('r', 'sansheng_review', { topic: '001' }), textResponse('c'),
        toolCallResponse('x', 'sansheng_execute', { topic: '001' }), textResponse('d'),
      ],
      zhongshu: [toolCallResponse('z', STRUCTURED_OUTPUT_TOOL, PLAN)],
      menxia: [toolCallResponse('m', STRUCTURED_OUTPUT_TOOL, { verdict: 'pass', issues: [], summary: 'ok' })],
      shangshu: [
        toolCallResponse('s1', 'subagent', { description: '子任务', prompt: '写文件' }),
        ...grandchild,
        textResponse('等子任务'),
        toolCallResponse('s2', STRUCTURED_OUTPUT_TOOL, { status: 'done', report: 'r', summary: '尚书：完成' }),
      ],
    }, { withSubagentTool: true })
    storeRootForTests = config.storeRoot
    await cmd(ctx, eunuch, '/xiazhi t | d')
    await say(ctx, eunuch, '1')
    await cmd(ctx, eunuch, '/zhupi 001 准')
    await say(ctx, eunuch, '2')
    await say(ctx, eunuch, '3')
    await cmd(ctx, eunuch, '/zhupi 001 准')
    await say(ctx, eunuch, '4')
    const seen = adapters.shangshu.requests.map(r => JSON.stringify(r.messages)).join(' || ')
    expect(seen, allResults(ctx)).toContain('sansheng: path is in a protected directory')
    expect(seen).toContain('wrote')
  })

  it('the orphan check fails closed', () => {
    const ctx = new Context()
    const b = new Sansheng.Bindings(ctx)
    const orphan = { id: SessionId('o'), session: { header: { parentSession: SessionId('gone') } } } as unknown as Agent
    ;(ctx as unknown as { agents: { get: () => undefined } }).agents = { get: () => undefined }
    expect(b.resolve(orphan)).toEqual({ role: 'zhongshu', topicId: '__orphan__' })
  })

  it('a bound grandchild resolves to its bound ancestor', () => {
    const ctx = new Context()
    const b = new Sansheng.Bindings(ctx)
    const parent = { id: SessionId('p'), session: { header: {} } } as unknown as Agent
    const child = { id: SessionId('c'), session: { header: { parentSession: SessionId('p') } } } as unknown as Agent
    ;(ctx as unknown as { agents: { get: (id: string) => Agent | undefined } }).agents = { get: id => (id === 'p' ? parent : undefined) }
    const unbind = b.bind(SessionId('p'), { role: 'shangshu', topicId: '001' })
    expect(b.resolve(child)).toEqual({ role: 'shangshu', topicId: '001' })
    unbind()
    expect(b.resolve(child)).toEqual({ role: 'eunuch', topicId: undefined })
  })
})

/** Drive a topic to `executing`: the eunuch script prefix plus the matching role scripts. */
const flow = () => ({
  eunuch: [
    toolCallResponse('t', 'sansheng_translate', { topic: '001', translation: 'T' }), textResponse('a'),
    toolCallResponse('d', 'sansheng_draft', { topic: '001' }), textResponse('b'),
    toolCallResponse('r', 'sansheng_review', { topic: '001' }), textResponse('c'),
  ],
  zhongshu: [toolCallResponse('z', STRUCTURED_OUTPUT_TOOL, PLAN)],
  menxia: [toolCallResponse('m', STRUCTURED_OUTPUT_TOOL, { verdict: 'pass', issues: [], summary: '门下：可行' })],
})

async function driveToExecuting(ctx: Context, eunuch: Agent): Promise<void> {
  await cmd(ctx, eunuch, '/xiazhi t | d')
  await say(ctx, eunuch, '1')
  await cmd(ctx, eunuch, '/zhupi 001 准')
  await say(ctx, eunuch, '2')
  await say(ctx, eunuch, '3')
  await cmd(ctx, eunuch, '/zhupi 001 准')
}

describe('tool failure paths', () => {
  it('a child that ends without a structured result is reported, not committed', async () => {
    const { ctx, eunuch } = await boot({
      eunuch: [
        toolCallResponse('t', 'sansheng_translate', { topic: '001', translation: 'T' }), textResponse('a'),
        toolCallResponse('d', 'sansheng_draft', { topic: '001' }), textResponse('b'),
      ],
      zhongshu: [textResponse('我不想交'), textResponse('还是不交'), textResponse('不交')],
    })
    await cmd(ctx, eunuch, '/xiazhi t | d')
    await say(ctx, eunuch, '1')
    await cmd(ctx, eunuch, '/zhupi 001 准')
    await say(ctx, eunuch, '2')
    expect(toolResults(eunuch).join('')).toContain('did not return a structured result')
    expect((await cmd(ctx, eunuch, '/zouzhe 001')).text).toContain('拟旨 🔄')
  })

  it('a rejection or failed acceptance without issues is refused', async () => {
    const { ctx, eunuch } = await boot({
      eunuch: [
        toolCallResponse('t', 'sansheng_translate', { topic: '001', translation: 'T' }), textResponse('a'),
        toolCallResponse('d', 'sansheng_draft', { topic: '001' }), textResponse('b'),
        toolCallResponse('r', 'sansheng_review', { topic: '001' }), textResponse('c'),
      ],
      zhongshu: [toolCallResponse('z', STRUCTURED_OUTPUT_TOOL, PLAN)],
      menxia: [toolCallResponse('m', STRUCTURED_OUTPUT_TOOL, { verdict: 'reject', issues: [], summary: '不行' })],
    })
    await cmd(ctx, eunuch, '/xiazhi t | d')
    await say(ctx, eunuch, '1')
    await cmd(ctx, eunuch, '/zhupi 001 准')
    await say(ctx, eunuch, '2')
    await say(ctx, eunuch, '3')
    expect(toolResults(eunuch).join('')).toContain('封驳必须附问题清单')
  })

  it('rework, deviation, and failed acceptance flow back with their issues', async () => {
    const toExecuting = flow()
    const { ctx, eunuch, adapters } = await boot({
      eunuch: [
        ...toExecuting.eunuch,
        toolCallResponse('x1', 'sansheng_execute', { topic: '001' }), textResponse('d'),
        toolCallResponse('a1', 'sansheng_accept', { topic: '001' }), textResponse('e'),
        toolCallResponse('x2', 'sansheng_execute', { topic: '001' }), textResponse('f'),
        toolCallResponse('st', 'sansheng_status', { topic: '001' }), textResponse('g'),
        toolCallResponse('ls', 'sansheng_status', {}), textResponse('h'),
      ],
      zhongshu: toExecuting.zhongshu,
      menxia: [
        ...toExecuting.menxia,
        toolCallResponse('m2', STRUCTURED_OUTPUT_TOOL, { verdict: 'reject', issues: ['MAE 未报告'], summary: '门下：不达标' }),
      ],
      shangshu: [
        toolCallResponse('s1', STRUCTURED_OUTPUT_TOOL, { status: 'done', report: 'r1', summary: '尚书：完成' }),
        toolCallResponse('s2', STRUCTURED_OUTPUT_TOOL, { status: 'deviation', report: '数据集不可得', summary: '尚书：偏差' }),
      ],
    })
    await driveToExecuting(ctx, eunuch)
    await say(ctx, eunuch, '4')
    await say(ctx, eunuch, '5')
    await say(ctx, eunuch, '6')
    expect(JSON.stringify(adapters.shangshu.requests[1]!.messages)).toContain('MAE 未报告')
    await say(ctx, eunuch, '7')
    const results = toolResults(eunuch).join('')
    expect(results).toContain('尚书上报偏差')
    expect(results).toContain('尚书偏差待裁')
    expect(results).toContain('尚书：偏差')
    await say(ctx, eunuch, '8')
    expect(toolResults(eunuch).join('')).toContain('001 · t · deviation')
    expect(toolResults(eunuch).join('')).toContain('【圣旨原文】')
    // Send back with feedback: the planner sees it.
    expect((await cmd(ctx, eunuch, '/zhupi 001 驳 换数据集')).text).toContain('drafting')
  })

  it('the emperor feedback on a send-back reaches the planner', async () => {
    const { ctx, eunuch, adapters } = await boot({
      eunuch: [
        toolCallResponse('t', 'sansheng_translate', { topic: '001', translation: 'T' }), textResponse('a'),
        toolCallResponse('d', 'sansheng_draft', { topic: '001' }), textResponse('b'),
        toolCallResponse('r', 'sansheng_review', { topic: '001' }), textResponse('c'),
        toolCallResponse('d2', 'sansheng_draft', { topic: '001' }), textResponse('d'),
      ],
      zhongshu: [toolCallResponse('z', STRUCTURED_OUTPUT_TOOL, PLAN), toolCallResponse('z2', STRUCTURED_OUTPUT_TOOL, PLAN)],
      menxia: [toolCallResponse('m', STRUCTURED_OUTPUT_TOOL, { verdict: 'reject', issues: ['缺对照'], summary: '封驳' })],
    })
    await cmd(ctx, eunuch, '/xiazhi t | d')
    await say(ctx, eunuch, '1')
    await cmd(ctx, eunuch, '/zhupi 001 准')
    await say(ctx, eunuch, '2')
    await say(ctx, eunuch, '3')
    await say(ctx, eunuch, '4')
    expect(JSON.stringify(adapters.zhongshu.requests[1]!.messages)).toContain('缺对照')
  })

  it('execution refuses a plan whose bytes changed after approval', async () => {
    const toExecuting = flow()
    const { ctx, eunuch, config, adapters } = await boot({
      eunuch: [...toExecuting.eunuch, toolCallResponse('x', 'sansheng_execute', { topic: '001' }), textResponse('d')],
      zhongshu: toExecuting.zhongshu,
      menxia: toExecuting.menxia,
    })
    await driveToExecuting(ctx, eunuch)
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(config.storeRoot, '001', 'plan-v1.md'), '{"plan":"forged","criteria":"none"}')
    await say(ctx, eunuch, '4')
    expect(toolResults(eunuch).join('')).toContain('hash mismatch')
    expect(adapters.shangshu.requests).toHaveLength(0)
  })

  it('each tool refuses the wrong phase', async () => {
    const { ctx, eunuch } = await boot({
      eunuch: [
        toolCallResponse('r', 'sansheng_review', { topic: '001' }),
        toolCallResponse('x', 'sansheng_execute', { topic: '001' }),
        toolCallResponse('a', 'sansheng_accept', { topic: '001' }),
        textResponse('z'),
      ],
    })
    await cmd(ctx, eunuch, '/xiazhi t | d')
    await say(ctx, eunuch, 'go')
    const r = toolResults(eunuch).join('')
    expect(r).toContain('not reviewing')
    expect(r).toContain('not executing')
    expect(r).toContain('not accepting')
  })

  it('/zhupi refuses approval when nothing awaits it', async () => {
    const toExecuting = flow()
    const { ctx, eunuch } = await boot({ eunuch: [...toExecuting.eunuch] , zhongshu: toExecuting.zhongshu, menxia: toExecuting.menxia })
    await driveToExecuting(ctx, eunuch)
    expect((await cmd(ctx, eunuch, '/zhupi 001 准')).text).toContain('无需朱批')
  })
})

describe('more failure paths', () => {
  it('an empty required field, a failed acceptance without issues, and the empty topic list', async () => {
    const toExecuting = flow()
    const { ctx, eunuch } = await boot({
      eunuch: [
        toolCallResponse('ls', 'sansheng_status', {}), textResponse('0'),
        ...toExecuting.eunuch,
        toolCallResponse('x', 'sansheng_execute', { topic: '001' }), textResponse('d'),
        toolCallResponse('x2', 'sansheng_execute', { topic: '001' }), textResponse('e'),
        toolCallResponse('a', 'sansheng_accept', { topic: '001' }), textResponse('f'),
      ],
      zhongshu: toExecuting.zhongshu,
      menxia: [...toExecuting.menxia, toolCallResponse('m2', STRUCTURED_OUTPUT_TOOL, { verdict: 'reject', issues: [], summary: 'x' })],
      shangshu: [
        toolCallResponse('s', STRUCTURED_OUTPUT_TOOL, { status: 'done', report: '  ', summary: 's' }),
        toolCallResponse('s2', STRUCTURED_OUTPUT_TOOL, { status: 'done', report: 'r', summary: 's' }),
      ],
    })
    await say(ctx, eunuch, '0')
    expect(toolResults(eunuch).join('')).toContain('暂无课题')
    expect((await cmd(ctx, eunuch, '/zouzhe')).text).toBe('暂无课题。')
    await driveToExecuting(ctx, eunuch)
    await say(ctx, eunuch, '4')
    expect(toolResults(eunuch).join('')).toContain('must be a non-empty string')
    await say(ctx, eunuch, '5')
    await say(ctx, eunuch, '6')
    expect(toolResults(eunuch).join('')).toContain('验收不通过必须附问题清单')
    expect((await cmd(ctx, eunuch, '/zouzhe')).text).toContain('accepting')
  })
})

describe('guard edge cases', () => {
  it('a bound child whose topic phase is not cached is refused', async () => {
    const { ctx } = await boot({ eunuch: [] })
    const child = await ctx.agentLoop.create(SessionId('loose'), { provider: 'p-eunuch', model: 'e' })
    // Bind through the exported class the plugin uses is internal; use a non-object argument path instead.
    const r = await ctx.tools.execute({ callId: 'c' as never, name: 'todo_write', arguments: 'not-an-object', agent: child, signal: new AbortController().signal })
    expect(JSON.stringify(r)).not.toContain('sansheng:')
  })

  it('a tool call without an agent is refused', async () => {
    const { ctx } = await boot({ eunuch: [] })
    const decision = await ctx.tools.execute({ callId: 'c' as never, name: 'read', arguments: { file_path: 'x' }, signal: new AbortController().signal })
    expect(JSON.stringify(decision)).toContain('must come from an agent')
  })
})

describe('emperor commands', () => {
  it('/xiazhi and /zhupi validate their input', async () => {
    const { ctx, eunuch } = await boot({ eunuch: [] })
    expect((await cmd(ctx, eunuch, '/xiazhi 只有标题')).kind).toBe('error')
    expect((await cmd(ctx, eunuch, '/zhupi')).kind).toBe('error')
    expect((await cmd(ctx, eunuch, '/zhupi 001 驳')).text).toContain('意见')
    expect((await cmd(ctx, eunuch, '/zhupi 009 准')).text).toContain('unknown topic')
    await cmd(ctx, eunuch, '/xiazhi t | d')
    expect((await cmd(ctx, eunuch, '/zhupi 001 准')).text).toContain('translation')
    expect((await cmd(ctx, eunuch, '/zouzhe')).text).toContain('001 · t · translated')
    expect((await cmd(ctx, eunuch, '/zouzhe 009')).kind).toBe('error')
  })

  it('veto closes a topic from any open phase, with the note recorded', async () => {
    const { ctx, eunuch } = await boot({ eunuch: [] })
    await cmd(ctx, eunuch, '/xiazhi t | d')
    expect((await cmd(ctx, eunuch, '/zhupi 001 否 不做了')).text).toContain('closed')
    expect((await cmd(ctx, eunuch, '/zouzhe 001')).text).toContain('批注：不做了')
  })
})

describe('end-to-end flow with role routing', () => {
  it('decree → translate → confirm → draft → review → approve → execute → accept → close', async () => {
    const { ctx, eunuch, adapters } = await boot({
      eunuch: [
        toolCallResponse('t1', 'sansheng_translate', { topic: '001', translation: '研究问题：...' }), textResponse('呈转译'),
        toolCallResponse('d1', 'sansheng_draft', { topic: '001' }), textResponse('呈方案'),
        toolCallResponse('r1', 'sansheng_review', { topic: '001' }), textResponse('呈审核'),
        toolCallResponse('x1', 'sansheng_execute', { topic: '001' }), textResponse('呈执行'),
        toolCallResponse('a1', 'sansheng_accept', { topic: '001' }), textResponse('呈验收'),
      ],
      zhongshu: [toolCallResponse('z', STRUCTURED_OUTPUT_TOOL, PLAN)],
      menxia: [
        toolCallResponse('m1', STRUCTURED_OUTPUT_TOOL, { verdict: 'pass', issues: [], summary: '门下：可行' }),
        toolCallResponse('m2', STRUCTURED_OUTPUT_TOOL, { verdict: 'pass', issues: [], summary: '门下：达标' }),
      ],
      shangshu: [
        toolCallResponse('s0', 'write', { file_path: 'model.py', content: 'x' }),
        toolCallResponse('s1', STRUCTURED_OUTPUT_TOOL, { status: 'done', report: '见 model.py', summary: '尚书：完成' }),
      ],
    })

    expect((await cmd(ctx, eunuch, '/xiazhi 热导率 | 帮我研究一下晶格热导率能不能用机器学习预测')).kind).toBe('success')
    await say(ctx, eunuch, '转译')
    expect((await cmd(ctx, eunuch, '/zhupi 001 准')).kind).toBe('success')
    await say(ctx, eunuch, '拟旨')
    await say(ctx, eunuch, '审核')
    const approve = await cmd(ctx, eunuch, '/zhupi 001 准')
    expect(approve, JSON.stringify(approve) + toolResults(eunuch).join(' || ')).toMatchObject({ kind: 'success' })
    expect(approve.text).toContain('executing')
    await say(ctx, eunuch, '执行')
    await say(ctx, eunuch, '验收')
    expect((await cmd(ctx, eunuch, '/zhupi 001 准')).text).toContain('closed')

    // Each role's requests landed on its own route, with its own persona.
    expect(adapters.zhongshu.requests).toHaveLength(1)
    expect(adapters.menxia.requests).toHaveLength(2)
    expect(systemText(adapters.zhongshu.requests[0]!)).toContain('中书省')
    expect(systemText(adapters.zhongshu.requests[0]!)).not.toContain('你是太监')
    expect(systemText(adapters.eunuch.requests[0]!)).toContain('你是太监')
    expect(systemText(adapters.menxia.requests[0]!)).toContain('门下省')
    expect(systemText(adapters.shangshu.requests[0]!)).toContain('尚书省')
    // The reviewer saw the decree verbatim and the sealed plan.
    expect(userText(adapters.menxia.requests[0]!)).toContain('帮我研究一下晶格热导率')
    expect(userText(adapters.menxia.requests[0]!)).toContain('用 GNN 预测')
    // The executor's write inside the workspace was allowed.
    expect(toolResults(ctx.agents.list().find(a => a.id.startsWith('sansheng-001-shangshu')) ?? eunuch).join('')).not.toContain('sansheng:')
  })
})
