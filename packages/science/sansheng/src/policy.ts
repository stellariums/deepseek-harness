/**
 * Role-bound tool policy (门禁). A pure decision over (role, phase, tool call):
 * returns a denial reason, or `undefined` to allow. Unknown tools are denied.
 *
 * Isolation is structural rather than path-pattern based:
 * - the authoritative record (圣旨, 方案, 审核, 朱批, 验收标准, ledger) lives in
 *   protected roots outside the workspace; no agent reads or writes it, and
 *   planner/reviewer see each other only through what the plugin hands them;
 * - planner and reviewer write no files at all and submit through tools;
 * - only the executor writes, inside the workspace, while executing.
 *
 * Paths are canonicalized on disk (realpath of the deepest existing ancestor),
 * which resolves case, 8.3 short names, junctions and symlinks. Spellings
 * Windows treats as aliases but realpath cannot see through (device prefixes,
 * UNC, trailing dots or spaces, stream syntax, drive-relative) are refused.
 *
 * Shell is granted only where the workflow needs it; confining what a shell
 * writes is the sandbox's job, and the record being outside the workspace
 * keeps the write sandbox between any shell and the record.
 */
import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { Phase } from './state.ts'

export type Role = 'eunuch' | 'zhongshu' | 'menxia' | 'shangshu'

export interface Binding {
  readonly role: Role
  readonly topicId: string
}

export interface PolicyContext {
  /** Directories no agent may touch (record store, harness home, …). */
  readonly protectedRoots: readonly string[]
  /** The only tree the executor may write. */
  readonly workspaceRoot: string
  /** The calling session's working directory, for relative paths. */
  readonly cwd: string
  readonly phase: Phase
}

/** Model-facing governance tools; only the eunuch dispatches the 三省. */
export const GOVERNANCE_TOOLS: ReadonlySet<string> = new Set([
  'sansheng_status',
  'sansheng_translate',
  'sansheng_draft',
  'sansheng_review',
  'sansheng_execute',
  'sansheng_accept',
])

/**
 * The structured-output capture tool every role child uses to hand its
 * result back; the plugin, not the child, turns it into a ledger entry.
 */
export const SUBMIT_TOOL = 'structured_output'

const READ_TOOLS = new Set(['read', 'read_image'])
const SEARCH_TOOLS = new Set(['grep', 'glob'])
const WRITE_TOOLS = new Set(['write', 'edit'])
const SHELL_TOOLS = new Set(['bash', 'pwsh', 'run_code'])
const NEUTRAL_TOOLS = new Set(['todo_write'])
/** Outbound read-only research tools: literature search and page fetch. */
const WEB_TOOLS = new Set(['web_search', 'web_fetch'])

type Args = Readonly<Record<string, unknown>>

/**
 * Decide one tool call.
 * @returns a denial reason, or `undefined` to allow.
 */
export function decide(who: Binding, ctx: PolicyContext, tool: string, args: Args): string | undefined {
  if (NEUTRAL_TOOLS.has(tool)) return undefined
  if (WEB_TOOLS.has(tool)) return who.role === 'eunuch' ? unavailable(who, tool) : undefined
  if (tool === 'str_replace_editor') {
    const path = stringArg(args, 'path')
    return args['command'] === 'view' ? checkRead(ctx, path) : checkWrite(who, ctx, path)
  }
  if (READ_TOOLS.has(tool)) return checkRead(ctx, stringArg(args, 'file_path'))
  if (SEARCH_TOOLS.has(tool)) return checkSearch(ctx, tool, args)
  if (WRITE_TOOLS.has(tool)) return checkWrite(who, ctx, stringArg(args, 'file_path'))
  if (SHELL_TOOLS.has(tool)) return shellAllowed(who, ctx.phase) ? undefined : unavailable(who, tool)
  if (tool === 'subagent' && who.role === 'shangshu' && ctx.phase === 'executing') return undefined
  if (tool === SUBMIT_TOOL && who.role !== 'eunuch') return undefined
  if (GOVERNANCE_TOOLS.has(tool) && who.role === 'eunuch') return undefined
  return unavailable(who, tool)
}

function unavailable(who: Binding, tool: string): string {
  return `tool "${tool}" is not available to ${who.role}`
}

function stringArg(args: Args, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function shellAllowed(who: Binding, phase: Phase): boolean {
  return (who.role === 'shangshu' && phase === 'executing') || (who.role === 'menxia' && phase === 'accepting')
}

/** Refuse spellings that alias a file in ways realpath cannot normalize. */
function aliasProblem(path: string): string | undefined {
  if (path.startsWith('\\\\') || path.startsWith('//')) return 'device and UNC paths are not allowed'
  if (/^[a-z]:(?![\\/])/i.test(path)) return 'drive-relative paths are not allowed'
  const segments = path.split(/[\\/]+/).filter(s => s !== '' && s !== '.' && s !== '..')
  for (const seg of segments) {
    if (/[. ]$/.test(seg)) return `path segment "${seg}" ends in a dot or space`
    if (/:/.test(seg) && !/^[a-z]:$/i.test(seg)) return `path segment "${seg}" contains ":"`
    if (/~\d/.test(seg)) return `path segment "${seg}" looks like a short name`
  }
  return undefined
}

/**
 * Canonical absolute path: realpath of the deepest existing ancestor joined
 * with the not-yet-existing remainder. Returns `undefined` for alias spellings.
 */
export function canonicalPath(path: string, cwd: string): string | undefined {
  if (aliasProblem(path) !== undefined) return undefined
  return realpathNearest(resolve(cwd, path))
}

function realpathNearest(abs: string): string {
  const tail: string[] = []
  let cursor = abs
  for (;;) {
    try {
      return resolve(realpathSync.native(cursor), ...tail.reverse())
    } catch {
      const parent = dirname(cursor)
      /* v8 ignore next -- a filesystem root always resolves; this only guards an infinite loop. */
      if (parent === cursor) return abs
      tail.push(basename(cursor))
      cursor = parent
    }
  }
}

function fold(path: string): string {
  /* v8 ignore next -- one arm per platform: each coverage lane takes only its own host's case rule. */
  return process.platform === 'win32' ? path.toLowerCase() : path
}

/** True when `inner` is `outer` or below it. */
function within(outer: string, inner: string): boolean {
  const rel = relative(fold(outer), fold(inner))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** Resolve a path argument, or explain why it cannot be used. */
function resolveArg(ctx: PolicyContext, path: string | undefined): { path: string } | { error: string } {
  if (path === undefined) return { error: 'a file path is required' }
  const problem = aliasProblem(path)
  if (problem !== undefined) return { error: problem }
  return { path: realpathNearest(resolve(ctx.cwd, path)) }
}

function protectedRoots(ctx: PolicyContext): string[] {
  return ctx.protectedRoots.map(root => realpathNearest(resolve(root)))
}

function checkRead(ctx: PolicyContext, path: string | undefined): string | undefined {
  const r = resolveArg(ctx, path)
  if ('error' in r) return r.error
  return protectedRoots(ctx).some(root => within(root, r.path)) ? 'path is in a protected directory' : undefined
}

function checkSearch(ctx: PolicyContext, tool: string, args: Args): string | undefined {
  const scoped = tool === 'glob' ? stringArg(args, 'pattern') : stringArg(args, 'include')
  if (scoped !== undefined && escapesRoot(scoped)) return 'search pattern may not leave the search root'
  const r = resolveArg(ctx, stringArg(args, 'path') ?? ctx.cwd)
  if ('error' in r) return r.error
  // A search rooted at or above a protected directory would walk into it.
  const hit = protectedRoots(ctx).some(root => within(root, r.path) || within(r.path, root))
  return hit ? 'search scope covers a protected directory' : undefined
}

function escapesRoot(pattern: string): boolean {
  return pattern.split(/[\\/]+/).includes('..') || isAbsolute(pattern) || /^[a-z]:/i.test(pattern) || pattern.startsWith('\\')
}

function checkWrite(who: Binding, ctx: PolicyContext, path: string | undefined): string | undefined {
  if (who.role !== 'shangshu') return `${who.role} does not write files; submit through its tools`
  if (ctx.phase !== 'executing') return `writes are allowed only while executing, topic is ${ctx.phase}`
  const r = resolveArg(ctx, path)
  if ('error' in r) return r.error
  if (protectedRoots(ctx).some(root => within(root, r.path))) return 'path is in a protected directory'
  return within(realpathNearest(resolve(ctx.workspaceRoot)), r.path) ? undefined : 'writes must stay inside the workspace'
}
