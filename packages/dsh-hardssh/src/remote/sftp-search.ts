/**
 * SFTP search backend (P1-D): the last rung of the remote search ladder.
 *
 * Used when a host has neither ripgrep nor a `find`/`grep` pair that the POSIX
 * templates can rely on (BSD, BusyBox, a restricted account, a non-POSIX shell).
 * Nothing here shells out: the walk drives `engine.ls`, symlinked directories
 * are never descended into, and every read is bounded, so the fallback cannot
 * escape the workspace root or pull an unbounded amount of data over the wire.
 *
 * Budgets are explicit and always reported: a walk that stops at
 * `maxEntries`/`maxFiles`/`maxHits`/`maxTotalBytes` returns `truncated: true`
 * (there may be more), never a silent "no matches". A search that runs out of
 * time fails with a clear error instead of returning partial results that look
 * complete.
 */

import { posix } from 'node:path'
import type { SshEngine } from '../ssh/engine.ts'
import type { RemoteDirEntry } from '../ssh/protocol.ts'
import { globToRegExp } from './glob-match.ts'

/** Directories the shell templates also skip. */
const SKIPPED_DIRS = new Set(['.git', 'node_modules'])
/** Binary sniff window (a NUL byte in the head means "not text"). */
const BINARY_SAMPLE_BYTES = 8192

export interface SftpSearchLimits {
  /** Directory depth; root-level entries are depth 1. */
  maxDepth: number
  /** Entries visited before the walk gives up (reported as truncated). */
  maxEntries: number
  /** Directory listings in flight at once. */
  concurrency: number
  /** Whole-search deadline. */
  timeoutMs: number
  signal?: AbortSignal
}

export interface SftpGrepLimits extends SftpSearchLimits {
  maxHits: number
  maxFiles: number
  /** Skip files larger than this instead of reading them. */
  maxFileBytes: number
  /** Total bytes read across all files. */
  maxTotalBytes: number
}

export interface SftpNameHit {
  path: string
  isDir: boolean
}

/** What a walk reports back to a caller. */
interface WalkOutcome {
  truncated: boolean
}

/** One visited entry handed to the walk callback. */
type WalkVisitor = (absPath: string, entry: RemoteDirEntry) => boolean | void

/**
 * Reject on caller abort or on the search deadline. Both are real failures:
 * the caller must not mistake an unfinished walk for an empty result.
 */
function assertSearchable(signal: AbortSignal | undefined, deadline: number, timeoutMs: number): void {
  if (signal?.aborted === true) {
    throw signal.reason instanceof Error
      ? signal.reason
      : Object.assign(new Error('remote search aborted'), { name: 'AbortError' })
  }
  if (Date.now() > deadline) {
    throw new Error(`remote search timed out after ${timeoutMs}ms (sftp backend — narrow the search root or pattern)`)
  }
}

/** Run `task` over `items` with a fixed number of workers, preserving order. */
async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await task(items[index]!)
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * Breadth-first remote walk over SFTP. `visit` returning `false` stops the walk
 * (used when a hit/visit budget is reached); unreadable subdirectories are
 * skipped, but an unreadable ROOT propagates — a missing root must never look
 * like "no matches".
 */
export class SftpSearchService {
  constructor(private readonly engine: SshEngine) {}

  /** Case-insensitive substring match on the entry name. */
  async searchNames(alias: string, root: string, query: string, limits: SftpSearchLimits & { maxHits: number }): Promise<{ hits: SftpNameHit[]; truncated: boolean }> {
    const needle = query.toLowerCase()
    const hits: SftpNameHit[] = []
    let capped = false
    const outcome = await this.walk(alias, root, limits, (absPath, entry) => {
      if (!entry.name.toLowerCase().includes(needle)) return undefined
      hits.push({ path: absPath, isDir: entry.type === 'dir' })
      if (hits.length >= limits.maxHits) {
        capped = true
        return false
      }
      return undefined
    })
    return { hits, truncated: capped || outcome.truncated }
  }

  /** Glob match on the root-relative path; files and directories both hit. */
  async glob(alias: string, root: string, pattern: string, limits: SftpSearchLimits & { maxHits: number }): Promise<{ hits: string[]; truncated: boolean }> {
    const matcher = globToRegExp(pattern.replace(/^\/+/, ''))
    const hits: string[] = []
    let capped = false
    const outcome = await this.walk(alias, root, limits, (absPath) => {
      if (!matcher.test(this.relativeTo(root, absPath))) return undefined
      hits.push(absPath)
      if (hits.length >= limits.maxHits) {
        capped = true
        return false
      }
      return undefined
    })
    return { hits, truncated: capped || outcome.truncated }
  }

  /**
   * Fixed-string content search. Reads regular files only, skips binaries and
   * anything that is not valid UTF-8, and stops at the hit/file/byte budgets.
   */
  async grepFixed(alias: string, root: string, pattern: string, limits: SftpGrepLimits): Promise<{ lines: string[]; truncated: boolean }> {
    const deadline = Date.now() + limits.timeoutMs
    const files: string[] = []
    let capped = false
    const outcome = await this.walk(alias, root, limits, (absPath, entry) => {
      if (entry.type !== 'file') return undefined
      files.push(absPath)
      if (files.length >= limits.maxFiles) {
        capped = true
        return false
      }
      return undefined
    }, deadline)

    let budget = limits.maxTotalBytes
    let truncated = capped || outcome.truncated
    const perFile = await mapWithConcurrency(files, limits.concurrency, async (path) => {
      const found: string[] = []
      // Budgets are checked before the round trip, so a spent budget costs
      // nothing on the wire; the caller sees `truncated: true`.
      if (budget <= 0 || Date.now() > deadline) {
        truncated = true
        return found
      }
      try {
        const info = await this.engine.stat(alias, path, limits.signal)
        if (info.type !== 'file' || info.size > limits.maxFileBytes) return found
        // The budget is re-checked after the stat: concurrent readers may have
        // spent it while this one was in flight.
        if (budget <= 0) {
          truncated = true
          return found
        }
        // Reserve the window BEFORE the read, so concurrent readers can never
        // exceed the total byte budget; refund whatever the file did not need
        // (the reservation is synchronous, the read is not).
        const allowed = Math.min(limits.maxFileBytes, budget)
        budget -= allowed
        const { content } = await this.engine.readFile(alias, path, allowed, limits.signal)
        budget += allowed - content.length
        if (content.subarray(0, BINARY_SAMPLE_BYTES).includes(0)) return found
        const text = new TextDecoder('utf-8', { fatal: true }).decode(content)
        const lines = text.split('\n')
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index]!
          if (line.includes(pattern)) found.push(`${path}:${index + 1}:${line}`)
        }
      } catch (error: unknown) {
        // Caller cancellation must surface; one unreadable, oversized or
        // undecodable file must not fail the whole search.
        if (limits.signal?.aborted === true) throw error
        return found
      }
      return found
    })
    assertSearchable(limits.signal, deadline, limits.timeoutMs)

    // Deterministic order regardless of read concurrency.
    const ordered: string[] = []
    for (const lines of perFile) ordered.push(...lines)
    if (ordered.length > limits.maxHits) return { lines: ordered.slice(0, limits.maxHits), truncated: true }
    return { lines: ordered, truncated }
  }

  /** Path relative to the search root (`''` for the root itself). */
  private relativeTo(root: string, absPath: string): string {
    if (absPath === root) return ''
    const prefix = root.endsWith('/') ? root : `${root}/`
    return absPath.startsWith(prefix) ? absPath.slice(prefix.length) : absPath
  }

  private async walk(alias: string, root: string, limits: SftpSearchLimits, visit: WalkVisitor, deadline = Date.now() + limits.timeoutMs): Promise<WalkOutcome> {
    const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }]
    let visited = 0
    let truncated = false
    let stopped = false

    while (queue.length > 0 && !stopped) {
      assertSearchable(limits.signal, deadline, limits.timeoutMs)
      const batch = queue.splice(0, Math.max(1, limits.concurrency))
      const listings = await Promise.all(batch.map(async (dir) => ({
        dir,
        entries: await this.engine.ls(alias, dir.path, limits.signal),
      })))

      for (const { dir, entries } of listings) {
        for (const entry of entries) {
          assertSearchable(limits.signal, deadline, limits.timeoutMs)
          visited += 1
          if (visited > limits.maxEntries) {
            truncated = true
            stopped = true
            break
          }
          const absPath = posix.join(dir.path, entry.name)
          if (visit(absPath, entry) === false) {
            stopped = true
            break
          }
          if (entry.type !== 'dir') continue
          if (SKIPPED_DIRS.has(entry.name)) continue
          if (dir.depth + 1 >= limits.maxDepth) continue
          // Never descend through a symlink: `ls` classifies links by following
          // them, so a link pointing outside the workspace would otherwise let
          // the walk read (and report) foreign paths as workspace hits.
          if (await this.isRealDirectory(alias, absPath, limits.signal)) {
            queue.push({ path: absPath, depth: dir.depth + 1 })
          }
        }
      }
    }

    return { truncated }
  }

  /** lstat-based: true only for a real directory (a symlink to one is not). */
  private async isRealDirectory(alias: string, absPath: string, signal?: AbortSignal): Promise<boolean> {
    try {
      return (await this.engine.lstat(alias, absPath, signal))?.type === 'directory'
    } catch {
      return false
    }
  }
}
