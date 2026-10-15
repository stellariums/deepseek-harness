import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { canonicalPath, decide } from '../src/policy.ts'
import type { Binding, PolicyContext, Role } from '../src/policy.ts'
import type { Phase } from '../src/state.ts'

// Real directories: canonicalization resolves junctions and short names on disk.
const root = mkdtempSync(join(tmpdir(), 'sansheng-policy-'))
const ws = join(root, 'workspace')
const store = join(root, 'store')
const record = join(store, '001', '04-zhupi.md')
mkdirSync(join(ws, 'src'), { recursive: true })
mkdirSync(join(store, '001'), { recursive: true })
writeFileSync(record, 'x')
afterAll(() => { rmSync(root, { recursive: true, force: true }) })

const ctx = (phase: Phase, cwd = ws): PolicyContext => ({ protectedRoots: [store], workspaceRoot: ws, cwd, phase })
const as = (role: Role): Binding => ({ role, topicId: '001' })
const ROLES: Role[] = ['eunuch', 'zhongshu', 'menxia', 'shangshu']
const PHASES: Phase[] = ['translated', 'drafting', 'reviewing', 'executing', 'accepting']

describe('tool allowlist', () => {
  it('denies tools no rule knows', () => {
    expect(decide(as('zhongshu'), ctx('drafting'), 'mystery_tool', {})).toMatch(/not available/)
  })

  it('todo_write is neutral for everyone', () => {
    for (const role of ROLES) expect(decide(as(role), ctx('drafting'), 'todo_write', {})).toBeUndefined()
  })

  it('shell only for the executor while executing and the reviewer while accepting', () => {
    for (const role of ROLES) {
      for (const phase of PHASES) {
        for (const tool of ['bash', 'pwsh', 'run_code']) {
          const allowed = (role === 'shangshu' && phase === 'executing') || (role === 'menxia' && phase === 'accepting')
          expect(decide(as(role), ctx(phase), tool, { command: 'ls' }) === undefined).toBe(allowed)
        }
      }
    }
  })

  it('only the executor dispatches subagents, only while executing', () => {
    expect(decide(as('shangshu'), ctx('executing'), 'subagent', { prompt: 'x' })).toBeUndefined()
    expect(decide(as('shangshu'), ctx('accepting'), 'subagent', { prompt: 'x' })).toBeDefined()
    expect(decide(as('zhongshu'), ctx('drafting'), 'subagent', { prompt: 'x' })).toBeDefined()
  })

  it('each role reaches only its own submit tools', () => {
    expect(decide(as('zhongshu'), ctx('drafting'), 'submit_plan', {})).toBeUndefined()
    expect(decide(as('menxia'), ctx('reviewing'), 'submit_review', {})).toBeUndefined()
    expect(decide(as('menxia'), ctx('accepting'), 'submit_acceptance', {})).toBeUndefined()
    expect(decide(as('shangshu'), ctx('executing'), 'submit_execution', {})).toBeUndefined()
    expect(decide(as('shangshu'), ctx('executing'), 'report_deviation', {})).toBeUndefined()
    expect(decide(as('shangshu'), ctx('executing'), 'submit_plan', {})).toBeDefined()
    expect(decide(as('menxia'), ctx('reviewing'), 'submit_execution', {})).toBeDefined()
  })

  it('only the eunuch reaches governance tools', () => {
    expect(decide(as('eunuch'), ctx('translated'), 'sansheng_status', {})).toBeUndefined()
    expect(decide(as('zhongshu'), ctx('drafting'), 'sansheng_review', {})).toBeDefined()
  })
})

describe('the record store is off limits to every agent', () => {
  it('denies reading a record file, for every role', () => {
    for (const role of ROLES) {
      expect(decide(as(role), ctx('executing'), 'read', { file_path: record })).toMatch(/protected/)
      expect(decide(as(role), ctx('executing'), 'str_replace_editor', { command: 'view', path: record })).toMatch(/protected/)
    }
  })

  it('denies writing a record file even for the executor', () => {
    expect(decide(as('shangshu'), ctx('executing'), 'write', { file_path: record, content: '' })).toBeDefined()
    expect(decide(as('shangshu'), ctx('executing'), 'edit', { file_path: join(store, '001', 'new.md'), old_string: 'a', new_string: 'b' })).toBeDefined()
  })

  it('denies relative paths that climb into the store', () => {
    expect(decide(as('menxia'), ctx('reviewing', join(ws, 'src')), 'read', { file_path: '../../store/001/04-zhupi.md' })).toMatch(/protected/)
  })

  it('denies searches rooted in or above the store', () => {
    for (const path of [store, join(store, '001'), root]) {
      expect(decide(as('menxia'), ctx('reviewing'), 'grep', { pattern: 'x', path })).toMatch(/protected/)
      expect(decide(as('menxia'), ctx('reviewing'), 'glob', { pattern: '**/*', path })).toMatch(/protected/)
    }
  })

  it('a junction inside the workspace that points into the store is followed', () => {
    const link = join(ws, 'sneaky')
    symlinkSync(store, link, 'junction')
    expect(decide(as('menxia'), ctx('reviewing'), 'read', { file_path: join(link, '001', '04-zhupi.md') })).toMatch(/protected/)
    expect(decide(as('shangshu'), ctx('executing'), 'write', { file_path: join(link, '001', 'x.md'), content: '' })).toMatch(/protected/)
    expect(decide(as('menxia'), ctx('reviewing'), 'grep', { pattern: 'x', path: link })).toMatch(/protected/)
  })
})

describe('Windows path aliases are refused, not guessed', () => {
  const aliases = [
    `\\\\?\\${record}`,
    `\\\\.\\${record}`,
    '\\\\localhost\\E$\\x\\04-zhupi.md',
    '//server/share/x',
    join(store + '.', '001', '04-zhupi.md'),
    join(store + ' ', '001', '04-zhupi.md'),
    join(store + '::$INDEX_ALLOCATION', '001', '04-zhupi.md'),
    join(root, 'STORE~1', '001', '04-zhupi.md'),
    'C:relative\\x.md',
  ]

  it.each(aliases)('read %s', (file_path) => {
    expect(decide(as('menxia'), ctx('reviewing'), 'read', { file_path })).toMatch(/path/)
  })

  it.each(aliases)('write %s', (file_path) => {
    expect(decide(as('shangshu'), ctx('executing'), 'write', { file_path, content: '' })).toMatch(/path/)
  })

  it('search roots get the same treatment', () => {
    expect(decide(as('menxia'), ctx('reviewing'), 'glob', { pattern: '*', path: `\\\\?\\${store}` })).toMatch(/path/)
  })

  it('canonicalPath refuses aliases too', () => {
    expect(canonicalPath(`\\\\?\\${record}`, ws)).toBeUndefined()
  })

  it('ordinary names with dots and tildes inside a segment are fine', () => {
    expect(canonicalPath(join(ws, 'src', 'a.b.py'), ws)).toBeDefined()
    expect(canonicalPath(join(ws, 'src', 'v1~beta.txt'), ws)).toBeDefined()
    expect(canonicalPath(join(ws, '..foo', 'x'), ws)).toBeDefined()
  })
})

describe('reads and searches in the workspace', () => {
  it('every role may read the workspace', () => {
    for (const role of ROLES) {
      expect(decide(as(role), ctx('reviewing'), 'read', { file_path: join(ws, 'src', 'a.py') })).toBeUndefined()
    }
  })

  it('a path is required', () => {
    expect(decide(as('menxia'), ctx('reviewing'), 'read', {})).toMatch(/path/)
    expect(decide(as('shangshu'), ctx('executing'), 'write', { content: '' })).toMatch(/path/)
  })

  it('search defaults to the cwd', () => {
    expect(decide(as('menxia'), ctx('reviewing'), 'grep', { pattern: 'x' })).toBeUndefined()
    expect(decide(as('menxia'), ctx('reviewing', root), 'grep', { pattern: 'x' })).toMatch(/protected/)
  })

  it('grep regexes are not mistaken for paths', () => {
    expect(decide(as('menxia'), ctx('reviewing'), 'grep', { pattern: '\\d+\\.\\.', path: ws })).toBeUndefined()
  })

  it('glob patterns and grep includes cannot escape the search root', () => {
    for (const pattern of ['../**', '../../store/**', '/abs/**', 'C:/x/**', '\\\\?\\x']) {
      expect(decide(as('menxia'), ctx('reviewing'), 'glob', { pattern, path: ws })).toMatch(/pattern/)
      expect(decide(as('menxia'), ctx('reviewing'), 'grep', { pattern: 'x', path: ws, include: pattern })).toMatch(/pattern/)
    }
    expect(decide(as('menxia'), ctx('reviewing'), 'glob', { pattern: 'src/**/*.{py,md}', path: ws })).toBeUndefined()
  })
})

describe('writes', () => {
  it('only the executor writes, only while executing, only inside the workspace', () => {
    const target = join(ws, 'src', 'model.py')
    for (const role of ROLES) {
      for (const phase of PHASES) {
        const allowed = role === 'shangshu' && phase === 'executing'
        expect(decide(as(role), ctx(phase), 'write', { file_path: target, content: '' }) === undefined).toBe(allowed)
      }
    }
    expect(decide(as('shangshu'), ctx('executing'), 'write', { file_path: join(root, 'elsewhere.txt'), content: '' })).toMatch(/workspace/)
  })

  it('str_replace_editor create counts as a write', () => {
    expect(decide(as('menxia'), ctx('reviewing'), 'str_replace_editor', { command: 'create', path: join(ws, 'a.md') })).toBeDefined()
    expect(decide(as('shangshu'), ctx('executing'), 'str_replace_editor', { command: 'create', path: join(ws, 'a.md') })).toBeUndefined()
  })

  it('writes to files that do not exist yet resolve through their nearest existing parent', () => {
    expect(decide(as('shangshu'), ctx('executing'), 'write', { file_path: join(ws, 'new', 'deep', 'f.txt'), content: '' })).toBeUndefined()
  })
})
