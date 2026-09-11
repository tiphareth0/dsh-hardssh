/**
 * Host-side HTTP helpers (`src/host-http.ts`) are the shared gate in front of
 * every dsh-hardssh route: `isLoopbackRequest` is what keeps the local-host
 * routes from being driven by a cross-site page, and `readJsonBody` is the only
 * body-size guard. The route tests only cover the happy paths through these
 * helpers, so the rejection combinations are asserted directly here.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { isLoopbackRequest, queryParam, readJsonBody, writeJson } from '../src/host-http.ts'

/** Minimal `IncomingMessage` stand-in: only the fields the helper reads. */
function request(options: {
  remoteAddress?: string
  host?: string
  origin?: string
  secFetchSite?: string
}): IncomingMessage {
  const headers: Record<string, string> = {}
  if (options.host !== undefined) headers.host = options.host
  if (options.origin !== undefined) headers.origin = options.origin
  if (options.secFetchSite !== undefined) headers['sec-fetch-site'] = options.secFetchSite
  return {
    socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
    headers,
  } as unknown as IncomingMessage
}

/** Minimal async-iterable request body, delivered as the given chunks. */
function body(chunks: (string | Buffer)[]): IncomingMessage {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    },
  } as unknown as IncomingMessage
}

interface RecordedResponse {
  res: ServerResponse
  status: number | undefined
  headers: Record<string, unknown> | undefined
  payload: string | undefined
}

function recordingResponse(): RecordedResponse {
  const recorded: RecordedResponse = { res: undefined as unknown as ServerResponse, status: undefined, headers: undefined, payload: undefined }
  recorded.res = {
    writeHead: (status: number, headers: Record<string, unknown>) => {
      recorded.status = status
      recorded.headers = headers
      return recorded.res
    },
    end: (payload?: string) => {
      recorded.payload = payload
      return recorded.res
    },
  } as unknown as ServerResponse
  return recorded
}

describe('isLoopbackRequest', () => {
  it('accepts a loopback peer with a loopback Host and no Origin (e.g. curl)', () => {
    expect(isLoopbackRequest(request({ host: '127.0.0.1:3080' }))).toBe(true)
    expect(isLoopbackRequest(request({ remoteAddress: '::1', host: 'localhost:3080' }))).toBe(true)
    expect(isLoopbackRequest(request({ remoteAddress: '::ffff:127.0.0.1', host: '[::1]:3080' }))).toBe(true)
  })

  it('accepts a same-origin browser request', () => {
    expect(isLoopbackRequest(request({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }))).toBe(true)
    expect(isLoopbackRequest(request({ host: 'localhost:3080', origin: 'http://localhost:3080' }))).toBe(true)
  })

  it('rejects a non-loopback peer address even with a loopback Host', () => {
    expect(isLoopbackRequest(request({ remoteAddress: '192.168.1.5', host: '127.0.0.1:3080' }))).toBe(false)
  })

  it('rejects a non-loopback Host (DNS rebinding)', () => {
    expect(isLoopbackRequest(request({ host: 'evil.example.com' }))).toBe(false)
    expect(isLoopbackRequest(request({ host: 'evil.example.com:3080' }))).toBe(false)
  })

  it('rejects a missing Host header', () => {
    expect(isLoopbackRequest(request({}))).toBe(false)
  })

  it('rejects a malformed Host header', () => {
    expect(isLoopbackRequest(request({ host: 'not a host' }))).toBe(false)
  })

  it('rejects cross-site fetches even from loopback with a matching Origin', () => {
    expect(isLoopbackRequest(request({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', secFetchSite: 'cross-site' }))).toBe(false)
  })

  it('rejects an Origin on the same host but a different port', () => {
    expect(isLoopbackRequest(request({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:9999' }))).toBe(false)
  })

  it('rejects a malformed Origin', () => {
    expect(isLoopbackRequest(request({ host: '127.0.0.1:3080', origin: 'not a url' }))).toBe(false)
  })
})

describe('readJsonBody', () => {
  it('parses an object body spread across chunks', async () => {
    expect(await readJsonBody(body(['{"a":', '1}']), 1024)).toEqual({ ok: true, body: { a: 1 } })
  })

  it('accepts a body exactly at the byte cap and rejects one byte more', async () => {
    const payload = '{"a":1}' // 7 bytes
    expect((await readJsonBody(body([payload]), 7)).ok).toBe(true)
    expect(await readJsonBody(body([payload]), 6)).toEqual({ ok: false, reason: 'too-large' })
  })

  it('applies the cap across chunk boundaries, not per chunk', async () => {
    // 6 + 8 bytes, each chunk below the cap but 14 together: the running total,
    // not the individual chunk, must trip the limit.
    expect(await readJsonBody(body(['{"aaaa', 'bbbb":1}']), 13)).toEqual({ ok: false, reason: 'too-large' })
    expect(await readJsonBody(body(['{"aaaa', 'bbbb":1}']), 14)).toEqual({ ok: true, body: { aaaabbbb: 1 } })
  })

  it('reports malformed JSON, including an empty body', async () => {
    expect(await readJsonBody(body(['{oops']), 1024)).toEqual({ ok: false, reason: 'malformed' })
    expect(await readJsonBody(body([]), 1024)).toEqual({ ok: false, reason: 'malformed' })
  })

  it('rejects non-object JSON documents', async () => {
    for (const payload of ['[1,2]', 'null', '"text"', '42']) {
      expect(await readJsonBody(body([payload]), 1024)).toEqual({ ok: false, reason: 'not-object' })
    }
  })
})

describe('writeJson', () => {
  it('writes the status, JSON content type, no-referrer policy and body', () => {
    const recorded = recordingResponse()
    writeJson(recorded.res, 400, { ok: false, code: 'BAD_PATH' })
    expect(recorded.status).toBe(400)
    expect(recorded.headers).toMatchObject({
      'content-type': 'application/json; charset=utf-8',
      'referrer-policy': 'no-referrer',
    })
    expect(recorded.payload).toBe('{"ok":false,"code":"BAD_PATH"}')
  })
})

describe('queryParam', () => {
  it('returns the first decoded value and undefined when absent', () => {
    const url = new URL('http://127.0.0.1/api?alias=a%2Fb&empty=&alias=second')
    expect(queryParam(url, 'alias')).toBe('a/b')
    expect(queryParam(url, 'empty')).toBe('')
    expect(queryParam(url, 'missing')).toBeUndefined()
  })
})
