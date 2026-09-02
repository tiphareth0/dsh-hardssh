/**
 * Workspace namespace codec — how a routable target key is encoded.
 *
 * New format is a URI style that carries ONLY the workspace id and the
 * provider-agnostic path:
 *
 *   wfs://<encoded-workspace-id>/<path>
 *
 * - The workspace id survives provider migration (ssh → container → …), so
 *   a key never needs re-routing when a workspace changes providers.
 * - It cannot collide with Windows drive paths (`C:\…`) or bare POSIX paths.
 * - It contains no provider name, so the switch layer never branches on
 *   "which provider" — only on "which workspace".
 *
 * The legacy SSH format (`ssh:<recordId>:`) is still accepted (decode only)
 * so existing persisted targets keep resolving during the migration window.
 *
 * @module @tiphareth/dsh-hardssh/base/namespace
 */

/** The URI scheme used for explicit workspace-namespaced target keys. */
export const WFS_SCHEME = 'wfs:' as const

/** ASCII-encode a workspace id for safe embedding in a URL-ish key. */
export function encodeWorkspaceId(id: string): string {
  return encodeURIComponent(id)
}

/** Decode a workspace id back from its encoded form. */
export function decodeWorkspaceId(encoded: string): string {
  return decodeURIComponent(encoded)
}

/** One parsed route: which workspace, and the raw path inside it. */
export interface WorkspaceRoute {
  workspaceId: string
  /** The path portion as it appeared (provider-relative). */
  path: string
}

/** Namespace codec contract (make the switch layer provider-agnostic). */
export interface WorkspaceNamespaceCodec {
  encode(route: WorkspaceRoute): string
  decode(input: string): WorkspaceRoute | undefined
  /** True when `input` is an explicit workspace namespace (not a plain path). */
  isExplicitNamespace(input: string): boolean
}

/**
 * Encode a route as `wfs://<id>/<path>`. A leading slash on the path is
 * preserved after the namespace marker.
 */
export function encodeRoute(route: WorkspaceRoute): string {
  const path = route.path.startsWith('/') ? route.path : `/${route.path}`
  return `${WFS_SCHEME}//${encodeWorkspaceId(route.workspaceId)}${path}`
}

/** Decode a `wfs://<id>/<path>` key (strict). */
export function decodeWfsKey(input: string): WorkspaceRoute | undefined {
  if (!input.startsWith(`${WFS_SCHEME}//`)) return undefined
  const rest = input.slice(`${WFS_SCHEME}//`.length)
  const separator = rest.indexOf('/')
  if (separator < 0) return undefined
  const encodedId = rest.slice(0, separator)
  if (encodedId === '') return undefined
  let workspaceId: string
  try {
    workspaceId = decodeWorkspaceId(encodedId)
  } catch {
    return undefined
  }
  const path = rest.slice(separator)
  return { workspaceId, path }
}

/**
 * Decode a legacy `ssh:<recordId>:<key>` key. Kept during the migration
 * window so persisted remote targets keep resolving; the record id maps to
 * the workspace id 1:1 (old record ids ARE the workspace ids).
 */
export function decodeLegacySshKey(input: string): WorkspaceRoute | undefined {
  if (!input.startsWith('ssh:')) return undefined
  const rest = input.slice('ssh:'.length)
  const end = rest.indexOf(':')
  if (end <= 0) return undefined
  const recordId = rest.slice(0, end)
  return { workspaceId: recordId, path: rest.slice(end + 1) }
}

/**
 * The default codec: emits `wfs://…` and accepts both `wfs://…` and legacy
 * `ssh:<id>:…`.
 */
export const defaultNamespaceCodec: WorkspaceNamespaceCodec = {
  encode: encodeRoute,
  decode(input: string): WorkspaceRoute | undefined {
    return decodeWfsKey(input) ?? decodeLegacySshKey(input)
  },
  isExplicitNamespace(input: string): boolean {
    return input.startsWith(WFS_SCHEME) || input.startsWith('ssh:')
  },
}