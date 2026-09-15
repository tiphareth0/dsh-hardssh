/** Connection-pool cancellation and shared handshake ownership tests (B-10). */

import { EventEmitter } from 'node:events'
import type { Client } from 'ssh2'
import { describe, expect, it, vi } from 'vitest'
import { ConnectionPool } from '../../src/ssh/connection/pool.ts'
import { holdLeaseUntilSettled } from '../../src/ssh/connection/lease.ts'

function fakeClient(): Client {
  const client = new EventEmitter() as EventEmitter & { end: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }
  client.end = vi.fn(() => { client.emit('close') })
  client.destroy = vi.fn(() => { client.emit('close') })
  return client as unknown as Client
}

describe('ConnectionPool cancellation', () => {
  it('aborts the underlying handshake when its final waiter cancels', async () => {
    let connectSignal: AbortSignal | undefined
    const pool = new ConnectionPool({
      idleTimeoutMs: 60_000,
      connect: async (_alias, signal) => {
        connectSignal = signal
        return await new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(Object.assign(new Error('connect aborted'), { name: 'AbortError' })), { once: true })
        })
      },
    })
    const controller = new AbortController()
    const pending = pool.acquire('host', { kind: 'operation', signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(connectSignal?.aborted).toBe(true)
    expect(pool.liveAliases()).toEqual([])
    pool.invalidateAll()
  })

  it('keeps one shared handshake alive when only one of two waiters cancels', async () => {
    const client = fakeClient()
    let connectSignal: AbortSignal | undefined
    let finish!: () => void
    const gate = new Promise<void>(resolve => { finish = resolve })
    const connect = vi.fn(async (_alias: string, signal?: AbortSignal) => {
      connectSignal = signal
      await gate
      return { client, hops: [] }
    })
    const pool = new ConnectionPool({ idleTimeoutMs: 60_000, connect })
    const controller = new AbortController()
    const canceled = pool.acquire('host', { kind: 'operation', signal: controller.signal })
    const retained = pool.acquire('host', { kind: 'operation' })
    controller.abort()
    await expect(canceled).rejects.toMatchObject({ name: 'AbortError' })
    expect(connectSignal?.aborted).toBe(false)
    finish()
    const lease = await retained
    expect(connect).toHaveBeenCalledTimes(1)
    expect(lease.client).toBe(client)
    lease.release()
    pool.invalidateAll()
  })

  it('allows a new active generation while the invalidated generation drains', async () => {
    const clients = [fakeClient(), fakeClient()]
    const connect = vi.fn(async () => ({ client: clients[connect.mock.calls.length - 1]!, hops: [] }))
    const pool = new ConnectionPool({ idleTimeoutMs: 60_000, connect })

    const oldLease = await pool.acquire('host', { kind: 'operation' })
    pool.invalidate('host', { mode: 'drain' })

    const newLease = await pool.acquire('host', { kind: 'operation' })
    expect(connect).toHaveBeenCalledTimes(2)
    expect(newLease.client).toBe(clients[1])
    expect((clients[0] as unknown as { end: ReturnType<typeof vi.fn> }).end).not.toHaveBeenCalled()
    expect(pool.liveAliases()).toEqual(['host'])

    oldLease.release()
    expect((clients[0] as unknown as { end: ReturnType<typeof vi.fn> }).end).toHaveBeenCalledTimes(1)
    expect((clients[1] as unknown as { end: ReturnType<typeof vi.fn> }).end).not.toHaveBeenCalled()
    expect(pool.liveAliases()).toEqual(['host'])

    newLease.release()
    pool.invalidateAll()
  })

  it('exposes a monotonic generation a config change bumps (P1-B cache stamp)', async () => {
    const connect = vi.fn(async () => ({ client: fakeClient(), hops: [] }))
    const pool = new ConnectionPool({ idleTimeoutMs: 60_000, connect })
    expect(pool.generation('host')).toBe(0)
    const lease = await pool.acquire('host', { kind: 'operation' })
    // A pooled connection does not change the generation; only a config change does.
    expect(pool.generation('host')).toBe(0)
    pool.invalidate('host', { mode: 'drain' })
    expect(pool.generation('host')).toBe(1)
    expect(lease.generation).toBe(0)
    lease.release()
    pool.invalidateAll()
  })
})

describe('ConnectionPool lease visibility', () => {
  it('reports whether a lease is the only holder (P1-1 blast-radius guard)', async () => {
    const client = fakeClient()
    const pool = new ConnectionPool({ idleTimeoutMs: 60_000, connect: async () => ({ client, hops: [] }) })

    const first = await pool.acquire('host', { kind: 'operation' })
    expect(first.holdsOnlyLease()).toBe(true)

    const second = await pool.acquire('host', { kind: 'operation' })
    // Cancelling either one must not retire the transport while the other lives.
    expect(first.holdsOnlyLease()).toBe(false)
    expect(second.holdsOnlyLease()).toBe(false)

    first.release()
    expect(second.holdsOnlyLease()).toBe(true)
    second.release()
    pool.invalidateAll()
  })

  it('keeps a lease held until the OPERATION settles, not until the caller stops waiting', async () => {
    // The abort regression: the caller's promise rejects immediately, but an
    // SFTP request has no cancel API and keeps running. Releasing at rejection
    // time made holdsOnlyLease() report "nobody else is using this connection",
    // so a later abort in another session closed the transport under it.
    const client = fakeClient()
    const pool = new ConnectionPool({ idleTimeoutMs: 60_000, connect: async () => ({ client, hops: [] }) })
    const lease = await pool.acquire('host', { kind: 'operation' })
    const other = await pool.acquire('host', { kind: 'operation' })

    let settleOperation!: () => void
    const operation = new Promise<void>((resolve) => { settleOperation = resolve })
    const tracked = holdLeaseUntilSettled(lease, operation)
    // The caller walks away (abort) without the operation having finished.
    await Promise.resolve()
    expect(lease.holdsOnlyLease()).toBe(false)
    expect(other.holdsOnlyLease()).toBe(false)

    settleOperation()
    await tracked
    // Only now is the lease gone, so a concurrent abort sees the truth.
    expect(other.holdsOnlyLease()).toBe(true)
    other.release()
    pool.invalidateAll()
  })
})

/**
 * P1-4: session-scoped credentials are tied to the pooled connection's
 * lifetime, so retiring a transport must report the alias back to its owner.
 */
describe('ConnectionPool retirement notification', () => {
  it('reports the alias once per retired transport (drain, force, shutdown)', async () => {
    const clients = [fakeClient(), fakeClient(), fakeClient()]
    const connect = vi.fn(async () => ({ client: clients[connect.mock.calls.length - 1]!, hops: [] }))
    const onRetire = vi.fn()
    const pool = new ConnectionPool({ idleTimeoutMs: 60_000, connect, onRetire })

    // Drain: the retire lands when the final lease releases.
    const lease = await pool.acquire('drain-host', { kind: 'operation' })
    pool.invalidate('drain-host', { mode: 'drain' })
    expect(onRetire).not.toHaveBeenCalled()
    lease.release()
    expect(onRetire).toHaveBeenCalledTimes(1)
    expect(onRetire).toHaveBeenCalledWith('drain-host')

    // Force: immediate retirement.
    await pool.acquire('force-host', { kind: 'operation' })
    pool.invalidate('force-host', { mode: 'force' })
    expect(onRetire).toHaveBeenCalledTimes(2)
    expect(onRetire).toHaveBeenLastCalledWith('force-host')

    // Shutdown retires whatever is left, exactly once each.
    await pool.acquire('shutdown-host', { kind: 'operation' })
    pool.invalidateAll()
    expect(onRetire).toHaveBeenCalledTimes(3)
    expect(onRetire).toHaveBeenLastCalledWith('shutdown-host')
  })

  it('reports retirement for an alias with no live transport (its secret is still dead)', async () => {
    // `invalidate` used to return early when the alias had no pooled record, so
    // a disconnected alias kept its session password for the whole process.
    const onRetire = vi.fn()
    const pool = new ConnectionPool({
      idleTimeoutMs: 60_000,
      connect: async () => ({ client: fakeClient(), hops: [] }),
      onRetire,
    })
    onRetire.mockClear()
    pool.invalidate('never-connected')
    expect(onRetire).toHaveBeenCalledWith('never-connected')
    pool.invalidateAll()
  })
})
