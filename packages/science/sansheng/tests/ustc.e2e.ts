import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import { mountLocalActivations } from '../../../subagent/subagent/tests/local-activation.ts'
import * as Sansheng from '../src/index.ts'

/**
 * Real-model pilot through the USTC gateway: the eunuch, planner, reviewer
 * and executor each run on their configured model. Key-gated; it prints the
 * memorial at every step so a human can judge the quality.
 */
const KEY = process.env.USTC_LLM_API_KEY
const root = mkdtempSync(join(tmpdir(), 'sansheng-ustc-'))
/** Unbuffered trace file: vitest holds console output until the test ends. */
const TRACE = process.env.SANSHENG_TRACE
const trace = (line: string): void => { if (TRACE !== undefined) appendFileSync(TRACE, `${line}
`) }
afterAll(() => { rmSync(root, { recursive: true, force: true }) })

async function boot() {
  const workspace = join(root, 'ws')
  mkdirSync(workspace, { recursive: true })
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await mountLocalActivations(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LlmPiAi, {
    providers: {
      ustc: {
        apiKeyEnv: 'USTC_LLM_API_KEY',
        api: 'openai-completions',
        baseURL: 'https://api.llm.ustc.edu.cn/v1',
        models: [{ id: 'deepseek-flash' }, { id: 'qwen3.8-reasoner' }, { id: 'qwen3.8-flash-next' }],
      },
    },
  })
  await ctx.plugin(SubagentRuntime, { maxDepth: 3 })
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(ToolFs, {})
  await ctx.plugin(Sansheng, {
    storeRoot: join(root, 'store'),
    workspaceRoot: workspace,
    protectedRoots: [],
    provider: 'spawn',
    routes: {
      zhongshu: { provider: 'ustc', model: 'deepseek-flash' },
      menxia: { provider: 'ustc', model: 'qwen3.8-reasoner' },
      shangshu: { provider: 'ustc', model: 'qwen3.8-flash-next' },
    },
  })
  // Live trace: every tool call by every agent, as it happens.
  const t0 = Date.now()
  ctx.on('tools/pre-execute', (exec, next) => {
    const who = exec.agent?.id ?? '?'
    trace(`  ${((Date.now() - t0) / 1000).toFixed(0)}s ${who.slice(0, 32)} → ${exec.name} ${JSON.stringify(exec.arguments).slice(0, 160)}`)
    return next()
  })
  ctx.on('llm/stream', async function* (options, next) {
    const tag = options.model
    const started = Date.now()
    let chunks = 0
    let reasoning = 0
    trace(`  ${((started - t0) / 1000).toFixed(0)}s LLM start ${tag} msgs=${options.messages.length} tools=${options.tools?.length ?? 0} maxTokens=${String(options.maxTokens)} effort=${String(options.reasoningEffort)}`)
    try {
      for await (const chunk of next()) {
        chunks++
        if (chunk.type === 'reasoning-delta') reasoning += chunk.text.length
        if (chunk.type === 'finish') trace(`  ${((Date.now() - t0) / 1000).toFixed(0)}s LLM finish ${tag} ${JSON.stringify(chunk.reason)} chunks=${chunks} reasoningChars=${reasoning} took=${((Date.now() - started) / 1000).toFixed(0)}s`)
        yield chunk
      }
    } catch (e) {
      trace(`  ${((Date.now() - t0) / 1000).toFixed(0)}s LLM ERROR ${tag} ${(e as Error).message.slice(0, 200)}`)
      throw e
    }
  })
  ctx.on('agent/status', ({ agent, status }) => {
    trace(`  ${((Date.now() - t0) / 1000).toFixed(0)}s ${agent.id.slice(0, 32)} status=${status}`)
  })
  const eunuch = await ctx.agentLoop.create(SessionId('eunuch'), { provider: 'ustc', model: 'deepseek-flash' })
  return { ctx, eunuch, workspace }
}

async function say(ctx: Context, agent: Agent, text: string): Promise<void> {
  const from = agent.session.snapshotEvents().length
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  do { await agent.whenIdle() } while (await ctx.subagents.waitForChildren(agent))
  // Print what the eunuch did this turn: its words and every tool call/result.
  for (const e of agent.session.snapshotEvents().slice(from)) {
    if (e.type === 'assistant/message' || e.type === 'tool/result' || e.type === 'turn/end') {
      trace(`  [${e.type}] ${JSON.stringify(e.data).slice(0, 600)}`)
    }
  }
}

async function cmd(ctx: Context, agent: Agent, line: string): Promise<string> {
  const run = await ctx.commands.execute(agent, line, [], new AbortController().signal)
  const r = run?.result
  trace(`>>> ${line}
${r?.text ?? '(no text)'}`)
  return r?.text ?? ''
}

async function phase(ctx: Context, agent: Agent): Promise<string> {
  return cmd(ctx, agent, '/zouzhe 001')
}

describe.skipIf(KEY === undefined)('USTC pilot', { retry: 0 }, () => {
  it('runs one small topic end to end on real models', async () => {
    const { ctx, eunuch, workspace } = await boot()
    await cmd(ctx, eunuch, '/xiazhi 素数计数 | 写一个 Python 脚本统计 1 到 10000 之间的素数个数，结果写入 result.txt，并验证答案是 1229')
    await say(ctx, eunuch, '请转译课题 001 并呈上')
    expect(await phase(ctx, eunuch)).toContain('转译 🔄')
    await cmd(ctx, eunuch, '/zhupi 001 准')
    await say(ctx, eunuch, '请交中书拟旨，然后交门下审核')
    let memo = await phase(ctx, eunuch)
    for (let round = 0; round < 3 && memo.includes('拟旨 🔄'); round++) {
      await say(ctx, eunuch, '门下已封驳，请再交中书拟旨，然后交门下审核')
      memo = await phase(ctx, eunuch)
    }
    expect(memo).toMatch(/朱批 🔄|争议/)
    // A dispute needs two decisions: overrule the reviewer, then approve the plan.
    await cmd(ctx, eunuch, '/zhupi 001 准')
    if (memo.includes('争议')) await cmd(ctx, eunuch, '/zhupi 001 准')
    await say(ctx, eunuch, '请交尚书执行，完成后交门下验收')
    memo = await phase(ctx, eunuch)
    trace(`workspace files: ${readdirSync(workspace).join(', ')}`)
    expect(memo).toMatch(/复命 🔄|执行 🔄|偏差/)
  }, 40 * 60_000)
})
