import type { Client, ClientChannel } from 'ssh2'
import type { ExecSession, ShellSession } from '../engine.ts'

/** A fresh SSH channel (shell/exec) must open within this budget; a dead or
 *  half-open connection would otherwise leave the open promise hanging. */
const CHANNEL_OPEN_TIMEOUT_MS = 10_000

/**
 * Narrow connection dependency used by the standalone terminal transports.
 * `connectStandalone` must reach the store itself (the not-found wording is
 * this component's own contract) and must always return a PRIVATE connection
 * — never a pooled one.
 */
export interface TerminalConnectionAccess {
  connectStandalone(alias: string): Promise<{ client: Client; hops: Client[] }>
}

/**
 * Owns the standalone PTY-shell / streaming-exec transports: one exclusive
 * connection per session (closing a shell can therefore never tear down a
 * pooled exec or tunnel sharing the alias), the channel-open deadline,
 * idempotent teardown and session assembly.
 */
export class TerminalService {
  /** Teardowns of live standalone transports, so dispose() can close sessions
   *  that the caller never closed explicitly (openShell/openExec own their
   *  whole connection and would otherwise outlive the engine). */
  private readonly activeTeardowns = new Set<() => void>()

  constructor(private readonly connection: TerminalConnectionAccess) {}

  /**
   * Open one standalone channel on its own connection (never a pooled one).
   * Shared by openShell/openExec: alias lookup, jump chain, channel-open
   * timeout, idempotent teardown, and late-callback cleanup live here, so the
   * two public methods keep only their session-specific assembly.
   */
  private async openStandaloneChannel(
    alias: string,
    open: (client: Client, callback: (error: Error | undefined, stream?: ClientChannel) => void) => void,
  ): Promise<{ stream: ClientChannel; teardown: () => void }> {
    const { client, hops } = await this.connection.connectStandalone(alias)
    return await new Promise<{ stream: ClientChannel; teardown: () => void }>((resolve, reject) => {
      let settled = false
      let tornDown = false
      const teardown = (): void => {
        if (tornDown) return
        tornDown = true
        this.activeTeardowns.delete(teardown)
        try { client.end() } catch { /* closed */ }
        for (const hop of hops) { try { hop.end() } catch { /* closed */ } }
      }
      this.activeTeardowns.add(teardown)
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        teardown()
        reject(new Error(`channel on '${alias}' did not open within ${CHANNEL_OPEN_TIMEOUT_MS} ms`))
      }, CHANNEL_OPEN_TIMEOUT_MS)
      timer.unref?.()
      open(client, (error, stream) => {
        if (settled) {
          // Late arrival after the timeout: the connection is being torn
          // down; close any channel that finally opened instead of leaking it.
          if (stream !== undefined) {
            try { stream.close() } catch { /* already closed */ }
          }
          teardown()
          return
        }
        settled = true
        clearTimeout(timer)
        if (error !== undefined) {
          teardown()
          reject(error)
          return
        }
        if (stream === undefined) {
          teardown()
          reject(new Error(`channel on '${alias}' opened without a stream`))
          return
        }
        resolve({ stream, teardown })
      })
    })
  }

  /** Open a PTY shell session for the web terminal (standalone connection). */
  async openShell(alias: string, size: { cols: number; rows: number }): Promise<ShellSession> {
    // The shell is a long-lived exclusive stream: use its own connection so
    // closing it can never tear down a pooled exec/tunnel sharing the alias.
    const { stream, teardown } = await this.openStandaloneChannel(alias, (client, callback) => {
      client.shell({ term: 'xterm-256color', cols: size.cols, rows: size.rows }, callback)
    })
    const session: ShellSession = {
      send: (data) => { try { stream.write(data) } catch { /* channel gone */ } },
      resize: (cols, rows) => { try { stream.setWindow(rows, cols, rows, cols) } catch { /* channel gone */ } },
      signal: (name) => { try { stream.signal(name) } catch { /* channel gone */ } },
      close: () => {
        try { stream.close() } catch { /* channel gone */ }
        teardown()
      },
      pause: () => { try { stream.pause() } catch { /* channel gone */ } },
      resume: () => { try { stream.resume() } catch { /* channel gone */ } },
    }
    stream.on('data', (chunk: Buffer) => { session.onData?.(chunk) })
    stream.on('close', (code: number | null) => {
      teardown()
      session.onExit?.(code)
    })
    stream.on('error', (streamError: Error) => {
      teardown()
      session.onExit?.(null, streamError instanceof Error ? streamError.message : String(streamError))
    })
    return session
  }

  /**
   * Open a streaming exec channel (no PTY) for the remote subprocess seam.
   * Like the PTY shell, the channel rides its own connection so closing it
   * can never tear down a pooled exec/tunnel sharing the alias.
   */
  async openExec(alias: string, command: string): Promise<ExecSession> {
    const { stream, teardown } = await this.openStandaloneChannel(alias, (client, callback) => {
      client.exec(command, callback)
    })
    let exitListener: ExecSession['onExit']
    let exitRecord: { code: number | null; error?: string } | undefined
    let exitDelivered = false
    const deliverExit = (): void => {
      if (exitDelivered || exitRecord === undefined || exitListener === undefined) return
      exitDelivered = true
      exitListener(exitRecord.code, exitRecord.error)
    }
    const finish = (code: number | null, error?: string): void => {
      if (exitRecord !== undefined) return
      exitRecord = error === undefined ? { code } : { code, error }
      teardown()
      deliverExit()
    }
    const session: ExecSession = {
      stdin: stream,
      send: (data) => { try { stream.write(data) } catch { /* channel gone */ } },
      end: (data) => {
        try {
          if (data !== undefined && data !== '') stream.write(data)
          stream.end()
        } catch { /* channel gone */ }
      },
      get onExit() { return exitListener },
      set onExit(listener) {
        exitListener = listener
        deliverExit()
      },
      resize: () => { /* exec channels have no PTY */ },
      signal: (name) => { try { stream.signal(name) } catch { /* channel gone */ } },
      close: () => {
        try { stream.close() } catch { /* channel gone */ }
        teardown()
      },
      pause: () => { try { stream.pause() } catch { /* channel gone */ } },
      resume: () => { try { stream.resume() } catch { /* channel gone */ } },
    }
    stream.on('data', (chunk: Buffer) => { session.onData?.(chunk) })
    stream.stderr.on('data', (chunk: Buffer) => { session.onErrData?.(chunk) })
    stream.on('close', (code: number | null) => { finish(code) })
    stream.on('error', (streamError: Error) => {
      finish(null, streamError instanceof Error ? streamError.message : String(streamError))
    })
    return session
  }

  /** Close every standalone transport this service still owns. */
  dispose(): void {
    for (const teardown of [...this.activeTeardowns]) teardown()
  }
}
