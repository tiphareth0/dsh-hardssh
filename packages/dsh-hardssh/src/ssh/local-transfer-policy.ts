/**
 * Host-side path policy for ssh_upload / ssh_download.
 *
 * These tools bridge remote I/O to the DSH host, so accepting an arbitrary
 * absolute local path would bypass the normal FileSystem sandbox. The only
 * trusted per-call root available to a tool body is the validated absolute cwd
 * stored on the invoking Agent's immutable SessionHeader.
 */

import { existsSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

export type LocalTransferDirection = 'upload-source' | 'download-destination'

function outside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)
}

function fail(path: string, root: string): never {
  throw new Error(`local transfer path '${path}' is outside the invoking session workspace '${root}'`)
}

/** Canonicalize a not-yet-existing destination through its nearest existing
 * ancestor, preserving the suffix beneath that canonical ancestor. */
function canonicalFuturePath(path: string): string {
  const suffix: string[] = [basename(path)]
  let cursor = dirname(path)
  for (;;) {
    if (existsSync(cursor)) {
      return resolve(realpathSync.native(cursor), ...suffix)
    }
    const parent = dirname(cursor)
    if (parent === cursor) throw new Error(`cannot resolve an existing parent for local destination '${path}'`)
    suffix.unshift(basename(cursor))
    cursor = parent
  }
}

/**
 * Validate and canonicalize one local transfer path.
 *
 * Uploads must name an existing regular file. Downloads may create the final
 * file and missing parent directories, but their nearest existing ancestor is
 * canonicalized so an in-workspace symlink/junction cannot redirect the write
 * outside the session root.
 */
export function secureLocalTransferPath(
  exec: ToolRunContext,
  localPath: string,
  direction: LocalTransferDirection,
): string {
  const cwd = exec.agent?.session.header.cwd
  if (cwd === undefined) {
    throw new Error('local transfer denied: the tool call has no invoking session workspace')
  }
  if (!isAbsolute(cwd)) throw new Error('local transfer denied: invoking session cwd is not absolute')
  if (!isAbsolute(localPath)) throw new Error('local transfer path must be absolute')

  let root: string
  try {
    root = realpathSync.native(cwd)
  } catch {
    throw new Error(`local transfer denied: invoking session workspace '${cwd}' is unavailable`)
  }

  const requested = resolve(localPath)
  let canonical: string
  if (direction === 'upload-source') {
    try {
      canonical = realpathSync.native(requested)
    } catch {
      throw new Error(`local upload source '${localPath}' does not exist`)
    }
    if (!statSync(canonical).isFile()) throw new Error(`local upload source '${localPath}' is not a regular file`)
  } else {
    canonical = existsSync(requested) ? realpathSync.native(requested) : canonicalFuturePath(requested)
  }

  if (outside(root, canonical)) fail(localPath, root)
  return canonical
}
