import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { eventFor, parseZhupi } from '../src/commands.ts'
import { Bindings, guardCall } from '../src/index.ts'
import type { Env } from '../src/index.ts'
import { renderMemorial } from '../src/memorial.ts'
import { acceptPrompt, draftPrompt, executePrompt, reviewPrompt } from '../src/prompts.ts'
import { claimedDeliverables, missingDeliverables } from '../src/tools.ts'
import { initialState } from '../src/state.ts'
import type { Phase, TopicState } from '../src/state.ts'

const at = (phase: Phase): TopicState => ({ ...initialState(), phase })
const approval = { planHash: 'p', criteriaHash: 'c' }

describe('parseZhupi', () => {
  it('parses each decision', () => {
    expect(parseZhupi('001 准')).toEqual({ topic: '001', decision: 'approve', note: '' })
    expect(parseZhupi(' 012 驳 缺对照组 ')).toEqual({ topic: '012', decision: 'reject', note: '缺对照组' })
    expect(parseZhupi('001 否')).toMatchObject({ decision: 'veto' })
  })

  it('rejects malformed input', () => {
    expect(parseZhupi('准')).toMatch(/用法/)
    expect(parseZhupi('1 准')).toMatch(/用法/)
    expect(parseZhupi('001 驳')).toMatch(/意见/)
  })
})

describe('eventFor', () => {
  it('maps each awaiting phase', () => {
    expect(eventFor(at('translated'), 'approve')).toEqual({ type: 'translation_confirmed' })
    expect(eventFor(at('translated'), 'reject')).toEqual({ type: 'retranslate' })
    expect(eventFor(at('awaiting_approval'), 'approve', approval)).toEqual({ type: 'approved', ...approval })
    expect(eventFor(at('awaiting_approval'), 'approve')).toMatch(/缺少/)
    expect(eventFor(at('awaiting_approval'), 'reject')).toEqual({ type: 'sent_back' })
    expect(eventFor(at('disputed'), 'approve')).toEqual({ type: 'overruled' })
    expect(eventFor(at('disputed'), 'reject')).toEqual({ type: 'sent_back' })
    expect(eventFor(at('deviation'), 'approve')).toEqual({ type: 'resume' })
    expect(eventFor(at('deviation'), 'reject')).toEqual({ type: 'sent_back' })
    expect(eventFor(at('awaiting_close'), 'approve')).toEqual({ type: 'closed' })
    expect(eventFor(at('awaiting_close'), 'reject')).toMatch(/只能/)
  })

  it('veto works anywhere; other decisions are refused where nothing awaits', () => {
    expect(eventFor(at('executing'), 'veto')).toEqual({ type: 'vetoed' })
    expect(eventFor(at('executing'), 'approve')).toMatch(/无需朱批/)
  })
})

describe('renderMemorial', () => {
  it('names the pending decision for each awaiting phase', () => {
    for (const phase of ['translated', 'awaiting_approval', 'disputed', 'deviation', 'awaiting_close'] as Phase[]) {
      expect(renderMemorial('001', at(phase), [], '/s')).toContain('/zhupi 001')
    }
    expect(renderMemorial('001', at('executing'), [], '/s')).toContain('【待圣裁】无')
  })

  it('shows progress and verbatim summaries and notes', () => {
    const text = renderMemorial('001', at('reviewing'), [
      { actor: 'zhongshu', event: { type: 'plan_submitted', version: 1, hash: 'h' }, at: 't', doc: { name: 'plan-v1', hash: 'h' } },
      { actor: 'emperor', event: { type: 'retranslate' }, at: 't', note: '再想想' },
      { actor: 'god' as never, event: { type: 'retranslate' }, at: 't' },
    ], '/s', { 'plan-v1': '中书：GNN 方案' })
    expect(text).toContain('转译 ✅ → 拟旨 ✅ → 审核 🔄 → 朱批 ⬜')
    expect(text).toContain('中书 · plan_submitted：中书：GNN 方案')
    expect(text).toContain('批注：再想想')
    expect(text).toContain('god · retranslate')
  })

  it('a closed topic shows every step done', () => {
    expect(renderMemorial('001', at('closed'), [], '/s')).toContain('复命 ✅')
  })
})

describe('prompts', () => {
  it('include optional sections only when present', () => {
    expect(draftPrompt({ decree: 'd', translation: 't' })).not.toContain('封驳')
    expect(draftPrompt({ decree: 'd', translation: 't' })).not.toContain('上一版方案')
    expect(draftPrompt({ decree: 'd', translation: 't', previousPlan: 'p1' })).toContain('上一版方案')
    const d = draftPrompt({ decree: 'd', translation: 't', issues: ['a'], feedback: 'f' })
    expect(d).toContain('- a')
    expect(d).toContain('皇帝意见')
    expect(executePrompt({ plan: 'p', criteria: 'c' })).not.toContain('未通过')
    expect(executePrompt({ plan: 'p', criteria: 'c', issues: ['x'] })).toContain('- x')
    expect(reviewPrompt({ decree: 'd', translation: 't', plan: 'p', criteria: 'c' })).toContain('待审方案')
    expect(acceptPrompt({ plan: 'p', criteria: 'c', report: 'r' })).toContain('尚书执行报告')
  })
})

describe('claimedDeliverables', () => {
  const root = process.platform === 'win32' ? 'E:\\ws' : '/ws'
  const j = (...p: string[]): string => [root, ...p].join(process.platform === 'win32' ? '\\' : '/')

  it('collects code spans and bare file paths, deduplicated', () => {
    const report = '交付物：`result.txt` 与 `result.txt`，另见 prime_count.py。'
    const claims = claimedDeliverables(report, root)
    expect(claims).toEqual([j('result.txt'), j('prime_count.py')])
  })

  it('keeps relative paths inside the workspace and resolves nested ones', () => {
    expect(claimedDeliverables('输出在 output/result.txt', root)).toEqual([j('output', 'result.txt')])
  })

  it('drops absolute paths outside the workspace and directory-like claims', () => {
    expect(claimedDeliverables('参考 E:\\other\\x.txt 与工作区目录 `data/`', root)).toEqual([])
  })

  it('accepts an absolute path inside the workspace', () => {
    const abs = process.platform === 'win32' ? 'E:\\ws\\out\\result.txt' : '/ws/out/result.txt'
    expect(claimedDeliverables(`写入 ${abs}`, root)).toEqual([j('out', 'result.txt')])
  })

  it('ignores numbers and version-like tokens', () => {
    expect(claimedDeliverables('版本 3.5，占比 0.75，参见图 2.1', root)).toEqual([])
  })

  it('missingDeliverables lists only absent files', async () => {
    const here = import.meta.dirname
    expect(await missingDeliverables([`${here}/units.spec.ts`, `${here}/nope.txt`])).toEqual([`${here}/nope.txt`])
  })
})

describe('guardCall fails closed', () => {
  const agent = (id: string, parent?: string) => ({
    id: SessionId(id),
    session: { header: parent === undefined ? {} : { parentSession: SessionId(parent) } },
  }) as never
  const env = (live: Record<string, unknown>, phases: Record<string, string>): Env => {
    const ctx = new Context() as unknown as { agents: { get: (id: string) => unknown } }
    ctx.agents = { get: id => live[id] }
    return {
      ctx: ctx as never,
      config: { storeRoot: '/s', workspaceRoot: '/w', protectedRoots: [], provider: 'spawn', routes: {} as never },
      store: {} as never,
      bindings: new Bindings(ctx as never),
      phases: new Map(Object.entries(phases)),
    }
  }

  it('refuses an orphaned child', () => {
    expect(guardCall(env({}, {}), [], { name: 'read', arguments: {}, agent: agent('c', 'gone') } as never)).toMatch(/no live bound ancestor/)
  })

  it('refuses a bound role whose topic phase is not loaded', () => {
    const e = env({}, {})
    e.bindings.bind(SessionId('c'), { role: 'menxia', topicId: '007' })
    expect(guardCall(e, [], { name: 'read', arguments: {}, agent: agent('c') } as never)).toMatch(/007 is not loaded/)
  })

  it('treats non-object arguments as empty and falls back to the workspace cwd', () => {
    const e = env({}, { '001': 'executing' })
    e.bindings.bind(SessionId('c'), { role: 'shangshu', topicId: '001' })
    expect(guardCall(e, [], { name: 'read', arguments: 'x', agent: agent('c') } as never)).toMatch(/file path is required/)
  })
})
