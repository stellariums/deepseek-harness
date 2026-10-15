/**
 * Topic state machine (宫规). A pure reducer: every legal transition is listed
 * in {@link RULES}; anything else throws. Authority is checked here, so no
 * caller can reach a phase the rules do not grant to that actor.
 */

/** Who performs a transition. `system` is the plugin itself (never an LLM). */
export type Actor = 'emperor' | 'eunuch' | 'zhongshu' | 'menxia' | 'shangshu' | 'system'

export type Phase =
  | 'translated'        // 转译待确认
  | 'drafting'          // 拟旨中
  | 'reviewing'         // 审核中
  | 'awaiting_approval' // 待朱批
  | 'disputed'          // 争议待裁
  | 'executing'         // 执行中
  | 'deviation'         // 偏差待裁
  | 'accepting'         // 验收中
  | 'awaiting_close'    // 待复命
  | 'closed'

export type TopicEvent =
  | { type: 'translation_submitted' }
  | { type: 'retranslate' }
  | { type: 'translation_confirmed' }
  | { type: 'plan_submitted'; version: number; hash: string }
  | { type: 'review_passed' }
  | { type: 'review_rejected' }
  | { type: 'approved'; planHash: string; criteriaHash: string }
  | { type: 'overruled' }
  | { type: 'sent_back' }
  | { type: 'vetoed' }
  | { type: 'deviation_reported' }
  | { type: 'resume' }
  | { type: 'execution_submitted' }
  | { type: 'acceptance_passed' }
  | { type: 'acceptance_failed' }
  | { type: 'closed' }

export interface TopicState {
  readonly phase: Phase
  /** 封驳 count for the current plan line; > MAX_REJECTIONS escalates. */
  readonly rejections: number
  /** 返工 count under the current approval; > MAX_REWORKS escalates. */
  readonly reworks: number
  readonly planVersion: number
  /** Number of translations the eunuch has submitted; confirmation needs one. */
  readonly translationVersion: number
  readonly planHash?: string
  readonly approval?: { readonly planHash: string; readonly criteriaHash: string }
}

export interface LedgerEntry {
  readonly actor: Actor
  readonly event: TopicEvent
}

export const MAX_REJECTIONS = 2
export const MAX_REWORKS = 2

export class TransitionError extends Error {
  override readonly name = 'TransitionError'
}

type EventOf<K extends TopicEvent['type']> = Extract<TopicEvent, { type: K }>

type Rule<E extends TopicEvent> = {
  readonly from: readonly Phase[]
  readonly by: readonly Actor[]
  readonly next: (s: TopicState, ev: E) => TopicState
}

const OPEN: readonly Phase[] = [
  'translated', 'drafting', 'reviewing', 'awaiting_approval', 'disputed',
  'executing', 'deviation', 'accepting', 'awaiting_close',
]
const ACTORS: ReadonlySet<string> = new Set<Actor>(['emperor', 'eunuch', 'zhongshu', 'menxia', 'shangshu', 'system'])

const EMPEROR = ['emperor'] as const

const RULES: { readonly [K in TopicEvent['type']]: Rule<EventOf<K>> } = {
  translation_submitted: {
    from: ['translated'],
    by: ['eunuch'],
    next: s => ({ ...s, translationVersion: s.translationVersion + 1 }),
  },
  retranslate: { from: ['translated'], by: EMPEROR, next: s => s },
  translation_confirmed: {
    from: ['translated'],
    by: EMPEROR,
    next: (s) => {
      if (s.translationVersion === 0) throw new TransitionError('no translation has been submitted yet')
      return { ...s, phase: 'drafting' }
    },
  },
  plan_submitted: {
    from: ['drafting'],
    by: ['zhongshu'],
    next: (s, ev) => {
      if (ev.version !== s.planVersion + 1) {
        throw new TransitionError(`plan version must be ${s.planVersion + 1}, got ${ev.version}`)
      }
      return { ...s, phase: 'reviewing', planVersion: ev.version, planHash: ev.hash }
    },
  },
  review_passed: { from: ['reviewing'], by: ['menxia'], next: s => ({ ...s, phase: 'awaiting_approval' }) },
  review_rejected: {
    from: ['reviewing'],
    by: ['menxia'],
    next: (s) => {
      const rejections = s.rejections + 1
      return { ...s, rejections, phase: rejections > MAX_REJECTIONS ? 'disputed' : 'drafting' }
    },
  },
  approved: {
    from: ['awaiting_approval'],
    by: EMPEROR,
    next: (s, ev) => {
      if (ev.planHash !== s.planHash) {
        throw new TransitionError(`approval must bind the reviewed plan hash ${s.planHash}, got ${ev.planHash}`)
      }
      return { ...s, phase: 'executing', reworks: 0, approval: { planHash: ev.planHash, criteriaHash: ev.criteriaHash } }
    },
  },
  overruled: { from: ['disputed'], by: EMPEROR, next: s => ({ ...s, phase: 'awaiting_approval' }) },
  sent_back: {
    from: ['awaiting_approval', 'disputed', 'deviation'],
    by: EMPEROR,
    next: ({ approval: _approval, planHash: _planHash, ...rest }) => ({ ...rest, phase: 'drafting', rejections: 0, reworks: 0 }),
  },
  vetoed: {
    from: OPEN,
    by: EMPEROR,
    next: s => ({ ...s, phase: 'closed' }),
  },
  deviation_reported: { from: ['executing'], by: ['shangshu', 'system'], next: s => ({ ...s, phase: 'deviation' }) },
  resume: { from: ['deviation'], by: EMPEROR, next: s => ({ ...s, phase: 'executing', reworks: 0 }) },
  execution_submitted: { from: ['executing'], by: ['shangshu'], next: s => ({ ...s, phase: 'accepting' }) },
  acceptance_passed: { from: ['accepting'], by: ['menxia'], next: s => ({ ...s, phase: 'awaiting_close' }) },
  acceptance_failed: {
    from: ['accepting'],
    by: ['menxia'],
    next: (s) => {
      const reworks = s.reworks + 1
      return { ...s, reworks, phase: reworks > MAX_REWORKS ? 'deviation' : 'executing' }
    },
  },
  closed: { from: ['awaiting_close'], by: EMPEROR, next: s => ({ ...s, phase: 'closed' }) },
}

export function initialState(): TopicState {
  return { phase: 'translated', rejections: 0, reworks: 0, planVersion: 0, translationVersion: 0 }
}

/**
 * Apply one transition, returning a new state.
 * @throws TransitionError when the actor lacks authority or the phase forbids the event.
 */
export function apply(state: TopicState, actor: Actor, event: TopicEvent): TopicState {
  validate(actor, event)
  // The mapped RULES type pairs each key with its own event shape; indexing by
  // a union key loses that pairing, so restore it at this single lookup.
  const rule = RULES[event.type] as Rule<TopicEvent>
  if (!rule.from.includes(state.phase)) {
    throw new TransitionError(`"${event.type}" is not allowed in phase ${state.phase}`)
  }
  if (!rule.by.includes(actor)) {
    throw new TransitionError(`"${event.type}" requires ${rule.by.join(' or ')}, not ${actor}`)
  }
  return rule.next(state, event)
}

/** Runtime shape check: ledgers are parsed JSON, so static types prove nothing. */
function validate(actor: unknown, event: unknown): asserts event is TopicEvent {
  if (typeof actor !== 'string' || !ACTORS.has(actor)) throw new TransitionError(`unknown actor ${String(actor)}`)
  if (typeof event !== 'object' || event === null) throw new TransitionError('event must be an object')
  const ev = event as Record<string, unknown>
  if (typeof ev['type'] !== 'string' || !Object.hasOwn(RULES, ev['type'])) {
    throw new TransitionError(`unknown event type ${String(ev['type'])}`)
  }
  if (ev['type'] === 'plan_submitted' && (!Number.isInteger(ev['version']) || !nonEmpty(ev['hash']))) {
    throw new TransitionError('plan_submitted needs an integer version and a hash')
  }
  if (ev['type'] === 'approved' && (!nonEmpty(ev['planHash']) || !nonEmpty(ev['criteriaHash']))) {
    throw new TransitionError('approved needs planHash and criteriaHash')
  }
}

function nonEmpty(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0
}

/** Fold a ledger from the initial state; a corrupt ledger throws. */
export function replay(entries: readonly LedgerEntry[]): TopicState {
  return entries.reduce((s, e: LedgerEntry | null) => {
    if (typeof e !== 'object' || e === null) throw new TransitionError('ledger entry must be an object')
    return apply(s, e.actor, e.event)
  }, initialState())
}
