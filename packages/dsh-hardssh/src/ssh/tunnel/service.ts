import { createServer, type Server as NetServer } from 'node:net'
import type { Client } from 'ssh2'
import type { ClientLease } from '../connection/lease.ts'
import type { SshConnectionService } from '../connection/pool.ts'
import type { SshHostEntry, TunnelInfo } from '../protocol.ts'

const TUNNEL_FORWARD_TIMEOUT_MS = 10_000

/** Narrow connection dependency used by the tunnel component. */
export interface TunnelConnectionAccess {
  readonly connections: SshConnectionService
  findEntry(alias: string): SshHostEntry | undefined
}

interface TunnelRecord {
  info: TunnelInfo
  server: NetServer
  alias: string
  lease: ClientLease
  sockets: Set<import('node:net').Socket>
  clientFailureHandler: (error?: unknown) => void
}

/** Owns local listeners, forwarded sockets, and tunnel leases. */
export class TunnelService {
  private readonly tunnels = new Map<string, TunnelRecord>()
  private nextTunnelId = 1

  constructor(private readonly connection: TunnelConnectionAccess) {}

  private removeClientFailureListener(tunnel: TunnelRecord): void {
    const client = tunnel.lease.client
    client.removeListener('error', tunnel.clientFailureHandler)
    client.removeListener('close', tunnel.clientFailureHandler)
  }

  private markFailedForClient(client: Client, error?: unknown): void {
    for (const tunnel of this.tunnels.values()) {
      if (tunnel.lease.client !== client) continue
      tunnel.info.state = 'failed'
      this.removeClientFailureListener(tunnel)
      try { tunnel.server.close() } catch { /* never listened or already closed */ }
      for (const socket of tunnel.sockets) {
        try { socket.destroy() } catch { /* peer already gone */ }
      }
      tunnel.sockets.clear()
      tunnel.lease.markBroken(error)
      tunnel.lease.release()
    }
  }

  async startTunnel(alias: string, options: { remotePort: number; remoteHost?: string; localPort?: number }): Promise<TunnelInfo> {
    if (!Number.isInteger(options.remotePort) || options.remotePort < 1 || options.remotePort > 65535) {
      throw new Error('remotePort must be an integer in 1..65535')
    }
    if (options.localPort !== undefined && (!Number.isInteger(options.localPort) || options.localPort < 1 || options.localPort > 65535)) {
      throw new Error('localPort must be an integer in 1..65535')
    }
    if (this.connection.findEntry(alias) === undefined) throw new Error(`alias '${alias}' not found —add it first`)

    const remoteHost = options.remoteHost ?? '127.0.0.1'
    const id = `tun-${this.nextTunnelId++}`
    const info: TunnelInfo = {
      id,
      alias,
      localPort: 0,
      remoteHost,
      remotePort: options.remotePort,
      state: 'connecting',
      startedAt: Date.now(),
    }
    const lease = await this.connection.connections.acquire(alias, { kind: 'tunnel' })
    const client = lease.client
    const sockets = new Set<import('node:net').Socket>()

    const server = createServer((socket) => {
      sockets.add(socket)
      let forwardFinished = false
      let forwardTimer: NodeJS.Timeout | undefined

      const abandonForward = (): void => {
        if (!forwardFinished) {
          forwardFinished = true
          if (forwardTimer !== undefined) clearTimeout(forwardTimer)
        }
        // HSSH-09: normal short connections must not remain retained.
        sockets.delete(socket)
      }
      socket.once('close', abandonForward)

      forwardTimer = setTimeout(() => {
        if (forwardFinished) return
        forwardFinished = true
        try {
          socket.destroy(new Error(`SSH tunnel forward timed out after ${TUNNEL_FORWARD_TIMEOUT_MS}ms`))
        } catch { /* local peer already gone */ }
      }, TUNNEL_FORWARD_TIMEOUT_MS)
      forwardTimer.unref?.()

      client.forwardOut('127.0.0.1', 0, remoteHost, options.remotePort, (error, stream) => {
        if (forwardFinished || socket.destroyed) {
          if (forwardTimer !== undefined) clearTimeout(forwardTimer)
          forwardFinished = true
          if (stream !== undefined) {
            try { stream.close() } catch { /* late channel already closed */ }
          }
          return
        }
        forwardFinished = true
        if (forwardTimer !== undefined) clearTimeout(forwardTimer)
        if (error !== undefined) {
          socket.destroy()
          return
        }
        const destroy = (): void => {
          try { socket.destroy() } catch { /* gone */ }
          try { stream.close() } catch { /* gone */ }
        }
        stream.on('error', destroy)
        socket.on('error', destroy)
        stream.on('close', destroy)
        socket.on('close', destroy)
        stream.pipe(socket).pipe(stream)
      })
    })

    let rejectStart: ((reason?: unknown) => void) | undefined
    const clientFailureHandler = (error?: unknown): void => {
      this.markFailedForClient(client, error)
      rejectStart?.(error instanceof Error
        ? error
        : new Error(`SSH connection '${alias}' closed while starting tunnel`))
    }
    const tunnel: TunnelRecord = { info, server, alias, lease, sockets, clientFailureHandler }
    this.tunnels.set(id, tunnel)
    client.once('error', clientFailureHandler)
    client.once('close', clientFailureHandler)

    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false
        const resolveOnce = (): void => {
          if (settled) return
          settled = true
          rejectStart = undefined
          server.removeListener('error', rejectOnce)
          resolve()
        }
        const rejectOnce = (error: unknown): void => {
          if (settled) return
          settled = true
          rejectStart = undefined
          server.removeListener('error', rejectOnce)
          reject(error)
        }
        rejectStart = rejectOnce
        server.once('error', rejectOnce)
        server.listen(options.localPort ?? 0, '127.0.0.1', resolveOnce)
      })
    } catch (error) {
      this.tunnels.delete(id)
      this.removeClientFailureListener(tunnel)
      try { server.close() } catch { /* never listened */ }
      for (const socket of sockets) {
        try { socket.destroy() } catch { /* already closed */ }
      }
      sockets.clear()
      lease.release()
      throw error
    }

    if (info.state === 'failed') {
      this.tunnels.delete(id)
      this.removeClientFailureListener(tunnel)
      lease.release()
      throw new Error(`SSH connection '${alias}' closed while starting tunnel`)
    }

    const address = server.address()
    info.localPort = typeof address === 'object' && address !== null ? address.port : 0
    info.state = 'forwarding'
    return info
  }

  listTunnels(): TunnelInfo[] {
    return [...this.tunnels.values()].map(tunnel => ({ ...tunnel.info }))
  }

  stopTunnel(id: string): boolean {
    const tunnel = this.tunnels.get(id)
    if (tunnel === undefined) return false
    this.tunnels.delete(id)
    this.removeClientFailureListener(tunnel)
    try { tunnel.server.close() } catch { /* already closed */ }
    for (const socket of tunnel.sockets) {
      try { socket.destroy() } catch { /* already closed */ }
    }
    tunnel.sockets.clear()
    tunnel.lease.release()
    return true
  }

  stopAllTunnels(alias?: string): number {
    let count = 0
    for (const [id, tunnel] of [...this.tunnels]) {
      if (alias === undefined || tunnel.alias === alias) {
        this.stopTunnel(id)
        count += 1
      }
    }
    return count
  }

  dispose(): void {
    this.stopAllTunnels()
  }
}
