/**
 * Engine integration tests against the embedded ssh2 test server:
 * exec (success/exit codes/stderr/timeout), connection pooling and
 * reconnect, key auth, cluster, PTY shell, local-port-forward tunnel,
 * SFTP upload/download/ls, and the connection probe.
 */

import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect, createServer, type AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { SshEngine, buildConnectConfig, sshAgentConfig, NeedsPasswordError } from '../../src/ssh/engine.ts'
import { HostStore } from '../../src/ssh/store.ts'
import type { HostPayload } from '../../src/ssh/protocol.ts'
import { TEST_PASSWORD, TEST_USER, TestSshServer } from './helpers/ssh-server.ts'
import { KnownHostsStore } from '../../src/ssh/known-hosts.ts'
import { HostKeyMismatchError, HostKeyUnknownError } from '../../src/ssh/known-hosts.ts'
import { TestSshd } from './helpers/sshd.ts'

let server: TestSshServer
let store: HostStore
let engine: SshEngine
const dir = mkdtempSync(join(tmpdir(), 'dsh-ssh-engine-'))

function addHost(alias: string, overrides: Partial<HostPayload> = {}): void {
  store.create({
    alias,
    host: '127.0.0.1',
    port: server.port,
    user: TEST_USER,
    auth: { kind: 'password', password: TEST_PASSWORD },
    ...overrides,
  } as HostPayload)
}

beforeAll(async () => {
  server = await TestSshServer.start()
  store = new HostStore(join(dir, 'hosts.json'))
  engine = new SshEngine(store, { idleTimeoutMs: 60_000, connectTimeoutMs: 5_000, defaultExecTimeoutMs: 5_000 })
})

afterAll(async () => {
  engine.dispose()
  await server.stop()
  rmSync(dir, { recursive: true, force: true })
})

describe('exec', () => {
  it('runs a command and captures stdout', async () => {
    addHost('exec-ok')
    const result = await engine.exec('exec-ok', 'echo hello')
    expect(result.success).toBe(true)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('hello')
    expect(result.durationMs).toBeGreaterThan(0)
  })

  it('reports remote exit codes as failures', async () => {
    addHost('exec-code')
    const result = await engine.exec('exec-code', 'exit 7')
    expect(result.success).toBe(false)
    expect(result.exitCode).toBe(7)
  })

  it('captures stderr separately', async () => {
    addHost('exec-err')
    const result = await engine.exec('exec-err', 'out-and-err')
    expect(result.stdout).toContain('hello out')
    expect(result.stderr).toContain('hello err')
  })

  it('times out and reports timedOut', async () => {
    addHost('exec-timeout')
    const started = Date.now()
    const result = await engine.exec('exec-timeout', 'hang', 400)
    expect(result.timedOut).toBe(true)
    expect(result.success).toBe(false)
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('fails cleanly for unknown aliases', async () => {
    await expect(engine.exec('nope', 'true')).rejects.toThrow(/not found/)
  })

  it('fails cleanly on authentication errors', async () => {
    addHost('exec-badauth', { auth: { kind: 'password', password: 'wrong' } })
    await expect(engine.exec('exec-badauth', 'true')).rejects.toThrow(/authentication/i)
  })
})

describe('connection pool', () => {
  it('reuses one connection across execs', async () => {
    addHost('pool-reuse')
    const before = server.connectCount
    await engine.exec('pool-reuse', 'true')
    await engine.exec('pool-reuse', 'echo hello')
    expect(server.connectCount).toBe(before + 1)
  })

  it('exposes live aliases and drops them after invalidation', async () => {
    addHost('conn-state')
    await engine.exec('conn-state', 'echo hello')
    expect(engine.connectedAliases()).toContain('conn-state')
    engine.connections.invalidate('conn-state', { mode: 'force' })
    expect(engine.connectedAliases()).not.toContain('conn-state')
  })

  it('reconnects after the server drops the connection', async () => {
    addHost('pool-reconnect')
    await engine.exec('pool-reconnect', 'true')
    const before = server.connectCount
    server.killAllClients()
    await new Promise(resolve => setTimeout(resolve, 150))
    const result = await engine.exec('pool-reconnect', 'echo hello')
    expect(result.success).toBe(true)
    expect(server.connectCount).toBe(before + 1)
  })
})

describe('needs-password gate (deps.resolveSecrets path)', () => {
  const gateDir = mkdtempSync(join(tmpdir(), 'dsh-ssh-gate-'))
  let gateEngine: SshEngine
  let gateStore: HostStore

  beforeAll(() => {
    gateStore = new HostStore(join(gateDir, 'hosts.json'))
    // Mirrors the deployed SecureHostStore in 'none' mode: a password-kind
    // host whose secret was stripped resolves to an empty credential.
    gateEngine = new SshEngine(
      gateStore,
      { idleTimeoutMs: 60_000, connectTimeoutMs: 5_000, defaultExecTimeoutMs: 5_000 },
      {
        resolveSecrets: async (entry) => ({
          kind: entry.auth.kind,
          keyPath: entry.auth.keyPath,
          password: undefined,
          passphrase: undefined,
        }),
      },
    )
  })

  afterAll(() => {
    gateEngine.dispose()
    rmSync(gateDir, { recursive: true, force: true })
  })

  it('throws NeedsPasswordError when resolveSecrets yields no password', async () => {
    gateStore.create({
      alias: 'gate-pw',
      host: '127.0.0.1',
      port: server.port,
      user: TEST_USER,
      auth: { kind: 'password', password: 'ignored-inline' },
    } as HostPayload)
    await expect(gateEngine.exec('gate-pw', 'echo hello')).rejects.toBeInstanceOf(NeedsPasswordError)
  })

  it('connects once the session password is provided', async () => {
    gateEngine.setSessionPassword('gate-pw', { password: TEST_PASSWORD })
    const result = await gateEngine.exec('gate-pw', 'echo hello')
    expect(result.success).toBe(true)
  })

  it('throws NeedsPasswordError for an encrypted key without a passphrase', async () => {
    const keyFile = join(gateDir, 'encrypted.key')
    const blob = Buffer.from('openssh-key-v1\x00ciphername\x00bcrypt\x00kdf\x00kdfoptions\x00rest...').toString('base64')
    writeFileSync(keyFile, `-----BEGIN OPENSSH PRIVATE KEY-----\n${blob}\n-----END OPENSSH PRIVATE KEY-----\n`, 'utf8')
    gateStore.create({
      alias: 'gate-enc-key',
      host: '127.0.0.1',
      port: server.port,
      user: TEST_USER,
      auth: { kind: 'key', keyPath: keyFile },
    } as HostPayload)
    await expect(gateEngine.exec('gate-enc-key', 'echo hello')).rejects.toBeInstanceOf(NeedsPasswordError)
  })

  it('does not gate a plain key (parse failure surfaces later, not needs-passphrase)', async () => {
    const keyFile = join(gateDir, 'plain.key')
    const blob = Buffer.from('openssh-key-v1\x00none\x00none\x00\x00rest...').toString('base64')
    writeFileSync(keyFile, `-----BEGIN OPENSSH PRIVATE KEY-----\n${blob}\n-----END OPENSSH PRIVATE KEY-----\n`, 'utf8')
    gateStore.create({
      alias: 'gate-plain-key',
      host: '127.0.0.1',
      port: server.port,
      user: TEST_USER,
      auth: { kind: 'key', keyPath: keyFile },
    } as HostPayload)
    await expect(gateEngine.exec('gate-plain-key', 'echo hello')).rejects.not.toBeInstanceOf(NeedsPasswordError)
  })
})

describe('key auth', () => {
  it('connects with a generated private key', async () => {
    addHost('key-auth', { auth: { kind: 'key', keyPath: server.keyPair.privateKey } })
    const result = await engine.exec('key-auth', 'echo hello')
    expect(result.success).toBe(true)
    expect(result.stdout).toContain('hello')
  })
})

describe('retry policy (P0-07)', () => {
  it('retries connection acquisition but runs the command exactly once', async () => {
    server.execRequests = []
    addHost('p0-07-acquire')
    server.failNextConnections(1)
    const result = await engine.exec('p0-07-acquire', 'printf once')
    expect(result.success).toBe(true)
    expect(result.stdout).toBe('once\n')
    expect(server.execRequests.filter(command => command === 'printf once')).toHaveLength(1)
  })

  it('never replays a command once the server accepted it (connect-only)', async () => {
    server.execRequests = []
    addHost('p0-07-replay')
    // replay-probe: the server records the command, then kills the transport.
    await engine.exec('p0-07-replay', 'replay-probe').catch(() => undefined)
    expect(server.execRequests.filter(command => command === 'replay-probe')).toHaveLength(1)
    // The broken connection is retired; the next independent exec reconnects.
    const next = await engine.exec('p0-07-replay', 'printf once')
    expect(next.success).toBe(true)
  })

  it('idempotent retry still never replays after the channel was accepted', async () => {
    server.execRequests = []
    addHost('p0-07-idem')
    await engine.exec('p0-07-idem', 'replay-probe', { retry: 'idempotent' }).catch(() => undefined)
    expect(server.execRequests.filter(command => command === 'replay-probe')).toHaveLength(1)
  })

  it('never retries at all under retry: never', async () => {
    server.execRequests = []
    addHost('p0-07-never')
    server.failNextConnections(1)
    await expect(engine.exec('p0-07-never', 'printf once', { retry: 'never' })).rejects.toThrow()
    expect(server.execRequests.filter(command => command === 'printf once')).toHaveLength(0)
  })
})

describe('cluster', () => {
  it('runs one command on every matched host concurrently', async () => {
    addHost('cluster-a')
    addHost('cluster-b')
    addHost('cluster-c', { environment: 'staging' })
    // The store accumulates hosts from every test; scope by explicit aliases.
    const aliases = ['cluster-a', 'cluster-b', 'cluster-c']
    const results = await engine.cluster({ command: 'echo hello', aliases })
    expect(results).toHaveLength(3)
    for (const result of results) {
      expect(result.ok).toBe(true)
      expect(result.stdout).toContain('hello')
    }
    const scoped = await engine.cluster({ command: 'true', aliases: ['cluster-a'] })
    expect(scoped).toHaveLength(1)
    expect(scoped[0]?.alias).toBe('cluster-a')
    const staging = await engine.cluster({ command: 'true', aliases, environment: 'staging' })
    expect(staging).toHaveLength(1)
    expect(staging[0]?.alias).toBe('cluster-c')
    const none = await engine.cluster({ command: 'true', aliases, environment: 'production' })
    expect(none).toHaveLength(0)
  })

  it('keeps the result order aligned with the requested aliases', async () => {
    // The store insertion order is cluster-a/b/c; requesting them in reverse
    // must yield results in the REQUESTED order, not the store/completion
    // order (results are written into pre-sized slots by index).
    const reversed = ['cluster-c', 'cluster-b', 'cluster-a']
    const results = await engine.cluster({ command: 'echo hello', aliases: reversed })
    expect(results.map(result => result.alias)).toEqual(reversed)
  })
})

describe('shell', () => {
  it('opens a PTY, echoes input, resizes, and exits', async () => {
    addHost('shell-host')
    const session = await engine.openShell('shell-host', { cols: 80, rows: 24 })
    const outputs: string[] = []
    let exited = false
    session.onData = (data) => outputs.push(data.toString('utf8'))
    session.onExit = () => { exited = true }
    await new Promise(resolve => setTimeout(resolve, 200))
    // Bidirectional flow: input written to the shell is echoed back.
    session.send('ping\r')
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(outputs.join('')).toContain('ping')
    session.resize(100, 30)
    await new Promise(resolve => setTimeout(resolve, 100))
    session.close()
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(exited).toBe(true)
  })
})

describe('tunnel', () => {
  it('forwards a local port to the remote echo server', async () => {
    addHost('tunnel-host')
    const tunnel = await engine.startTunnel('tunnel-host', { remotePort: server.echoPort })
    expect(tunnel.localPort).toBeGreaterThan(0)
    expect(engine.listTunnels()).toHaveLength(1)
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = connect(tunnel.localPort, '127.0.0.1')
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('tunnel echo timed out')) }, 3_000)
      socket.on('connect', () => socket.write('ping-through-tunnel'))
      socket.on('data', (chunk: Buffer) => {
        clearTimeout(timer)
        socket.destroy()
        resolve(chunk.toString('utf8'))
      })
      socket.on('error', (error) => { clearTimeout(timer); reject(error) })
    })
    expect(reply).toBe('ping-through-tunnel')
    expect(engine.stopTunnel(tunnel.id)).toBe(true)
    expect(engine.listTunnels()).toHaveLength(0)
  })

  it('marks tunnels failed when the transport dies and stop stays idempotent (P0-08)', async () => {
    addHost('p0-08-fail')
    const info = await engine.startTunnel('p0-08-fail', { remotePort: server.echoPort })
    expect(info.state).toBe('forwarding')
    server.killAllClients()
    // Let the client 'close' propagate to the failure handler.
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(engine.listTunnels().find(tunnel => tunnel.id === info.id)?.state).toBe('failed')
    expect(engine.stopTunnel(info.id)).toBe(true)
    expect(engine.stopTunnel(info.id)).toBe(false)
    expect(engine.listTunnels()).toHaveLength(0)
  })
})

describe('sftp (real sshd)', () => {
  it('uploads, lists, and downloads files', async () => {
    const sshd = await TestSshd.start()
    try {
      store.create({
        alias: 'sftp-real',
        host: '127.0.0.1',
        port: sshd.port,
        user: process.env.USER ?? 'root',
        auth: { kind: 'key', keyPath: sshd.clientKey },
      })
      const remoteDir = join(sshd.root, 'up')
      const local = join(sshd.root, 'payload.txt')
      const content = 'sftp roundtrip payload ' + Math.random()
      writeFileSync(local, content, 'utf8')

      const uploaded = await engine.upload('sftp-real', local, join(remoteDir, 'payload.txt'), false)
      expect(uploaded.bytes).toBe(content.length)

      const listing = await engine.ls('sftp-real', remoteDir)
      expect(listing.some(entry => entry.name === 'payload.txt' && entry.type === 'file')).toBe(true)

      const downloaded = await engine.download('sftp-real', join(remoteDir, 'payload.txt'), join(sshd.root, 'out.txt'))
      expect(downloaded.bytes).toBe(content.length)
      expect(readFileSync(join(sshd.root, 'out.txt'), 'utf8')).toBe(content)
    } finally {
      sshd.stop()
    }
  })

  it('readFile / writeFile round-trip with mtime conflict detection', async () => {
    const sshd = await TestSshd.start()
    try {
      store.create({
        alias: 'sftp-files',
        host: '127.0.0.1',
        port: sshd.port,
        user: process.env.USER ?? 'root',
        auth: { kind: 'key', keyPath: sshd.clientKey },
      })
      const path = join(sshd.root, 'ws', 'notes.txt')
      const written = await engine.writeFile('sftp-files', path, Buffer.from('first', 'utf8'))
      expect(written.mtime).toBeGreaterThan(0)

      const read = await engine.readFile('sftp-files', path)
      expect(read.content.toString('utf8')).toBe('first')
      expect(read.size).toBe(5)

      // A stale expected mtime must be rejected before any byte is written.
      await expect(engine.writeFile('sftp-files', path, Buffer.from('second', 'utf8'), written.mtime - 1000))
        .rejects.toThrow(/mtime conflict/)

      const fresh = await engine.writeFile('sftp-files', path, Buffer.from('second', 'utf8'), written.mtime)
      expect(fresh.mtime).toBeGreaterThan(0)
      expect((await engine.readFile('sftp-files', path)).content.toString('utf8')).toBe('second')

      const stats = await engine.stat('sftp-files', path)
      expect(stats.type).toBe('file')
    } finally {
      sshd.stop()
    }
  })

  it('mkdir / rename / rm handle files and recursive directories', async () => {
    const sshd = await TestSshd.start()
    try {
      store.create({
        alias: 'sftp-tree',
        host: '127.0.0.1',
        port: sshd.port,
        user: process.env.USER ?? 'root',
        auth: { kind: 'key', keyPath: sshd.clientKey },
      })
      const base = join(sshd.root, 'tree')
      await engine.mkdir('sftp-tree', join(base, 'a', 'b'))
      await engine.writeFile('sftp-tree', join(base, 'a', 'b', 'x.txt'), Buffer.from('x', 'utf8'))

      await engine.rename('sftp-tree', join(base, 'a', 'b', 'x.txt'), join(base, 'a', 'b', 'y.txt'))
      expect((await engine.readFile('sftp-tree', join(base, 'a', 'b', 'y.txt'))).content.toString('utf8')).toBe('x')

      // Removing a non-empty directory without recursive must fail.
      await expect(engine.rm('sftp-tree', join(base, 'a'), false)).rejects.toThrow(/recursive/)
      await engine.rm('sftp-tree', join(base, 'a'), true)
      await expect(engine.stat('sftp-tree', join(base, 'a'))).rejects.toThrow()
    } finally {
      sshd.stop()
    }
  })
})


describe('cluster filters', () => {
  it('matches hosts carrying ALL requested tags', async () => {
    addHost('tag-web', { tags: ['web'] })
    addHost('tag-both', { tags: ['web', 'staging'] })
    addHost('tag-staging', { tags: ['staging'] })
    const results = await engine.cluster({ command: 'true', tags: ['web', 'staging'] })
    expect(results.map(r => r.alias)).toEqual(['tag-both'])
  })

  it('rejects invalid maxWorkers', async () => {
    await expect(engine.cluster({ command: 'true', maxWorkers: 0 })).rejects.toThrow(/maxWorkers/)
    await expect(engine.cluster({ command: 'true', maxWorkers: -2 })).rejects.toThrow(/maxWorkers/)
  })
})

describe('tunnel safety', () => {
  it('rejects out-of-range ports', async () => {
    addHost('tun-port')
    await expect(engine.startTunnel('tun-port', { remotePort: 0 })).rejects.toThrow(/remotePort/)
    await expect(engine.startTunnel('tun-port', { remotePort: 70_000 })).rejects.toThrow(/remotePort/)
    await expect(engine.startTunnel('tun-port', { remotePort: 22, localPort: 0 })).rejects.toThrow(/localPort/)
  })

  it('rolls back the connection when the local port is taken', async () => {
    addHost('tun-conflict')
    const blocker = createServer(() => undefined)
    await new Promise<void>((resolve) => { blocker.listen(0, '127.0.0.1', resolve) })
    const takenPort = (blocker.address() as AddressInfo).port
    await expect(
      engine.startTunnel('tun-conflict', { remotePort: server.echoPort, localPort: takenPort }),
    ).rejects.toThrow()
    expect(engine.listTunnels()).toHaveLength(0)
    // The failed tunnel must not pin a leaked connection: exec still works.
    const result = await engine.exec('tun-conflict', 'true')
    expect(result.success).toBe(true)
    await new Promise<void>((resolve) => { blocker.close(() => resolve()) })
  })

  it('stops tunnels scoped by alias', async () => {
    addHost('tun-a')
    addHost('tun-b')
    const a = await engine.startTunnel('tun-a', { remotePort: server.echoPort })
    const b = await engine.startTunnel('tun-b', { remotePort: server.echoPort })
    const stopped = engine.stopAllTunnels('tun-a')
    expect(stopped).toBe(1)
    expect(engine.listTunnels().map(t => t.id)).toEqual([b.id])
    expect(engine.stopTunnel(b.id)).toBe(true)
    expect(engine.listTunnels()).toHaveLength(0)
  })
})

describe('shell isolation', () => {
  it('shell sessions use their own connection and never disturb pooled execs', async () => {
    addHost('shell-iso')
    await engine.exec('shell-iso', 'true')
    const before = server.connectCount
    const session = await engine.openShell('shell-iso', { cols: 80, rows: 24 })
    // Opening the shell must not reuse the pooled connection.
    expect(server.connectCount).toBe(before + 1)
    session.close()
    await new Promise(resolve => setTimeout(resolve, 300))
    const result = await engine.exec('shell-iso', 'echo hello')
    expect(result.success).toBe(true)
    expect(result.stdout).toContain('hello')
    // The exec reused the ORIGINAL pooled connection (no new connect).
    expect(server.connectCount).toBe(before + 1)
  })
})

describe('sweep safety', () => {
  it('does not sweep an in-flight exec past the idle timeout', async () => {
    addHost('sweep-exec')
    const engine2 = new SshEngine(store, { idleTimeoutMs: 300, defaultExecTimeoutMs: 2_000 })
    try {
      let resolved = false
      const pending = engine2.exec('sweep-exec', 'hang', 1_500).then(result => {
        resolved = true
        return result
      })
      await new Promise(resolve => setTimeout(resolve, 800))
      // Still running well past the idle timeout: the sweep must not kill it.
      expect(resolved).toBe(false)
      const result = await pending
      expect(result.timedOut).toBe(true)
    } finally {
      engine2.dispose()
    }
  })
})

describe('upload path rules', () => {
  it('rejects relative remote paths', async () => {
    addHost('rel-path')
    await expect(
      engine.upload('rel-path', join(process.cwd(), 'package.json'), 'relative/dir/file.txt', false),
    ).rejects.toThrow(/absolute/)
  })
})

describe('probe', () => {
  it('reports a working connection', async () => {
    addHost('probe-host')
    const result = await engine.test('probe-host')
    expect(result.ok).toBe(true)
    expect(result.latencyMs).toBeGreaterThan(0)
  })

  it('reports failures', async () => {
    addHost('probe-bad', { auth: { kind: 'password', password: 'nope' } })
    const result = await engine.test('probe-bad')
    expect(result.ok).toBe(false)
    expect(result.error).toBeDefined()
  })
})

describe('proxyJump cycle guard', () => {
  it('rejects a hand-edited cyclic chain before connecting', async () => {
    // The store guards create/update, but the JSON file can be hand-edited:
    // connectChain must detect the loop before opening any connection.
    addHost('cyc-a', { proxyJump: ['cyc-b'] })
    const file = JSON.parse(readFileSync(store.path, 'utf8')) as { hosts: Array<Record<string, unknown>> }
    file.hosts.push({
      alias: 'cyc-b',
      host: '127.0.0.1',
      port: server.port,
      user: TEST_USER,
      auth: { kind: 'password', password: TEST_PASSWORD },
      proxyJump: ['cyc-a'],
      createdAt: 0,
      updatedAt: 0,
    })
    writeFileSync(store.path, JSON.stringify(file, null, 2) + '\n', 'utf8')
    await expect(engine.exec('cyc-a', 'true')).rejects.toThrow(/cycle/)
  })
})

describe('host-key TOFU (Phase A)', () => {
  const tofuDir = mkdtempSync(join(tmpdir(), 'dsh-ssh-tofu-'))
  let khStore: KnownHostsStore
  let tofuEngine: SshEngine
  let tofuStore: HostStore

  function addTofuHost(alias: string): void {
    tofuStore.create({
      alias,
      host: '127.0.0.1',
      port: server.port,
      user: TEST_USER,
      auth: { kind: 'password', password: TEST_PASSWORD },
    } as HostPayload)
  }

  beforeAll(() => {
    khStore = new KnownHostsStore(join(tofuDir, 'known.json'))
    tofuStore = new HostStore(join(tofuDir, 'hosts.json'))
    tofuEngine = new SshEngine(tofuStore, { idleTimeoutMs: 60_000, connectTimeoutMs: 5_000, defaultExecTimeoutMs: 5_000 }, { knownHosts: khStore })
  })

  afterAll(() => {
    tofuEngine.dispose()
    rmSync(tofuDir, { recursive: true, force: true })
  })

  it('refuses an unknown host with a typed error and records pending, then connects after trust', async () => {
    addTofuHost('tofu-1')
    // First connect: host key unknown 鈫?refused with fingerprint; no credential sent.
    await expect(tofuEngine.exec('tofu-1', 'echo hello')).rejects.toBeInstanceOf(HostKeyUnknownError)
    const record = khStore.lookup('tofu-1')
    expect(record?.status).toBe('pending')
    expect(record?.fingerprint).toMatch(/^SHA256:/)

    // Trust via the store, then connect succeeds.
    khStore.trust('tofu-1')
    const result = await tofuEngine.exec('tofu-1', 'echo hello')
    expect(result.success).toBe(true)
  })

  it('rejects a changed fingerprint (mismatch)', async () => {
    addTofuHost('tofu-2')
    await expect(tofuEngine.exec('tofu-2', 'echo hello')).rejects.toBeInstanceOf(HostKeyUnknownError)
    khStore.trust('tofu-2')
    await tofuEngine.exec('tofu-2', 'echo hello')
    // Tamper the stored fingerprint -> mismatch. Invalidate the pooled
    // connection so the next connect re-runs the hostVerifier against the
    // (now wrong) stored fingerprint.
    const record = khStore.lookup('tofu-2')
    if (record !== undefined) record.fingerprint = 'SHA256:' + 'a'.repeat(43)
    tofuEngine.connections.invalidate('tofu-2', { mode: 'force' })
    await expect(tofuEngine.exec('tofu-2', 'echo hello')).rejects.toBeInstanceOf(HostKeyMismatchError)
  })

  it('re-trusts after forget (key rotation path)', async () => {
    addTofuHost('tofu-3')
    await expect(tofuEngine.exec('tofu-3', 'echo hello')).rejects.toBeInstanceOf(HostKeyUnknownError)
    khStore.trust('tofu-3')
    await tofuEngine.exec('tofu-3', 'echo hello')
    khStore.forget('tofu-3')
    tofuEngine.connections.invalidate('tofu-3', { mode: 'force' })
    await expect(tofuEngine.exec('tofu-3', 'echo hello')).rejects.toBeInstanceOf(HostKeyUnknownError)
    khStore.observe('tofu-3', { host: '127.0.0.1', port: server.port, keyType: 'ssh-ed25519', fingerprintSha256: server.hostKeyFingerprintSha256 })
    khStore.trust('tofu-3')
    const result = await tofuEngine.exec('tofu-3', 'echo hello')
    expect(result.success).toBe(true)
  })

  it('test() rethrows host-key errors instead of flattening them (GUI dialogs)', async () => {
    addTofuHost('tofu-probe')
    await expect(tofuEngine.test('tofu-probe')).rejects.toBeInstanceOf(HostKeyUnknownError)
  })
})

describe('session password table (VSCode-style, memory-only)', () => {
  it('holds a password for the session and wipes it on dispose', () => {
    const localStore = new HostStore(join(dir, 'session-hosts.json'))
    const localEngine = new SshEngine(localStore, {})
    try {
      localEngine.setSessionPassword('sess', { password: 'tmp-secret' })
      expect(localEngine.getSessionPassword('sess')).toMatchObject({ password: 'tmp-secret' })
      localEngine.dispose()
      expect(localEngine.getSessionPassword('sess')).toBeUndefined()
    } finally {
      localEngine.dispose()
    }
  })
})

describe('key/agent auth config (buildConnectConfig)', () => {
  const opts = { connectTimeoutMs: 5000, keepaliveIntervalMs: 0 }
  const savedSock = process.env.SSH_AUTH_SOCK

  function entryWith(auth: { kind: 'key'; keyPath?: string }): Parameters<typeof buildConnectConfig>[0] {
    return {
      alias: 'agent-test',
      host: '127.0.0.1',
      port: 22,
      user: 'u',
      auth: { kind: 'key' as const, keyPath: auth.keyPath },
      proxyJump: [],
      tags: [],
      createdAt: 0,
      updatedAt: 0,
    }
  }

  afterEach(() => {
    if (savedSock === undefined) delete process.env.SSH_AUTH_SOCK
    else process.env.SSH_AUTH_SOCK = savedSock
  })

  it('sshAgentConfig prefers SSH_AUTH_SOCK when set', () => {
    process.env.SSH_AUTH_SOCK = '/tmp/agent.sock'
    expect(sshAgentConfig()).toBe('/tmp/agent.sock')
  })

  it('sshAgentConfig returns undefined without a socket (any platform)', () => {
    delete process.env.SSH_AUTH_SOCK
    expect(sshAgentConfig()).toBeUndefined()
  })

  it('key host with a path reads the key and still offers the agent', () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'dsh-ssh-agent-'))
    const keyFile = join(dir2, 'id_test')
    writeFileSync(keyFile, 'PRIVATE KEY MATERIAL', 'utf8')
    process.env.SSH_AUTH_SOCK = '/tmp/agent.sock'
    const config = buildConnectConfig(entryWith({ kind: 'key', keyPath: keyFile }), opts)
    expect(config.privateKey).toBe('PRIVATE KEY MATERIAL')
    expect(config.agent).toBe('/tmp/agent.sock')
    rmSync(dir2, { recursive: true, force: true })
  })

  it('key host without a key path relies on the agent (no throw, zero input)', () => {
    process.env.SSH_AUTH_SOCK = '/tmp/agent.sock'
    const config = buildConnectConfig(entryWith({ kind: 'key' }), opts)
    expect(config.privateKey).toBeUndefined()
    expect(config.agent).toBe('/tmp/agent.sock')
  })

  it('key host without a path and without an agent throws a precise error', () => {
    delete process.env.SSH_AUTH_SOCK
    expect(() => buildConnectConfig(entryWith({ kind: 'key' }), opts)).toThrow(/private key not found/)
  })
})
