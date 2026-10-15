/**
 * Topic record store (账本). One directory per topic under a root that lives
 * outside every agent's reach (the policy lists it as protected):
 *
 *   <root>/<id>/_ledger.jsonl   append-only transitions
 *   <root>/<id>/_meta.json      title, created time
 *   <root>/<id>/<doc>.md        write-once documents (decree, plan-v1, …)
 *
 * Every transition is checked by the state machine before anything is
 * written; a document carried by a transition is recorded with its hash so a
 * later edit on disk is detected on read. Transitions on one topic are
 * serialized in-process.
 */
import { createHash } from 'node:crypto'
import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { apply, replay } from './state.ts'
import type { Actor, LedgerEntry, TopicEvent, TopicState } from './state.ts'

export interface DocRef {
  readonly name: string
  readonly hash: string
}

export interface StoredEntry extends LedgerEntry {
  readonly at: string
  readonly doc?: DocRef
  /** Short free text from the emperor (feedback on a send-back or veto). */
  readonly note?: string
}

export interface TopicSummary {
  readonly id: string
  readonly title: string
  readonly state: TopicState
}

export interface NewDoc {
  readonly name: string
  readonly text: string
}

const TOPIC_ID = /^\d{3,}$/
const DOC_NAME = /^[a-z][a-z0-9-]*$/
const LEDGER = '_ledger.jsonl'
const META = '_meta.json'
const DECREE = 'decree'

export function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
}

export class TopicStore {
  /** Tail of the pending write chain per topic. */
  private readonly locks = new Map<string, Promise<unknown>>()

  constructor(readonly root: string) {}

  /** Open a new topic with the emperor's words recorded verbatim. */
  async create(decree: string, title: string): Promise<{ id: string }> {
    return this.serialize('#create', async () => {
      await mkdir(this.root, { recursive: true })
      const existing = (await readdir(this.root)).filter(n => TOPIC_ID.test(n)).map(Number)
      const id = String(Math.max(0, ...existing) + 1).padStart(3, '0')
      const dir = join(this.root, id)
      await mkdir(dir)
      await writeFile(join(dir, META), JSON.stringify({ title, createdAt: new Date().toISOString(), decreeHash: hashText(decree) }), { flag: 'wx' })
      await writeFile(join(dir, `${DECREE}.md`), decree, { flag: 'wx' })
      await writeFile(join(dir, LEDGER), '', { flag: 'wx' })
      return { id }
    })
  }

  async list(): Promise<TopicSummary[]> {
    await mkdir(this.root, { recursive: true })
    const ids = (await readdir(this.root)).filter(n => TOPIC_ID.test(n)).sort()
    return Promise.all(ids.map(async id => ({ id, title: (await this.meta(id)).title, state: await this.state(id) })))
  }

  async state(id: string): Promise<TopicState> {
    return replay(await this.history(id))
  }

  async history(id: string): Promise<StoredEntry[]> {
    const text = await readFile(join(this.dir(id), LEDGER), 'utf8').catch((e: unknown) => {
      /* v8 ignore next -- only ENOENT is reproducible; other I/O errors propagate unchanged. */
      throw isMissing(e) ? new Error(`unknown topic ${id}`) : e
    })
    return text.split('\n').filter(line => line !== '').map((line, i) => {
      try {
        return JSON.parse(line) as StoredEntry
      } catch {
        throw new Error(`topic ${id}: ledger line ${i + 1} is not valid JSON`)
      }
    })
  }

  /**
   * Validate and append one transition, writing its document first.
   * @throws when the state machine refuses or the document already exists.
   */
  async transition(id: string, actor: Actor, event: TopicEvent, doc?: NewDoc, note?: string): Promise<TopicState> {
    return this.serialize(id, async () => {
      const next = apply(await this.state(id), actor, event)
      if (doc !== undefined && !DOC_NAME.test(doc.name)) throw new Error(`invalid document name "${doc.name}"`)
      const ref = doc === undefined ? undefined : { name: doc.name, hash: hashText(doc.text) }
      if (doc !== undefined) {
        await writeFile(join(this.dir(id), `${doc.name}.md`), doc.text, { flag: 'wx' }).catch((e: unknown) => {
          /* v8 ignore next -- only EEXIST is reproducible; other I/O errors propagate unchanged. */
          throw isExisting(e) ? new Error(`document ${doc.name} already exists in topic ${id}`) : e
        })
      }
      const entry: StoredEntry = {
        actor, event, at: new Date().toISOString(),
        ...(ref === undefined ? {} : { doc: ref }),
        ...(note === undefined || note === '' ? {} : { note }),
      }
      await appendFile(join(this.dir(id), LEDGER), `${JSON.stringify(entry)}\n`)
      return next
    })
  }

  /** Read a recorded document, verifying it against the hash on record. */
  async readDoc(id: string, name: string): Promise<string> {
    if (!DOC_NAME.test(name)) throw new Error(`invalid document name "${name}"`)
    const expected = name === DECREE
      ? (await this.meta(id)).decreeHash
      : (await this.history(id)).find(e => e.doc?.name === name)?.doc?.hash
    if (expected === undefined) throw new Error(`no document ${name} in topic ${id}`)
    const text = await readFile(join(this.dir(id), `${name}.md`), 'utf8')
    if (hashText(text) !== expected) throw new Error(`document ${name} in topic ${id}: hash mismatch with the ledger`)
    return text
  }

  private async meta(id: string): Promise<{ title: string; decreeHash: string }> {
    return JSON.parse(await readFile(join(this.dir(id), META), 'utf8')) as { title: string; decreeHash: string }
  }

  private dir(id: string): string {
    if (!TOPIC_ID.test(id)) throw new Error(`invalid topic id "${id}"`)
    return join(this.root, id)
  }

  private serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(key) ?? Promise.resolve()
    const run = prior.then(task, task)
    this.locks.set(key, run.catch(() => undefined))
    return run
  }
}

function isMissing(e: unknown): boolean {
  return (e as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

function isExisting(e: unknown): boolean {
  return (e as NodeJS.ErrnoException | undefined)?.code === 'EEXIST'
}
