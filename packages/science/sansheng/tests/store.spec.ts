import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TopicStore, hashText } from '../src/store.ts'

const roots: string[] = []
function freshStore(): TopicStore {
  const root = mkdtempSync(join(tmpdir(), 'sansheng-store-'))
  roots.push(root)
  return new TopicStore(root)
}
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }) })

describe('topics', () => {
  it('creates sequential topic ids and records the decree verbatim', async () => {
    const store = freshStore()
    const a = await store.create('研究晶格热导率', '晶格热导率 ML 预测')
    const b = await store.create('second', 'two')
    expect(a.id).toBe('001')
    expect(b.id).toBe('002')
    expect(await store.readDoc(a.id, 'decree')).toBe('研究晶格热导率')
    expect((await store.state(a.id)).phase).toBe('translated')
    expect((await store.list()).map(t => t.id)).toEqual(['001', '002'])
    expect((await store.list())[0]!.title).toBe('晶格热导率 ML 预测')
  })

  it('unknown topics fail loudly, and ids are validated', async () => {
    const store = freshStore()
    await expect(store.state('009')).rejects.toThrow(/unknown topic/)
    await expect(store.state('../x')).rejects.toThrow(/topic id/)
  })
})

describe('ledger', () => {
  it('commits a transition and the document it carries together', async () => {
    const store = freshStore()
    const { id } = await store.create('d', 't')
    await store.transition(id, 'eunuch', { type: 'translation_submitted' })
    await store.transition(id, 'emperor', { type: 'translation_confirmed' })
    const plan = '# 方案\n...'
    await store.transition(id, 'zhongshu', { type: 'plan_submitted', version: 1, hash: hashText(plan) }, { name: 'plan-v1', text: plan })
    expect((await store.state(id)).phase).toBe('reviewing')
    expect(await store.readDoc(id, 'plan-v1')).toBe(plan)
  })

  it('an illegal transition writes neither ledger nor document', async () => {
    const store = freshStore()
    const { id } = await store.create('d', 't')
    await expect(store.transition(id, 'eunuch', { type: 'translation_confirmed' }, { name: 'x', text: 'y' })).rejects.toThrow()
    expect((await store.state(id)).phase).toBe('translated')
    await expect(store.readDoc(id, 'x')).rejects.toThrow(/no document/)
    expect((await store.history(id))).toHaveLength(0)
  })

  it('documents are write-once', async () => {
    const store = freshStore()
    const { id } = await store.create('d', 't')
    await expect(store.transition(id, 'emperor', { type: 'retranslate' }, { name: 'decree', text: 'forged' })).rejects.toThrow(/already exists/)
    expect(await store.readDoc(id, 'decree')).toBe('d')
  })

  it('reading validates the document name', async () => {
    const store = freshStore()
    const { id } = await store.create('d', 't')
    await expect(store.readDoc(id, '../x')).rejects.toThrow(/document name/)
  })

  it('document names are validated', async () => {
    const store = freshStore()
    const { id } = await store.create('d', 't')
    for (const name of ['../x', 'a/b', '', 'A B']) {
      await expect(store.transition(id, 'emperor', { type: 'retranslate' }, { name, text: 'y' })).rejects.toThrow(/document name/)
    }
  })

  it('a document whose bytes changed on disk is detected', async () => {
    const store = freshStore()
    const { id } = await store.create('d', 't')
    writeFileSync(join(store.root, id, 'decree.md'), 'tampered')
    await expect(store.readDoc(id, 'decree')).rejects.toThrow(/hash mismatch/)
  })

  it('history lists every entry with actor, event, doc hash, and time', async () => {
    const store = freshStore()
    const { id } = await store.create('d', 't')
    await store.transition(id, 'eunuch', { type: 'translation_submitted' }, { name: 'translation-v1', text: 'T' })
    const [entry] = await store.history(id)
    expect(entry).toMatchObject({ actor: 'eunuch', event: { type: 'translation_submitted' }, doc: { name: 'translation-v1', hash: hashText('T') } })
    expect(typeof entry!.at).toBe('string')
  })

  it('records an optional emperor note', async () => {
    const store = freshStore()
    const { id } = await store.create('d', 't')
    await store.transition(id, 'emperor', { type: 'retranslate' }, undefined, '范围太大')
    await store.transition(id, 'emperor', { type: 'retranslate' }, undefined, '')
    const [a, b] = await store.history(id)
    expect(a!.note).toBe('范围太大')
    expect('note' in b!).toBe(false)
  })

  it('a corrupt ledger line fails replay loudly', async () => {
    const store = freshStore()
    const { id } = await store.create('d', 't')
    writeFileSync(join(store.root, id, '_ledger.jsonl'), '{"actor":"shangshu","event":{"type":"approved"}}\n', { flag: 'a' })
    await expect(store.state(id)).rejects.toThrow()
    writeFileSync(join(store.root, id, '_ledger.jsonl'), 'not json\n', { flag: 'a' })
    await expect(store.history(id)).rejects.toThrow(/ledger line/)
  })

  it('concurrent transitions on one topic are serialized', async () => {
    const store = freshStore()
    const { id } = await store.create('d', 't')
    await store.transition(id, 'eunuch', { type: 'translation_submitted' })
    const results = await Promise.allSettled([
      store.transition(id, 'emperor', { type: 'translation_confirmed' }),
      store.transition(id, 'emperor', { type: 'translation_confirmed' }),
    ])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(await store.history(id)).toHaveLength(2)
  })

  it('the ledger file is append-only JSONL', async () => {
    const store = freshStore()
    const { id } = await store.create('d', 't')
    await store.transition(id, 'eunuch', { type: 'translation_submitted' })
    await store.transition(id, 'emperor', { type: 'translation_confirmed' })
    const lines = readFileSync(join(store.root, id, '_ledger.jsonl'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
  })
})

describe('hashText', () => {
  it('is a stable sha256 prefix', () => {
    expect(hashText('a')).toBe(hashText('a'))
    expect(hashText('a')).not.toBe(hashText('b'))
    expect(hashText('a')).toMatch(/^[0-9a-f]{16}$/)
  })
})
