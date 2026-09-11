/**
 * Browser-side API client for the /api/dsh-ssh route family. The only data
 * access path the panel components use — plain fetch/WebSocket, same origin.
 */

import { HttpApiError, buildQuery, readJson, throwHttpError, type HttpErrorBody } from '../../client-http.ts'
import {
  SSH_API,
  type ClusterResult,
  type ExecResult,
  type HostPayload,
  type ImportResult,
  type KnownHostAction,
  type KnownHostView,
  type RemoteDirEntry,
  type SshHostSummary,
  type TerminalClientFrame,
  type TestResult,
  type TransferProgress,
  type TransferStreamLine,
  type TunnelInfo,
} from '../../ssh/protocol.ts'

/** Minimal File System Access API surface (not in all lib.dom versions). */
interface WindowWithFileSystemAccess {
  showSaveFilePicker?: (options: { suggestedName?: string }) => Promise<{
    createWritable: () => Promise<{
      write: (data: Uint8Array) => Promise<void>
      close: () => Promise<void>
      /** Discard the browser-managed temporary file instead of publishing it. */
      abort?: (reason?: unknown) => Promise<void>
    }>
  }>
}

/**
 * This family's error name for the ONE shared transport error
 * (`HttpApiError`): same class at runtime, so it carries the HTTP status and
 * the parsed body (code / secret / hostKeyFingerprint / hostKeyMismatch /
 * remaining / retryAfterMs) and existing `instanceof SshApiError` checks keep
 * working. Parsing lives in ./client-http.ts — never re-implemented here.
 */
export { HttpApiError as SshApiError }

/** Query-string helper (shared transport helper, no local copy). */
const query = buildQuery

/**
 * Structured fields of one streamed (`application/x-ndjson`) failure frame.
 * The upload route currently sends only `error`, so the interactive-gate
 * fields are picked up when present and simply absent otherwise — the same
 * shape the JSON routes produce, so callers handle one error type.
 */
function frameFailure(frame: TransferStreamLine): HttpErrorBody {
  const record = frame as TransferStreamLine & Partial<HttpErrorBody>
  const secret = record.secret
  return {
    ...(typeof record.error === 'string' ? { error: record.error } : {}),
    ...(typeof record.code === 'string' ? { code: record.code } : {}),
    ...(secret === 'password' || secret === 'passphrase' ? { secret } : {}),
    ...(typeof record.hostKeyFingerprint === 'string' ? { hostKeyFingerprint: record.hostKeyFingerprint } : {}),
    ...(typeof record.remaining === 'number' ? { remaining: record.remaining } : {}),
    ...(typeof record.retryAfterMs === 'number' ? { retryAfterMs: record.retryAfterMs } : {}),
  }
}

/** One open terminal connection (WebSocket JSON frames). */
export interface TerminalConnection {
  /** Fired on the ready frame (shell is up). */
  onReady: (() => void) | undefined
  /** Fired on every output frame. */
  onOutput: ((data: string) => void) | undefined
  /** Fired on the exit frame (or transport error). */
  onExit: ((code: number | null, error?: string) => void) | undefined
  /** Send raw input to the remote shell. */
  send(data: string): void
  /** Resize the remote PTY. */
  resize(cols: number, rows: number): void
  /** Close the socket and the remote session. */
  close(): void
}

/** The browser half's only data entry point. */
export class SshApi {
  // -------------------------------------------------------------- hosts
  async listHosts(queryText?: string): Promise<SshHostSummary[]> {
    const response = await fetch(SSH_API.hosts + query({ query: queryText }))
    const body = await readJson<{ hosts: SshHostSummary[] }>(response)
    return body.hosts
  }

  async createHost(payload: HostPayload): Promise<SshHostSummary> {
    const response = await fetch(SSH_API.hosts, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const body = await readJson<{ host: SshHostSummary }>(response)
    return body.host
  }

  async updateHost(alias: string, patch: HostPayload): Promise<SshHostSummary> {
    const response = await fetch(SSH_API.hosts + query({ alias }), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    })
    const body = await readJson<{ host: SshHostSummary }>(response)
    return body.host
  }

  async deleteHost(alias: string): Promise<void> {
    const response = await fetch(SSH_API.hosts + query({ alias }), { method: 'DELETE' })
    await readJson<{ ok: boolean }>(response)
  }

  async importSshConfig(): Promise<ImportResult> {
    const response = await fetch(SSH_API.importSshConfig, { method: 'POST' })
    const body = await readJson<{ result: ImportResult }>(response)
    return body.result
  }

  // ---------------------------------------------------------------- ops
  async testHost(alias: string): Promise<TestResult> {
    const response = await fetch(SSH_API.test, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ alias }),
    })
    const body = await readJson<{ result: TestResult }>(response)
    return body.result
  }

  async exec(alias: string, command: string, timeoutMs?: number): Promise<ExecResult> {
    const response = await fetch(SSH_API.exec, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ alias, command, timeoutMs }),
    })
    const body = await readJson<{ result: ExecResult }>(response)
    return body.result
  }

  async cluster(options: {
    command: string
    aliases?: string[]
    environment?: string
    tags?: string[]
    timeoutMs?: number
    maxWorkers?: number
  }): Promise<ClusterResult[]> {
    const response = await fetch(SSH_API.cluster, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(options),
    })
    const body = await readJson<{ results: ClusterResult[] }>(response)
    return body.results
  }

  // ----------------------------------------------------------------- ls
  async ls(alias: string, path: string): Promise<RemoteDirEntry[]> {
    const response = await fetch(SSH_API.ls + query({ alias, path }))
    const body = await readJson<{ entries: RemoteDirEntry[] }>(response)
    return body.entries
  }

  // ------------------------------------------------------------- tunnel
  async listTunnels(): Promise<TunnelInfo[]> {
    const response = await fetch(SSH_API.tunnel, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'list' }),
    })
    const body = await readJson<{ tunnels: TunnelInfo[] }>(response)
    return body.tunnels
  }

  async startTunnel(options: { alias: string; remotePort: number; remoteHost?: string; localPort?: number }): Promise<TunnelInfo> {
    const response = await fetch(SSH_API.tunnel, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'start', ...options }),
    })
    const body = await readJson<{ tunnel: TunnelInfo }>(response)
    return body.tunnel
  }

  async stopTunnel(tunnelId: string): Promise<boolean> {
    const response = await fetch(SSH_API.tunnel, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'stop', tunnelId }),
    })
    const body = await readJson<{ ok: boolean }>(response)
    return body.ok
  }

  async stopAllTunnels(alias?: string): Promise<number> {
    const response = await fetch(SSH_API.tunnel, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'stop-all', alias }),
    })
    const body = await readJson<{ stopped: number }>(response)
    return body.stopped
  }

  // ------------------------------------------------------------ transfer
  /**
   * Upload one file (raw bytes) to a remote path. Progress arrives through
   * the NDJSON response stream; resolves when the result frame lands.
   */
  async uploadFile(
    file: File,
    alias: string,
    remotePath: string,
    onProgress?: (progress: TransferProgress) => void,
    signal?: AbortSignal,
  ): Promise<{ transferredBytes: number }> {
    const response = await fetch(SSH_API.upload + query({ alias, remotePath }), {
      method: 'POST',
      body: file,
      signal,
    })
    // Errors here are JSON too (the route maps them through errorBody), so the
    // shared transport parses them instead of flattening the body to a string.
    if (!response.ok) await throwHttpError(response, 'upload failed')
    if (response.body === null) throw new HttpApiError('upload failed: the response carried no body stream', response.status)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let failure: HttpErrorBody | undefined
    let sawResult = false
    let commitStarted = false
    let readerDone = false
    let transferredBytes = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) {
          readerDone = true
          break
        }
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (line.trim() === '') continue
          let parsed: TransferStreamLine
          try {
            parsed = JSON.parse(line) as TransferStreamLine
          } catch {
            continue
          }
          if (parsed.type === 'progress') {
            onProgress?.(parsed.progress)
          } else if (parsed.type === 'commit') {
            commitStarted = true
          } else if (parsed.type === 'result') {
            sawResult = true
            if (parsed.ok) transferredBytes = parsed.transferredBytes ?? 0
            else failure = frameFailure(parsed)
          }
        }
      }
    } catch (error) {
      if (commitStarted) {
        throw new HttpApiError(
          'upload connection closed after commit began; the remote result is unknown',
          response.status,
          { code: 'RESULT_UNKNOWN' },
        )
      }
      throw error
    } finally {
      if (!readerDone) await reader.cancel().catch(() => undefined)
    }
    // A failed transfer is a typed transport error too: the interactive gates
    // (NEEDS_PASSWORD / HOST_KEY_*) must be able to prompt from this path.
    if (failure !== undefined) {
      throw new HttpApiError(typeof failure.error === 'string' ? failure.error : 'upload failed', response.status, failure)
    }
    if (!sawResult) {
      throw new HttpApiError(
        commitStarted
          ? 'upload connection closed after commit began; the remote result is unknown'
          : 'upload ended without a result frame — the remote destination was not published',
        response.status,
        commitStarted ? { code: 'RESULT_UNKNOWN' } : { code: 'ABORTED' },
      )
    }
    return { transferredBytes }
  }

  /**
   * Download a remote file with client-side progress. Streams straight to
   * disk when the File System Access API is available (no full-file RAM
   * copy); otherwise falls back to an in-memory Blob.
   */
  async downloadFile(
    alias: string,
    remotePath: string,
    onProgress?: (progress: TransferProgress) => void,
    signal?: AbortSignal,
  ): Promise<{ blob?: Blob; filename: string; streamed: boolean; bytes: number }> {
    const response = await fetch(SSH_API.download + query({ alias, remotePath }), { signal })
    // The success path is a raw byte stream, but the error path is the same
    // JSON body as every other route — the shared transport parses it, so the
    // caller keeps code/status instead of a flattened JSON string.
    if (!response.ok) await throwHttpError(response, 'download failed')
    if (response.body === null) throw new HttpApiError('download failed: the response carried no body stream', response.status)
    const total = Number(response.headers.get('content-length') ?? '0')
    const disposition = response.headers.get('content-disposition') ?? ''
    const match = /filename="([^"]+)"/.exec(disposition)
    const filename = match?.[1] ?? remotePath.split('/').pop() ?? 'download'
    const reader = response.body.getReader()
    const picker = typeof window !== 'undefined'
      ? (window as WindowWithFileSystemAccess).showSaveFilePicker
      : undefined
    let streamed = false
    let writable: {
      write: (data: Uint8Array) => Promise<void>
      close: () => Promise<void>
      abort?: (reason?: unknown) => Promise<void>
    } | undefined
    const chunks: Uint8Array<ArrayBuffer>[] = []
    let received = 0
    let readerDone = false
    let writableClosed = false
    const progress = (): void => {
      onProgress?.({
        phase: 'transferring',
        file: remotePath,
        transferred: received,
        total,
        percent: total > 0 ? Math.round((received / total) * 1000) / 10 : 0,
      })
    }
    try {
      try {
        if (picker !== undefined) {
          const handle = await picker.call(window, { suggestedName: filename })
          signal?.throwIfAborted()
          writable = await handle.createWritable()
          streamed = true
        }
      } catch (error) {
        // A user-cancelled picker falls back to Blob. An operation abort must
        // not continue into memory or later trigger a browser save.
        if (signal?.aborted === true) throw error
      }
      for (;;) {
        signal?.throwIfAborted()
        const { done, value } = await reader.read()
        if (done) {
          readerDone = true
          break
        }
        if (writable !== undefined) {
          await writable.write(value as Uint8Array)
        } else {
          chunks.push(value as Uint8Array<ArrayBuffer>)
        }
        received += value.length
        progress()
      }
      signal?.throwIfAborted()
      if (writable !== undefined) {
        await writable.close()
        writableClosed = true
      }
      onProgress?.({ phase: 'done', file: remotePath, transferred: received, total: received > 0 ? received : total, percent: 100 })
      return {
        blob: streamed ? undefined : new Blob(chunks),
        filename,
        streamed,
        bytes: received,
      }
    } catch (error) {
      chunks.length = 0
      if (!readerDone) await reader.cancel(error).catch(() => undefined)
      if (writable !== undefined && !writableClosed) {
        await writable.abort?.(error).catch(() => undefined)
      }
      throw error
    }
  }

  // ------------------------------------------------------------ terminal
  /** Open a WebSocket terminal session. */
  openTerminal(alias: string, cols: number, rows: number): TerminalConnection {
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const url = scheme + '://' + window.location.host + SSH_API.terminal + query({ alias, cols, rows })
    const socket = new WebSocket(url)
    const MAX_PENDING_INPUT = 64 * 1024
    let ready = false
    let finalized = false
    let queuedInput = ''
    let queuedResize: { cols: number; rows: number } | undefined
    let readyListener: (() => void) | undefined
    let readyDelivered = false
    let outputListener: ((data: string) => void) | undefined
    let exitListener: ((code: number | null, error?: string) => void) | undefined
    let exitRecord: { code: number | null; error?: string } | undefined
    let exitDelivered = false
    const deliverReady = (): void => {
      if (!ready || readyDelivered || readyListener === undefined) return
      readyDelivered = true
      readyListener()
    }
    const deliverExit = (): void => {
      if (exitRecord === undefined || exitDelivered || exitListener === undefined) return
      exitDelivered = true
      exitListener(exitRecord.code, exitRecord.error)
    }
    const finalize = (code: number | null, error?: string): void => {
      if (finalized) return
      finalized = true
      queuedInput = ''
      queuedResize = undefined
      exitRecord = error === undefined ? { code } : { code, error }
      deliverExit()
    }
    const sendFrame = (frame: TerminalClientFrame): void => {
      if (finalized || !ready || socket.readyState !== WebSocket.OPEN) return
      socket.send(JSON.stringify(frame))
    }
    const connection: TerminalConnection = {
      get onReady() { return readyListener },
      set onReady(listener) {
        readyListener = listener
        deliverReady()
      },
      get onOutput() { return outputListener },
      set onOutput(listener) { outputListener = listener },
      get onExit() { return exitListener },
      set onExit(listener) {
        exitListener = listener
        deliverExit()
      },
      send: (data) => {
        if (finalized) return
        if (!ready || socket.readyState !== WebSocket.OPEN) {
          if (queuedInput.length + data.length > MAX_PENDING_INPUT) {
            finalize(null, 'terminal input buffer exceeded before ready')
            try { socket.close(1008, 'terminal input buffer exceeded') } catch { /* already closed */ }
            return
          }
          queuedInput += data
          return
        }
        sendFrame({ type: 'input', data })
      },
      resize: (nextCols, nextRows) => {
        if (finalized) return
        const frame = { type: 'resize', cols: nextCols, rows: nextRows } satisfies TerminalClientFrame
        if (!ready || socket.readyState !== WebSocket.OPEN) {
          // Resize is state, not a sequence: one latest value is the complete
          // bounded buffer needed before the server reports shell readiness.
          queuedResize = { cols: nextCols, rows: nextRows }
          return
        }
        sendFrame(frame)
      },
      close: () => {
        try { socket.close() } catch { /* already closed */ }
      },
    }
    socket.onmessage = (event: MessageEvent<string>) => {
      try {
        const value: unknown = JSON.parse(event.data)
        if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid terminal frame')
        const frame = value as Record<string, unknown>
        if (frame.type === 'ready' && typeof frame.alias === 'string') {
          if (ready || finalized) return
          ready = true
          deliverReady()
          if (queuedResize !== undefined) {
            sendFrame({ type: 'resize', ...queuedResize })
            queuedResize = undefined
          }
          if (queuedInput !== '') {
            sendFrame({ type: 'input', data: queuedInput })
            queuedInput = ''
          }
          return
        }
        if (frame.type === 'output' && typeof frame.data === 'string') {
          outputListener?.(frame.data)
          return
        }
        if (frame.type === 'exit' && (typeof frame.code === 'number' || frame.code === null) && (frame.error === undefined || typeof frame.error === 'string')) {
          finalize(frame.code as number | null, frame.error as string | undefined)
          try { socket.close(1000) } catch { /* already closed */ }
          return
        }
        throw new Error('invalid terminal frame')
      } catch {
        finalize(null, 'invalid terminal server frame')
        try { socket.close(1008, 'invalid terminal server frame') } catch { /* already closed */ }
      }
    }
    socket.onclose = () => { finalize(null, 'connection closed') }
    socket.onerror = () => { finalize(null, 'connection error') }
    return connection
  }

  // --------------------------------------------------------- known-hosts
  /** Read the host-key trust records (optionally one alias's). */
  async listKnownHosts(alias?: string): Promise<KnownHostView[]> {
    const response = await fetch(SSH_API.knownHosts + query({ alias }))
    const body = await readJson<{ records: KnownHostView[] }>(response)
    return body.records
  }

  /** Confirm (trust) or reset (forget) one alias's host key. */
  async hostKeyAction(alias: string, action: KnownHostAction): Promise<void> {
    const response = await fetch(SSH_API.knownHosts, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ alias, action }),
    })
    await readJson<{ ok: true }>(response)
  }

  // -------------------------------------------------------- connections
  /** Aliases currently holding a live pooled SSH connection (badge coloring). */
  async connectedAliases(): Promise<string[]> {
    const response = await fetch(SSH_API.connections)
    const body = await readJson<{ connected: string[] }>(response)
    return body.connected
  }

  // ------------------------------------------------------ session secrets

  /** Provide a password/passphrase for `alias` THIS SESSION ONLY (never
   *  persisted). Called when a connection replied NEEDS_PASSWORD; after
   *  injection the caller retries the operation. */
  async setSessionSecret(alias: string, secret: { password?: string; passphrase?: string }): Promise<void> {
    const response = await fetch(SSH_API.sessionSecret, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ alias, ...secret }),
    })
    await readJson<{ ok: true }>(response)
  }
}
