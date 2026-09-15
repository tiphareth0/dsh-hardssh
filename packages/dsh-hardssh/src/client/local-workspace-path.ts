/**
 * Path policy for the LOCAL branch of the directory flow.
 *
 * The kernel's session creation ensures the project directory with
 * `mkdir(cwd, { recursive: true })` and treats ANY failure as fatal
 * (`dsh-api-session-controller`: `failed to ensure project directory "…"`).
 * On Windows a drive root cannot be created:
 *
 *   mkdir('C:\\', { recursive: true })  →  EPERM: operation not permitted, mkdir 'C:\'
 *
 * `recursive: true` swallows EEXIST but not EPERM, so a workspace whose path is
 * `C:\` can be created but never opened: "＋" fails with a gateway/internal
 * error. The same applies to a UNC share root. Refusing those inputs at pick
 * time with an actionable message is the only fix available from this plugin —
 * the kernel calls `node:fs` directly, so the filesystem seam cannot intercept
 * it.
 *
 * @module dsh-hardssh/client/local-workspace-path
 */

/** Why a picked local path cannot become a workspace root. */
export type LocalWorkspacePathProblem = 'empty' | 'not-absolute' | 'filesystem-root'

export type LocalWorkspacePathCheck =
  | { ok: true; path: string }
  | { ok: false; problem: LocalWorkspacePathProblem }

/** `C:`, `C:\`, `C:/`, `C:\`… — a Windows drive root (no child directory). */
const WINDOWS_DRIVE_ROOT = /^[a-zA-Z]:[\\/]*$/
/** `C:\x`, `C:/x` — a Windows absolute path below the drive root. */
const WINDOWS_ABSOLUTE = /^[a-zA-Z]:[\\/]/
/** `\\server\share` (optionally with trailing separators) — a UNC share root.
 *  Both separator styles are accepted: Node treats `//server/share` as UNC too. */
const UNC_SHARE_ROOT = /^[\\/]{2}[^\\/]+[\\/][^\\/]+[\\/]*$/
/** `\\server\share\x` — a UNC path below the share root. */
const UNC_ABSOLUTE = /^[\\/]{2}[^\\/]+[\\/][^\\/]+[\\/]/

/** Drop trailing separators; a bare root (`/`, `C:\`) is returned unchanged. */
function stripTrailingSeparators(path: string): string {
  if (path === '/' || path === '\\') return path
  if (/^[a-zA-Z]:[\\/]$/.test(path)) return path
  const stripped = path.replace(/[\\/]+$/, '')
  return stripped === '' ? path : stripped
}

/**
 * Validate and normalize one picked local directory path.
 *
 * Normalization only removes redundant trailing separators; it never rewrites
 * the path shape the operator chose, so the workspace keeps pointing exactly
 * where they picked.
 */
export function checkLocalWorkspacePath(input: string): LocalWorkspacePathCheck {
  const trimmed = input.trim()
  if (trimmed === '') return { ok: false, problem: 'empty' }

  // A Windows drive root is creatable-but-unopenable: reject it before the
  // host stores a workspace that can never start a session.
  if (WINDOWS_DRIVE_ROOT.test(trimmed)) return { ok: false, problem: 'filesystem-root' }
  if (UNC_SHARE_ROOT.test(trimmed)) return { ok: false, problem: 'filesystem-root' }

  const looksAbsolute = trimmed.startsWith('/') || WINDOWS_ABSOLUTE.test(trimmed) || UNC_ABSOLUTE.test(trimmed)
  if (!looksAbsolute) return { ok: false, problem: 'not-absolute' }

  // POSIX root is fine on the host side (mkdir('/') is a no-op), but a bare
  // root as a project directory is never what the operator meant either.
  if (trimmed === '/') return { ok: false, problem: 'filesystem-root' }

  return { ok: true, path: stripTrailingSeparators(trimmed) }
}
