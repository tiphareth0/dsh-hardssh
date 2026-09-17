/**
 * Anchor↔remote-root path aliasing, shared by both switching seams.
 *
 * A bound session's cwd, and any path the model copies out of it, is the
 * workspace's LOCAL anchor directory — which exists only on this machine. The
 * remote backends must therefore never see it: they are handed the workspace's
 * remote root instead. Keeping the mapping in one place is what makes the fs
 * seam and the subprocess seam agree.
 *
 * @module dsh-hardssh/switch/anchor-path
 */

/** Rewrite `<anchor>/<rest>` to `<remoteRoot>/<rest>` when `path` is the
 *  anchor or under it; otherwise return `path` unchanged (remote absolute
 *  paths, relative paths, and foreign local paths all pass through). */
export function translateAnchorPath(anchor: string, remoteRoot: string, path: string): string {
  const norm = (value: string): string => value.replace(/[\\/]+$/, '')
  const a = norm(anchor)
  const isWin = a.includes('\\')
  const normPath = (value: string): string => {
    let out = norm(value)
    if (isWin) out = out.replace(/\//g, '\\')
    return out
  }
  const p = normPath(path)
  const aa = isWin ? a.toLowerCase() : a
  const pp = isWin ? p.toLowerCase() : p
  if (pp === aa) return remoteRoot
  if (pp.startsWith(`${aa}\\`) || pp.startsWith(`${aa}/`)) {
    // Preserve the original case for the tail (the anchor prefix removed);
    // normalize the tail to POSIX separators (the remote side is POSIX).
    const tail = p.slice(a.length).replace(/^[\\/]+/, '').replace(/\\/g, '/')
    return tail === '' ? remoteRoot : `${remoteRoot.replace(/\/+$/, '')}/${tail}`
  }
  return path
}
