/**
 * Browser-side HTTP helpers for the dsh-hardssh route clients.
 * Plain fetch / same-origin — bundled inline into the client bundle.
 */

/** Error carrying the route's JSON error message and stable code/status. */
export class HttpApiError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly status?: number,
  ) {
    super(message)
    this.name = 'HttpApiError'
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

/** Parse a JSON response or throw an HttpApiError (code/status preserved). */
export async function readJson<T>(response: Response): Promise<T> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new HttpApiError(`HTTP ${response.status}: invalid JSON response`, undefined, response.status)
  }
  if (!response.ok) {
    const record = typeof body === 'object' && body !== null
      ? body as { error?: unknown; code?: unknown }
      : undefined
    const message = typeof record?.error === 'string' ? record.error : `HTTP ${response.status}`
    const code = typeof record?.code === 'string' ? record.code : undefined
    throw new HttpApiError(message, code, response.status)
  }
  return body as T
}
