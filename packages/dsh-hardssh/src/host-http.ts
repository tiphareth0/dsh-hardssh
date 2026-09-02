/**
 * Host-side HTTP route helpers for the dsh-hardssh route family.
 * HOST-ONLY: these import node:http types and must never end up in the
 * client bundle (the client half never imports this module).
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

/** One JSON response. */
export function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' })
  res.end(payload)
}

/** URL query helper (first value, decoded). */
export function queryParam(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name)
  return value === null ? undefined : value
}

/** Loopback literal check plus browser same-origin markers (mirrors dsh-ssh). */
export function isLoopbackRequest(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl: URL
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

export type ReadJsonBodyResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; reason: 'too-large' | 'malformed' | 'not-object' }

/**
 * Read a JSON request body with a hard byte cap. Discriminative result so
 * the caller keeps its own error mapping (silent undefined vs 400/413).
 */
export async function readJsonBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<ReadJsonBodyResult> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maxBytes) return { ok: false, reason: 'too-large' }
    chunks.push(buffer)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'not-object' }
  }
  return { ok: true, body: parsed as Record<string, unknown> }
}
