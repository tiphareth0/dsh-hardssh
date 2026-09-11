/**
 * Browser-side HTTP transport for the dsh-hardssh route clients — the ONE
 * fetch / JSON-error layer shared by the workspace client (./client/api.ts)
 * and the SSH client (./client/ssh/api.ts). Plain fetch / same-origin —
 * bundled inline into the client bundle.
 *
 * Business layers may translate the error (named subclasses/aliases), but they
 * must not re-parse a response: every route error is decoded here, once, into
 * {@link HttpApiError} with the HTTP status AND the parsed body.
 */

/**
 * Every route's JSON error body (superset of the SSH `ApiErrorBody`): the
 * stable machine code plus the interactive-gate fields the UI reads.
 */
export interface HttpErrorBody {
  /** Human-readable message (`error` is the wire field name). */
  error?: string
  /** Stable machine code (HOST_KEY_UNKNOWN / NEEDS_PASSWORD / VAULT_* / …). */
  code?: string
  /** Which secret a connection needs when code === 'NEEDS_PASSWORD'. */
  secret?: 'password' | 'passphrase'
  /** The fingerprint when a host key was refused. */
  hostKeyFingerprint?: string
  /** Mismatch detail (expected vs actual) when the host key changed. */
  hostKeyMismatch?: { expected: string; actual: string }
  /** Workspace titles referencing a host that cannot be deleted (HOST_IN_USE). */
  workspaces?: Array<{ id: string; title: string }>
  /** Vault lockout: attempts left before the next lockout window. */
  remaining?: number
  /** Vault lockout: milliseconds until the next attempt is allowed. */
  retryAfterMs?: number
  /** Forward-compatible: unlisted fields stay reachable through `body`. */
  [key: string]: unknown
}

/**
 * The single transport error: HTTP status plus the PARSED response body, so
 * no caller re-parses a response and no field is flattened away. The SSH
 * client re-exports it as `SshApiError`; the workspace client subclasses it as
 * `WorkspaceApiError`. Both are this class at runtime, so the UI's
 * `instanceof` / `.code` / `.hostKeyFingerprint` checks keep working.
 */
export class HttpApiError extends Error {
  constructor(
    message: string,
    /** HTTP status, when the error came from a response. */
    readonly status?: number,
    /** Parsed JSON error body, when the route sent one. */
    readonly body?: HttpErrorBody,
  ) {
    super(message)
    this.name = 'HttpApiError'
  }

  /** Stable machine code from the route error body. */
  get code(): string | undefined {
    return typeof this.body?.code === 'string' ? this.body.code : undefined
  }

  /** Which secret a connection needs when {@link code} === 'NEEDS_PASSWORD'. */
  get secret(): 'password' | 'passphrase' | undefined {
    const secret = this.body?.secret
    return secret === 'password' || secret === 'passphrase' ? secret : undefined
  }

  /** The fingerprint when a host key was refused. */
  get hostKeyFingerprint(): string | undefined {
    return typeof this.body?.hostKeyFingerprint === 'string' ? this.body.hostKeyFingerprint : undefined
  }

  /** Mismatch detail (expected vs actual) when the host key changed. */
  get hostKeyMismatch(): { expected: string; actual: string } | undefined {
    const mismatch = this.body?.hostKeyMismatch
    if (typeof mismatch !== 'object' || mismatch === null) return undefined
    const { expected, actual } = mismatch as { expected?: unknown; actual?: unknown }
    if (typeof expected !== 'string' || typeof actual !== 'string') return undefined
    return { expected, actual }
  }

  /** Vault lockout: attempts left. */
  get remaining(): number | undefined {
    return typeof this.body?.remaining === 'number' ? this.body.remaining : undefined
  }

  /** Vault lockout: milliseconds until the next attempt is allowed. */
  get retryAfterMs(): number | undefined {
    return typeof this.body?.retryAfterMs === 'number' ? this.body.retryAfterMs : undefined
  }
}

/** Query-string helper (skips undefined and empty values). */
export function buildQuery(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value))
  }
  const text = search.toString()
  return text === '' ? '' : '?' + text
}

/** Parse a JSON response or throw {@link HttpApiError} (status + body kept). */
export async function readJson<T>(response: Response): Promise<T> {
  const body = await parseJson(response)
  if (body === undefined) {
    throw new HttpApiError(`HTTP ${response.status}: invalid JSON response`, response.status)
  }
  if (!response.ok) throw errorFor(response.status, body)
  return body as T
}

/**
 * Throw {@link HttpApiError} for a response that does NOT carry a JSON
 * success body (streamed upload/download): a JSON error body is still parsed
 * and preserved, so the caller sees the route's code instead of raw text.
 * @param response - the non-ok response (or a stream that could not start).
 * @param fallback - message prefix used when the route sent no `error` field.
 */
export async function throwHttpError(response: Response, fallback: string): Promise<never> {
  const body = await parseJson(response)
  const object = bodyObject(body)
  const message = typeof object?.error === 'string' ? object.error : `${fallback}: HTTP ${response.status}`
  throw new HttpApiError(message, response.status, object)
}

/** Parse a response body as JSON; undefined when absent or not JSON. */
async function parseJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return undefined
  }
}

/** The parsed body as an error-body record, or undefined for non-objects. */
function bodyObject(body: unknown): HttpErrorBody | undefined {
  return typeof body === 'object' && body !== null ? body as HttpErrorBody : undefined
}

/** Build the transport error for a non-ok response. */
function errorFor(status: number, body: unknown): HttpApiError {
  const object = bodyObject(body)
  const message = typeof object?.error === 'string' ? object.error : `HTTP ${status}`
  return new HttpApiError(message, status, object)
}
