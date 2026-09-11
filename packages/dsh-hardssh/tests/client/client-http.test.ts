/**
 * A-05 (client side): the ONE browser transport layer. Both route families
 * (workspace + SSH) must decode errors through the same class and the same
 * parser, keeping the HTTP status and every field the UI reads
 * (code / secret / hostKeyFingerprint / hostKeyMismatch / remaining /
 * retryAfterMs) instead of flattening them into a string.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { HttpApiError, buildQuery, readJson, throwHttpError } from '../../src/client-http.ts'
import { WorkspaceApiError } from '../../src/client/api.ts'
import { SshApi, SshApiError } from '../../src/client/ssh/api.ts'

/** One JSON response double. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('readJson (single transport parser)', () => {
  it('returns the parsed body for a successful response', async () => {
    await expect(readJson<{ hosts: string[] }>(jsonResponse({ hosts: ['a'] }))).resolves.toEqual({ hosts: ['a'] })
  })

  it('keeps status, parsed body and every interactive-gate field', async () => {
    const response = jsonResponse({
      error: 'host key mismatch',
      code: 'HOST_KEY_MISMATCH',
      hostKeyFingerprint: 'SHA256:abc',
      hostKeyMismatch: { expected: 'SHA256:old', actual: 'SHA256:abc' },
      workspaces: [{ id: 'w1', title: 'one' }],
      remaining: 2,
      retryAfterMs: 1500,
      secret: 'passphrase',
    }, 500)
    const error = await readJson(response).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(HttpApiError)
    const failure = error as HttpApiError
    expect(failure.status).toBe(500)
    expect(failure.message).toBe('host key mismatch')
    expect(failure.code).toBe('HOST_KEY_MISMATCH')
    expect(failure.hostKeyFingerprint).toBe('SHA256:abc')
    expect(failure.hostKeyMismatch).toEqual({ expected: 'SHA256:old', actual: 'SHA256:abc' })
    expect(failure.secret).toBe('passphrase')
    expect(failure.remaining).toBe(2)
    expect(failure.retryAfterMs).toBe(1500)
    expect(failure.body?.workspaces).toEqual([{ id: 'w1', title: 'one' }])
  })

  it('reports a non-JSON body with the HTTP status and no body', async () => {
    const response = new Response('<html>nope</html>', { status: 502 })
    const error = await readJson(response).catch((cause: unknown) => cause) as HttpApiError
    expect(error).toBeInstanceOf(HttpApiError)
    expect(error.status).toBe(502)
    expect(error.body).toBeUndefined()
    expect(error.message).toBe('HTTP 502: invalid JSON response')
  })

  it('falls back to the status text for a non-object error body', async () => {
    const error = await readJson(jsonResponse('boom', 400)).catch((cause: unknown) => cause) as HttpApiError
    expect(error.status).toBe(400)
    expect(error.message).toBe('HTTP 400')
    expect(error.code).toBeUndefined()
  })
})

describe('throwHttpError (streamed routes)', () => {
  it('parses the JSON error body of a non-ok stream response', async () => {
    const error = await throwHttpError(jsonResponse({ error: 'upload body too large', code: 'too-large' }, 413), 'upload failed')
      .catch((cause: unknown) => cause) as HttpApiError
    expect(error).toBeInstanceOf(HttpApiError)
    expect(error.status).toBe(413)
    expect(error.message).toBe('upload body too large')
    expect(error.code).toBe('too-large')
  })

  it('keeps the caller prefix when the route sent no JSON body', async () => {
    const error = await throwHttpError(new Response('', { status: 500 }), 'download failed')
      .catch((cause: unknown) => cause) as HttpApiError
    expect(error.message).toBe('download failed: HTTP 500')
    expect(error.status).toBe(500)
    expect(error.body).toBeUndefined()
  })
})

describe('one class across both route families', () => {
  it('exposes the SSH name as the same class (instanceof keeps working)', () => {
    const error = new HttpApiError('x', 500, { code: 'HOST_KEY_UNKNOWN', hostKeyFingerprint: 'SHA256:fp' })
    expect(error).toBeInstanceOf(SshApiError)
    expect(error.code).toBe('HOST_KEY_UNKNOWN')
    expect(error.hostKeyFingerprint).toBe('SHA256:fp')
  })

  it('keeps WorkspaceApiError a subclass of the transport class', () => {
    const error = new WorkspaceApiError('x', 404, { code: 'io' })
    expect(error).toBeInstanceOf(HttpApiError)
    expect(error.status).toBe(404)
    expect(error.code).toBe('io')
  })

  it('SshApi.listHosts surfaces the shared error with status and code', async () => {
    vi.stubGlobal('fetch', async () => jsonResponse({ error: 'host-key trust store is not enabled', code: 'HOST_KEY_DISABLED' }, 404))
    const error = await new SshApi().listHosts().catch((cause: unknown) => cause) as HttpApiError
    expect(error).toBeInstanceOf(SshApiError)
    expect(error.status).toBe(404)
    expect(error.code).toBe('HOST_KEY_DISABLED')
  })

  it('SshApi.downloadFile parses the JSON error body instead of the raw text', async () => {
    vi.stubGlobal('fetch', async () => jsonResponse({ error: 'no such file', code: 'ENOENT' }, 404))
    const error = await new SshApi().downloadFile('h1', '/srv/missing').catch((cause: unknown) => cause) as HttpApiError
    expect(error).toBeInstanceOf(SshApiError)
    expect(error.status).toBe(404)
    expect(error.message).toBe('no such file')
    expect(error.code).toBe('ENOENT')
  })

  it('SshApi.uploadFile parses the JSON error body of a refused upload', async () => {
    vi.stubGlobal('fetch', async () => jsonResponse({ error: 'upload body too large', code: 'too-large' }, 413))
    const error = await new SshApi().uploadFile(new File(['x'], 'x.txt'), 'h1', '/srv/x.txt')
      .catch((cause: unknown) => cause) as HttpApiError
    expect(error).toBeInstanceOf(SshApiError)
    expect(error.status).toBe(413)
    expect(error.code).toBe('too-large')
  })
})

describe('B-14: interactive-gate failures survive the transfer paths', () => {
  it('uploadFile keeps NEEDS_PASSWORD + secret from the route body', async () => {
    vi.stubGlobal('fetch', async () => jsonResponse({ error: 'password required for h1', code: 'NEEDS_PASSWORD', secret: 'password' }, 500))
    const error = await new SshApi().uploadFile(new File(['x'], 'x.txt'), 'h1', '/srv/x.txt')
      .catch((cause: unknown) => cause) as HttpApiError
    expect(error).toBeInstanceOf(SshApiError)
    expect(error.status).toBe(500)
    expect(error.code).toBe('NEEDS_PASSWORD')
    expect(error.secret).toBe('password')
  })

  it('downloadFile keeps HOST_KEY_UNKNOWN + fingerprint from the route body', async () => {
    vi.stubGlobal('fetch', async () => jsonResponse({ error: 'unknown host key', code: 'HOST_KEY_UNKNOWN', hostKeyFingerprint: 'SHA256:fp' }, 500))
    const error = await new SshApi().downloadFile('h1', '/srv/x.txt').catch((cause: unknown) => cause) as HttpApiError
    expect(error).toBeInstanceOf(SshApiError)
    expect(error.status).toBe(500)
    expect(error.code).toBe('HOST_KEY_UNKNOWN')
    expect(error.hostKeyFingerprint).toBe('SHA256:fp')
  })

  it('uploadFile surfaces a structured streamed failure frame', async () => {
    vi.stubGlobal('fetch', async () => new Response(
      '{"type":"progress","progress":{"phase":"connecting","file":"/srv/x","transferred":0,"total":1,"percent":0}}\n'
      + '{"type":"result","ok":false,"error":"passphrase required","code":"NEEDS_PASSWORD","secret":"passphrase"}\n',
      { status: 200, headers: { 'content-type': 'application/x-ndjson' } },
    ))
    const error = await new SshApi().uploadFile(new File(['x'], 'x.txt'), 'h1', '/srv/x.txt')
      .catch((cause: unknown) => cause) as HttpApiError
    expect(error).toBeInstanceOf(SshApiError)
    expect(error.status).toBe(200)
    expect(error.message).toBe('passphrase required')
    expect(error.code).toBe('NEEDS_PASSWORD')
    expect(error.secret).toBe('passphrase')
  })

  it('uploadFile still reports a frame that carries only a message', async () => {
    vi.stubGlobal('fetch', async () => new Response('{"type":"result","ok":false,"error":"sftp write failed"}\n', { status: 200 }))
    const error = await new SshApi().uploadFile(new File(['x'], 'x.txt'), 'h1', '/srv/x.txt')
      .catch((cause: unknown) => cause) as HttpApiError
    expect(error.message).toBe('sftp write failed')
    expect(error.code).toBeUndefined()
  })

  it('a non-JSON error body yields a sane typed error, never the raw text', async () => {
    const html = '<html><body><h1>502 Bad Gateway</h1></body></html>'
    vi.stubGlobal('fetch', async () => new Response(html, { status: 502, headers: { 'content-type': 'text/html' } }))
    const download = await new SshApi().downloadFile('h1', '/srv/x.txt').catch((cause: unknown) => cause) as HttpApiError
    expect(download).toBeInstanceOf(SshApiError)
    expect(download.status).toBe(502)
    expect(download.message).toBe('download failed: HTTP 502')
    expect(download.message).not.toContain('<html>')
    expect(download.code).toBeUndefined()

    const upload = await new SshApi().uploadFile(new File(['x'], 'x.txt'), 'h1', '/srv/x.txt')
      .catch((cause: unknown) => cause) as HttpApiError
    expect(upload).toBeInstanceOf(SshApiError)
    expect(upload.status).toBe(502)
    expect(upload.message).toBe('upload failed: HTTP 502')
    expect(upload.message).not.toContain('<html>')
  })
})

describe('HSSH-11/HSSH-17 client cancellation and terminal lifecycle', () => {
  it('passes transfer signals to fetch and reports a lost post-commit upload as RESULT_UNKNOWN', async () => {
    let receivedSignal: AbortSignal | null | undefined
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      receivedSignal = init?.signal
      return new Response('{"type":"commit"}\n', { status: 200 })
    })
    const controller = new AbortController()
    const error = await new SshApi().uploadFile(new File(['x'], 'x.txt'), 'h1', '/srv/x', undefined, controller.signal)
      .catch((cause: unknown) => cause) as HttpApiError
    expect(receivedSignal).toBe(controller.signal)
    expect(error).toBeInstanceOf(SshApiError)
    expect(error.code).toBe('RESULT_UNKNOWN')
  })

  it('aborts a browser file-system writable instead of publishing a partial download', async () => {
    const writable = {
      write: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
    }
    vi.stubGlobal('window', {
      showSaveFilePicker: async () => ({ createWritable: async () => writable }),
    })
    let receivedSignal: AbortSignal | null | undefined
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      receivedSignal = init?.signal
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])) },
      }), {
        status: 200,
        headers: { 'content-length': '6', 'content-disposition': 'attachment; filename="x.bin"' },
      })
    })
    const controller = new AbortController()
    const pending = new SshApi().downloadFile('h1', '/srv/x.bin', () => { controller.abort() }, controller.signal)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(receivedSignal).toBe(controller.signal)
    expect(writable.abort).toHaveBeenCalledTimes(1)
    expect(writable.close).not.toHaveBeenCalled()
  })

  it('buffers bounded pre-ready input/latest resize and finalizes exit once', () => {
    class FakeWebSocket {
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      static readonly CLOSING = 2
      static readonly CLOSED = 3
      static instances: FakeWebSocket[] = []
      readyState = FakeWebSocket.OPEN
      sent: string[] = []
      onmessage: ((event: MessageEvent<string>) => void) | null = null
      onclose: (() => void) | null = null
      onerror: (() => void) | null = null
      constructor(readonly url: string) { FakeWebSocket.instances.push(this) }
      send(data: string): void { this.sent.push(data) }
      close(): void {
        this.readyState = FakeWebSocket.CLOSED
        this.onclose?.()
      }
    }
    vi.stubGlobal('window', { location: { protocol: 'http:', host: '127.0.0.1:3080' } })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const connection = new SshApi().openTerminal('h1', 80, 24)
    const socket = FakeWebSocket.instances[0]!
    connection.send('echo ready\r')
    connection.resize(100, 40)
    connection.resize(120, 50)
    expect(socket.sent).toEqual([])

    socket.onmessage?.({ data: '{"type":"ready","alias":"h1"}' } as MessageEvent<string>)
    expect(socket.sent.map(value => JSON.parse(value))).toEqual([
      { type: 'resize', cols: 120, rows: 50 },
      { type: 'input', data: 'echo ready\r' },
    ])

    const onExit = vi.fn()
    connection.onExit = onExit
    socket.onmessage?.({ data: '{"type":"exit","code":0}' } as MessageEvent<string>)
    socket.onclose?.()
    socket.onerror?.()
    expect(onExit).toHaveBeenCalledTimes(1)
    expect(onExit).toHaveBeenCalledWith(0, undefined)
  })
})

describe('buildQuery (shared, no per-client copy)', () => {
  it('skips undefined and empty values', () => {
    expect(buildQuery({ alias: 'h1', path: '', port: 0, missing: undefined })).toBe('?alias=h1&port=0')
    expect(buildQuery({})).toBe('')
  })
})
