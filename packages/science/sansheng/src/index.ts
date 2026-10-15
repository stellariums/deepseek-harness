/**
 * 三省制 governance plugin. The root session is the eunuch (太监); it drives
 * the workflow through `sansheng_*` tools that spawn the planner (中书),
 * reviewer (门下) and executor (尚书) as structured-output children, each on
 * its own model. A tool guard applies {@link decide} to every call by every
 * agent; descendants inherit the binding of the nearest bound ancestor, so an
 * executor's own subagents stay inside the executor's bounds. Approvals come
 * only from the human-invoked `/zhupi` command.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
// Service augmentations for ctx.subagents / ctx.commands / ctx.systemPrompt.
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { decide } from './policy.ts'
import type { Phase } from './state.ts'
import type { Binding, Role } from './policy.ts'
import { TopicStore } from './store.ts'
import { registerCommands } from './commands.ts'
import { registerTools } from './tools.ts'
import { PERSONAS } from './prompts.ts'

export const name = 'sansheng'
export const inject = ['tools', 'agents', 'subagents', 'systemPrompt']

export interface RoleRoute {
  provider: string
  model: string
}

export interface Config {
  /** Absolute directory of the record store; must lie outside the workspace. */
  storeRoot: string
  /** Absolute workspace root the executor may write. */
  workspaceRoot: string
  /** Further directories no agent may read or write (harness home, config). */
  protectedRoots: string[]
  /** Subagent provider used for the three 省 (must be fresh, structured-output capable). */
  provider: string
  routes: { zhongshu: RoleRoute; menxia: RoleRoute; shangshu: RoleRoute }
}

const Route: z<RoleRoute> = z.object({ provider: z.string().required(), model: z.string().required() })

export const Config: z<Config> = z.object({
  storeRoot: z.string().required(),
  workspaceRoot: z.string().required(),
  protectedRoots: z.array(z.string()).default([]),
  provider: z.string().default('spawn'),
  routes: z.object({ zhongshu: Route, menxia: Route, shangshu: Route }),
})

/** Live role bindings, keyed by agent/session id. */
export class Bindings {
  private readonly byId = new Map<SessionId, Binding>()

  constructor(private readonly ctx: Context) {}

  bind(id: SessionId, binding: Binding): () => void {
    this.byId.set(id, binding)
    return () => { this.byId.delete(id) }
  }

  /**
   * Nearest bound ancestor's binding; an unbound root is the eunuch.
   * @returns the binding and topic, or a eunuch binding with no topic.
   */
  resolve(agent: Agent): Binding | { role: 'eunuch'; topicId: undefined } {
    let cursor: Agent | undefined = agent
    for (let hops = 0; cursor !== undefined && hops < 64; hops++) {
      const own = this.byId.get(cursor.id)
      if (own !== undefined) return own
      const parentId = cursor.session.header.parentSession
      if (parentId === undefined) return { role: 'eunuch', topicId: undefined }
      cursor = this.ctx.agents.get(parentId)
    }
    // A child whose parent left the registry, or a cycle: fail closed.
    return { role: 'zhongshu', topicId: '__orphan__' }
  }
}

export function apply(ctx: Context, config: Config): void {
  const store = new TopicStore(config.storeRoot)
  const bindings = new Bindings(ctx)
  const protectedRoots = [config.storeRoot, ...config.protectedRoots]
  // Phase cache, refreshed by every transition the tools commit.
  const phases = new Map<string, Awaited<ReturnType<TopicStore['state']>>['phase']>()
  const env = { ctx, config, store, bindings, phases }

  ctx.tools.guard(exec => guardCall(env, protectedRoots, exec))

  // The eunuch persona belongs to root sessions only; role children get theirs per spawn.
  ctx.on('agent/created', ({ agent }) => {
    if (agent.session.header.parentSession !== undefined) return
    agent.ctx.systemPrompt.section({
      name: 'sansheng:eunuch',
      order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX') - 1,
      text: PERSONAS.eunuch,
    })
  })

  registerTools(env)
  ctx.inject(['commands'], (c) => { registerCommands(c, env) })
}

/**
 * The guard body: resolve the caller's role and topic phase, then decide.
 * Fails closed on agent-less calls, orphaned children, and unloaded topics.
 */
export function guardCall(env: Env, protectedRoots: readonly string[], exec: Readonly<ToolExecution>): string | undefined {
  const agent = exec.agent
  if (agent === undefined) return 'sansheng: tool calls must come from an agent'
  const who = env.bindings.resolve(agent)
  if (who.topicId === '__orphan__') return 'sansheng: caller has no live bound ancestor'
  const phase = who.topicId === undefined ? 'translated' : env.phases.get(who.topicId)
  if (phase === undefined) return `sansheng: topic ${who.topicId} is not loaded`
  const args = (typeof exec.arguments === 'object' && exec.arguments !== null ? exec.arguments : {}) as Record<string, unknown>
  const cwd = agent.session.header.cwd ?? env.config.workspaceRoot
  const binding: Binding = { role: who.role, topicId: who.topicId ?? '' }
  const denied = decide(binding, { protectedRoots, workspaceRoot: env.config.workspaceRoot, cwd, phase: phase as Phase }, exec.name, args)
  return denied === undefined ? undefined : `sansheng: ${denied}`
}

export type Env = {
  readonly ctx: Context
  readonly config: Config
  readonly store: TopicStore
  readonly bindings: Bindings
  readonly phases: Map<string, string>
}

export type { Binding, Role }
