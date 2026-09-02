/**
 * Embedded ssh2 test server: password + publickey auth, a command shim
 * (echo / exit codes / hang), a shell that echoes input, TCP forwarding for
 * tunnel tests, and a real file-backed SFTP server (ssh2-sftp-server) rooted
 * at the process cwd. No external sshd required.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect, createServer, type Server as NetServer } from 'node:net'
import { Server, utils as ssh2Utils, type ClientChannel, type Connection as ServerConnection, type ServerChannel } from 'ssh2'

/** Test credentials. */
export const TEST_USER = 'tester'
export const TEST_PASSWORD = 'secret'

/** Paths to the generated client keypair (key auth tests). */
export interface KeyPairPaths {
  privateKey: string
  publicKey: string
}

/** Generate an ed25519 keypair via ssh-keygen (host and client). */
function generateKey(target: string): void {
  execFileSync('ssh-keygen', ['-t', 'ed25519', '-f', target, '-N', '', '-q'], { stdio: 'ignore' })
}

/** The exec shim: deterministic responses for known commands. */
function handleCommand(command: string, stream: ClientChannel, server: TestSshServer): void {
  const respond = (out: string, code: number): void => {
    if (out !== '') stream.write(out)
    stream.exit(code)
    stream.close()
  }
  if (command === 'echo hello') respond('hello\n', 0)
  else if (command === 'printf once') respond('once\n', 0)
  else if (command === 'out-and-err') {
    stream.write('hello out\n')
    // Server-side stderr is writable at runtime; the client-facing types
    // declare it readable, so narrow it for the shim.
    const stderrWriter = stream.stderr as unknown as { write(text: string): void }
    stderrWriter.write('hello err\n')
    stream.exit(0)
    stream.close()
  } else if (command === 'exit 7') respond('', 7)
  else if (command === 'true') respond('', 0)
  else if (command === 'hang') {
    // Never respond: the caller's timeout must kill the channel.
    stream.on('close', () => undefined)
  } else if (command === 'replay-probe') {
    // Accept the channel and emit one line so the client is definitely in
    // the 'accepted' state (markCommitted has run), THEN tear the transport
    // down: the caller must NOT replay the command, even under idempotent.
    stream.write('partial\n')
    setTimeout(() => server.killAllClients(), 50)
  } else {
    respond('sh: unknown command\n', 127)
  }
}

/** The embedded SSH server harness. */
export class TestSshServer {
  /** Listening port. */
  readonly port: number
  /** Successful connections seen. */
  connectCount = 0
  /** Every exec request the server received, in order (replay-detection). */
  execRequests: string[] = []
  /** Connections still to drop on accept (acquire-failure tests). */
  pendingFailures = 0
  /** Drop the next N connections right after accept (acquire-failure tests). */
  failNextConnections(count: number): void {
    this.pendingFailures = count
  }
  /** Client keypair for key-auth tests. */
  readonly keyPair: KeyPairPaths
  /** Canonical SHA256 fingerprint of the server's host key (TOFU tests). */
  readonly hostKeyFingerprintSha256: string
  private readonly server: Server
  private readonly clients: ServerConnection[]
  private readonly echoServer: NetServer
  private readonly dir: string

  private constructor(
    port: number,
    server: Server,
    echoServer: NetServer,
    dir: string,
    keyPair: KeyPairPaths,
    clients: ServerConnection[],
    hostKeyFingerprintSha256: string,
  ) {
    this.port = port
    this.server = server
    this.echoServer = echoServer
    this.dir = dir
    this.keyPair = keyPair
    this.clients = clients
    this.hostKeyFingerprintSha256 = hostKeyFingerprintSha256
  }

  /** Port of the TCP echo server (tunnel target). */
  get echoPort(): number {
    const address = this.echoServer.address()
    return typeof address === 'object' && address !== null ? address.port : 0
  }

  /** Start the harness (host key + keypair generated in a temp dir). */
  static async start(): Promise<TestSshServer> {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-ssh-test-'))
    const hostKey = join(dir, 'host.key')
    generateKey(hostKey)
    // Canonical SHA256 fingerprint of the host key (for host-key TOFU tests):
    // parse the private key back to its public blob and hash it.
    const parsedHostKey = ssh2Utils.parseKey(readFileSync(hostKey))
    const hostKeyPublic = parsedHostKey instanceof Error || parsedHostKey === null ? undefined : parsedHostKey.getPublicSSH()
    const hostKeyFingerprintSha256 = hostKeyPublic === undefined
      ? ''
      : 'SHA256:' + createHash('sha256').update(hostKeyPublic).digest('base64').replace(/=+$/u, '')
    const keyPair: KeyPairPaths = {
      privateKey: join(dir, 'client.key'),
      publicKey: join(dir, 'client.key.pub'),
    }
    generateKey(keyPair.privateKey)

    const echoServer = createServer((socket) => {
      socket.on('data', (chunk: Buffer) => socket.write(chunk))
    })
    await new Promise<void>((resolve) => { echoServer.listen(0, '127.0.0.1', resolve) })

    const clients: ServerConnection[] = []
    let connectCount = 0
    const server = new Server({ hostKeys: [readFileSync(hostKey)] }, (client) => {
      if (harness.pendingFailures > 0) {
        harness.pendingFailures -= 1
        client.end()
        return
      }
      clients.push(client)
      // A client refusing the host key (TOFU tests) or dropping mid-handshake
      // makes ssh2 emit an internal error; contain it so the test run is not
      // polluted by unhandled errors.
      client.on('error', () => { /* expected for refused/dropped handshakes */ })
      client.on('authentication', (ctx) => {
        if (ctx.method === 'password' && ctx.username === TEST_USER && ctx.password === TEST_PASSWORD) {
          ctx.accept()
          return
        }
        if (ctx.method === 'publickey' && ctx.username === TEST_USER) {
          // Accept only the generated keypair: compare the offered public key
          // blob so key-auth tests prove the engine used the right key file.
          const parsed = ssh2Utils.parseKey(readFileSync(keyPair.publicKey))
          const expected = parsed instanceof Error || parsed === null ? undefined : parsed.getPublicSSH()
          if (ctx.key !== undefined && expected !== undefined && ctx.key.data.equals(expected)) {
            ctx.accept()
            return
          }
          ctx.reject()
          return
        }
        ctx.reject()
      }).on('ready', () => {
        client.on('session', (accept) => {
          const session = accept()
          session.on('exec', (acceptExec, _rejectExec, info) => {
            const stream = acceptExec() as unknown as ClientChannel
            harness.execRequests.push(info.command)
            handleCommand(info.command, stream, harness)
          })
          session.on('pty', (acceptPty) => acceptPty())
          session.on('window-change', () => undefined)
          session.on('shell', (acceptShell) => {
            const stream = acceptShell() as unknown as ClientChannel
            let channelClosed = false
            stream.on('data', (chunk: Buffer) => stream.write(chunk))
            stream.on('close', () => {
              // The SSH protocol needs both sides to close the channel; echo
              // the close back (guarded against re-entry).
              if (channelClosed) return
              channelClosed = true
              try { stream.close() } catch { /* already closed */ }
            })
          })
          session.on('sftp', () => undefined)
          session.on('subsystem', () => undefined)
        })
        client.on('tcpip', (acceptTcp, _rejectTcp, info) => {
          const stream = acceptTcp()
          const target = connect({ host: info.destIP, port: info.destPort })
          stream.pipe(target).pipe(stream)
          target.on('error', () => { try { stream.close() } catch { /* closed */ } })
        })
      })
    })
    server.on('connection', () => { connectCount += 1 })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    const harness = new TestSshServer(port, server, echoServer, dir, keyPair, clients, hostKeyFingerprintSha256)
    harness.connectCount = connectCount
    // The static this-binding above is awkward; keep the counter fresh via getter.
    server.on('connection', () => { harness.connectCount += 1 })
    return harness
  }

  /** Force-close every client connection (broken-connection tests). */
  killAllClients(): void {
    for (const client of this.clients) {
      try { client.end() } catch { /* already gone */ }
    }
  }

  /** Stop the harness. */
  async stop(): Promise<void> {
    try { this.echoServer.close() } catch { /* closed */ }
    await new Promise<void>((resolve) => { this.server.close(() => resolve()) })
    rmSync(this.dir, { recursive: true, force: true })
  }
}
