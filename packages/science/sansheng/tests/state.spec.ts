import { describe, expect, it } from 'vitest'
import { apply, initialState, replay, TransitionError } from '../src/state.ts'
import type { Actor, TopicEvent, TopicState } from '../src/state.ts'

const E: Actor = 'emperor'

/** Apply a list of [actor, event] pairs from the decree state. */
function run(steps: [Actor, TopicEvent][], from: TopicState = initialState()): TopicState {
  return steps.reduce((s, [actor, ev]) => apply(s, actor, ev), from)
}

const toDrafting: [Actor, TopicEvent][] = [
  ['eunuch', { type: 'translation_submitted' }],
  [E, { type: 'translation_confirmed' }],
]
const toReview: [Actor, TopicEvent][] = [
  ...toDrafting,
  ['zhongshu', { type: 'plan_submitted', version: 1, hash: 'h1' }],
]
const toApproval: [Actor, TopicEvent][] = [
  ...toReview,
  ['menxia', { type: 'review_passed' }],
]
const toExecuting: [Actor, TopicEvent][] = [
  ...toApproval,
  [E, { type: 'approved', planHash: 'h1', criteriaHash: 'c1' }],
]
const toAccepting: [Actor, TopicEvent][] = [
  ...toExecuting,
  ['shangshu', { type: 'execution_submitted' }],
]

describe('happy path', () => {
  it('walks decree → translated → … → closed', () => {
    const s = run([
      ...toAccepting,
      ['menxia', { type: 'acceptance_passed' }],
      [E, { type: 'closed' }],
    ])
    expect(s.phase).toBe('closed')
    expect(s.approval).toEqual({ planHash: 'h1', criteriaHash: 'c1' })
  })

  it('starts in translated awaiting the emperor', () => {
    expect(initialState()).toEqual({ phase: 'translated', rejections: 0, reworks: 0, planVersion: 0, translationVersion: 0 })
  })

  it('lets the emperor send the translation back for rework', () => {
    expect(run([[E, { type: 'retranslate' }]]).phase).toBe('translated')
  })

  it('the emperor cannot confirm before a translation exists', () => {
    expect(() => run([[E, { type: 'translation_confirmed' }]])).toThrow(/translation/)
  })

  it('only the eunuch submits translations, and each bumps the version', () => {
    expect(run([['eunuch', { type: 'translation_submitted' }], ['eunuch', { type: 'translation_submitted' }]]).translationVersion).toBe(2)
    expect(() => run([['zhongshu', { type: 'translation_submitted' }]])).toThrow(TransitionError)
  })

  it('does not mutate the input state', () => {
    const s0 = initialState()
    const s1 = apply(s0, 'eunuch', { type: 'translation_submitted' })
    expect(s0.phase).toBe('translated')
    expect(s1).not.toBe(s0)
  })
})

describe('authority', () => {
  it('only the emperor may approve', () => {
    for (const actor of ['eunuch', 'zhongshu', 'menxia', 'shangshu', 'system'] as Actor[]) {
      expect(() => run([...toApproval, [actor, { type: 'approved', planHash: 'h1', criteriaHash: 'c1' }]]))
        .toThrow(TransitionError)
    }
  })

  it('only the emperor may confirm a translation', () => {
    expect(() => run([['eunuch', { type: 'translation_confirmed' }]])).toThrow(/emperor/)
  })

  it('the planner cannot pass its own plan', () => {
    expect(() => run([...toReview, ['zhongshu', { type: 'review_passed' }]])).toThrow(TransitionError)
  })

  it('the executor cannot accept its own work', () => {
    expect(() => run([...toAccepting, ['shangshu', { type: 'acceptance_passed' }]])).toThrow(TransitionError)
  })
})

describe('illegal transitions', () => {
  it('cannot execute before approval', () => {
    expect(() => run([...toApproval, ['shangshu', { type: 'execution_submitted' }]])).toThrow(/awaiting_approval/)
  })

  it('cannot skip review', () => {
    expect(() => run([...toReview, [E, { type: 'approved', planHash: 'h1', criteriaHash: 'c1' }]])).toThrow(TransitionError)
  })

  it('approval must bind the plan hash under review', () => {
    expect(() => run([...toApproval, [E, { type: 'approved', planHash: 'other', criteriaHash: 'c1' }]]))
      .toThrow(/hash/)
  })

  it('plan versions must be sequential', () => {
    expect(() => run([
      ...toDrafting,
      ['zhongshu', { type: 'plan_submitted', version: 2, hash: 'h' }],
    ])).toThrow(/version/)
  })

  it('nothing happens after closing', () => {
    const closed = run([...toApproval, [E, { type: 'vetoed' }]])
    expect(closed.phase).toBe('closed')
    expect(() => apply(closed, E, { type: 'translation_confirmed' })).toThrow(TransitionError)
  })
})

describe('review rejection cap (k = 2)', () => {
  const reject: [Actor, TopicEvent] = ['menxia', { type: 'review_rejected' }]
  const resubmit = (v: number): [Actor, TopicEvent] => ['zhongshu', { type: 'plan_submitted', version: v, hash: `h${v}` }]

  it('first and second rejection return to drafting', () => {
    const s1 = run([...toReview, reject])
    expect(s1).toMatchObject({ phase: 'drafting', rejections: 1 })
    const s2 = run([resubmit(2), reject], s1)
    expect(s2).toMatchObject({ phase: 'drafting', rejections: 2 })
  })

  it('third rejection escalates to a dispute for the emperor', () => {
    const s = run([...toReview, reject, resubmit(2), reject, resubmit(3), reject])
    expect(s).toMatchObject({ phase: 'disputed', rejections: 3 })
  })

  it('the emperor can overrule the reviewer, send back, or veto a dispute', () => {
    const disputed = run([...toReview, reject, resubmit(2), reject, resubmit(3), reject])
    expect(apply(disputed, E, { type: 'overruled' }).phase).toBe('awaiting_approval')
    expect(apply(disputed, E, { type: 'sent_back' })).toMatchObject({ phase: 'drafting', rejections: 0 })
    expect(apply(disputed, E, { type: 'vetoed' }).phase).toBe('closed')
  })

  it('overruling keeps the latest plan hash bindable', () => {
    const disputed = run([...toReview, reject, resubmit(2), reject, resubmit(3), reject])
    const s = run([[E, { type: 'overruled' }], [E, { type: 'approved', planHash: 'h3', criteriaHash: 'c' }]], disputed)
    expect(s.phase).toBe('executing')
  })
})

describe('rework cap (N = 2)', () => {
  const fail: [Actor, TopicEvent] = ['menxia', { type: 'acceptance_failed' }]
  const resubmit: [Actor, TopicEvent] = ['shangshu', { type: 'execution_submitted' }]

  it('first and second failure return to execution', () => {
    const s1 = run([...toAccepting, fail])
    expect(s1).toMatchObject({ phase: 'executing', reworks: 1 })
    expect(run([resubmit, fail], s1)).toMatchObject({ phase: 'executing', reworks: 2 })
  })

  it('third failure escalates to a deviation for the emperor', () => {
    expect(run([...toAccepting, fail, resubmit, fail, resubmit, fail])).toMatchObject({ phase: 'deviation', reworks: 3 })
  })

  it('a deviation can be resumed, amended, or vetoed by the emperor', () => {
    const dev = run([...toExecuting, ['shangshu', { type: 'deviation_reported' }]])
    expect(dev.phase).toBe('deviation')
    expect(apply(dev, E, { type: 'resume' }).phase).toBe('executing')
    expect(apply(dev, E, { type: 'sent_back' })).toMatchObject({ phase: 'drafting', reworks: 0, rejections: 0 })
    expect(apply(dev, E, { type: 'vetoed' }).phase).toBe('closed')
  })

  it('an amendment needs a fresh approval and resets the rework count', () => {
    const dev = run([...toAccepting, fail, resubmit, fail, resubmit, fail])
    const s = run([
      [E, { type: 'sent_back' }],
      ['zhongshu', { type: 'plan_submitted', version: 2, hash: 'h2' }],
      ['menxia', { type: 'review_passed' }],
      [E, { type: 'approved', planHash: 'h2', criteriaHash: 'c2' }],
    ], dev)
    expect(s).toMatchObject({ phase: 'executing', reworks: 0, approval: { planHash: 'h2', criteriaHash: 'c2' } })
  })
})

describe('review fixes', () => {
  it('sending back clears the withdrawn approval and plan hash', () => {
    const dev = run([...toExecuting, ['shangshu', { type: 'deviation_reported' }]])
    const s = apply(dev, E, { type: 'sent_back' })
    expect(s.approval).toBeUndefined()
    expect(s.planHash).toBeUndefined()
    expect('approval' in s).toBe(false)
  })

  it('resuming after the rework cap grants a fresh set of attempts', () => {
    const fail: [Actor, TopicEvent] = ['menxia', { type: 'acceptance_failed' }]
    const resubmit: [Actor, TopicEvent] = ['shangshu', { type: 'execution_submitted' }]
    const dev = run([...toAccepting, fail, resubmit, fail, resubmit, fail])
    const s = run([[E, { type: 'resume' }], resubmit, fail], dev)
    expect(s).toMatchObject({ phase: 'executing', reworks: 1 })
  })

  it('the emperor can veto at any open phase', () => {
    const prefixes: [Actor, TopicEvent][][] = [[], toDrafting, toReview, toApproval, toExecuting, toAccepting]
    for (const p of prefixes) expect(run([...p, [E, { type: 'vetoed' }]]).phase).toBe('closed')
  })

  it('nobody else can veto', () => {
    expect(() => run([...toExecuting, ['menxia', { type: 'vetoed' }]])).toThrow(TransitionError)
  })
})

describe('replay validation', () => {
  it('rejects empty hashes and non-integer versions', () => {
    expect(() => replay([
      { actor: 'eunuch', event: { type: 'translation_submitted' } },
      { actor: E, event: { type: 'translation_confirmed' } },
      { actor: 'zhongshu', event: { type: 'plan_submitted', version: 1 } as never },
    ])).toThrow(TransitionError)
    expect(() => replay([
      { actor: 'eunuch', event: { type: 'translation_submitted' } },
      { actor: E, event: { type: 'translation_confirmed' } },
      { actor: 'zhongshu', event: { type: 'plan_submitted', version: 1.5, hash: 'h' } },
    ])).toThrow(TransitionError)
  })

  it('rejects an approval with missing hashes', () => {
    expect(() => replay([
      { actor: 'eunuch', event: { type: 'translation_submitted' } },
      { actor: E, event: { type: 'translation_confirmed' } },
      { actor: 'zhongshu', event: { type: 'plan_submitted', version: 1, hash: 'h1' } },
      { actor: 'menxia', event: { type: 'review_passed' } },
      { actor: E, event: { type: 'approved' } as never },
    ])).toThrow(TransitionError)
  })

  it('rejects unknown event types, including prototype keys', () => {
    for (const type of ['constructor', 'toString', '__proto__', 'nope']) {
      expect(() => replay([{ actor: E, event: { type } as never }])).toThrow(TransitionError)
    }
  })

  it('rejects unknown actors and malformed entries', () => {
    expect(() => replay([{ actor: 'god' as Actor, event: { type: 'translation_confirmed' } }])).toThrow(TransitionError)
    expect(() => replay([null as never])).toThrow(TransitionError)
    expect(() => replay([{ actor: E, event: null } as never])).toThrow(TransitionError)
  })
})

describe('replay', () => {
  it('folds a ledger into state', () => {
    const s = replay([
      { actor: 'eunuch', event: { type: 'translation_submitted' } },
      { actor: E, event: { type: 'translation_confirmed' } },
      { actor: 'zhongshu', event: { type: 'plan_submitted', version: 1, hash: 'h1' } },
    ])
    expect(s.phase).toBe('reviewing')
  })

  it('fails loudly on a corrupt ledger', () => {
    expect(() => replay([{ actor: 'shangshu', event: { type: 'execution_submitted' } }])).toThrow(TransitionError)
  })
})
