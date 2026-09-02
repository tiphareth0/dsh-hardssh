/**
 * Tool-layer tests: every factory must construct (the rc.6 defineTool DSL
 * rejects raw JSON Schema 'required' arrays — a regression here would fail
 * plugin startup), and the execute/render contracts must not drift.
 */

import { describe, expect, it } from 'vitest'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { SshEngine } from '../../src/ssh/engine.ts'
import type { ExecResult, SshHostSummary, TunnelInfo } from '../../src/ssh/protocol.ts'
import {
  sshClusterTool,
  sshDownloadTool,
  sshExecTool,
  sshListTool,
  sshTunnelTool,
  sshUploadTool,
} from '../../src/ssh/tools.ts'

/** In-memory engine stub: enough surface for the tool factories. */
class StubEngine {
  hosts: SshHostSummary[] = []
  execFailure: Error | undefined
  execResult: ExecResult = { success: true, exitCode: 0, timedOut: false, stdout: 'hello out', stderr: '', durationMs: 5 }
  tunnelStartError: Error | undefined
  tunnelExists = true

  list(): SshHostSummary[] {
    return this.hosts
  }
  find(): SshHostSummary | undefined {
    return undefined
  }
  async exec(_alias: string, _command: string, _timeoutMs?: number): Promise<ExecResult> {
    if (this.execFailure !== undefined) throw this.execFailure
    return this.execResult
  }
  async cluster(): Promise<unknown[]> {
    return []
  }
  async upload(): Promise<{ bytes: number; files: number }> {
    return { bytes: 12, files: 1 }
  }
  async download(): Promise<{ bytes: number }> {
    return { bytes: 34 }
  }
  listTunnels(): TunnelInfo[] {
    return []
  }
  async startTunnel(): Promise<TunnelInfo> {
    if (this.tunnelStartError !== undefined) throw this.tunnelStartError
    throw new Error('unexpected')
  }
  stopTunnel(_id: string): boolean {
    return this.tunnelExists
  }
  stopAllTunnels(): number {
    return 0
  }
  async test(): Promise<{ ok: boolean }> {
    return { ok: true }
  }
}

const engine = (stub: StubEngine): SshEngine => stub as unknown as SshEngine

/** ToolDefinition.execute needs a ToolRunContext; tests pass a dummy. */
function run(tool: ToolDefinition, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return tool.execute(args, {} as never) as Promise<Record<string, unknown>>
}

function render(tool: ToolDefinition, value: unknown): string {
  const blocks = tool.output.render({}, value as never)
  const first = blocks[0]
  return first !== undefined && 'text' in first ? first.text : ''
}

const host: SshHostSummary = {
  alias: 'web-01',
  host: '10.0.0.1',
  port: 22,
  user: 'root',
  auth: 'key',
  keyReady: true,
  proxyJump: [],
  description: 'web',
  environment: 'production',
  tags: ['web'],
  location: 'dc-a',
  createdAt: 1,
  updatedAt: 1,
}

describe('tool factories (defineTool DSL regression)', () => {
  it('constructs every tool without throwing', () => {
    const stub = new StubEngine()
    const factories = [
      sshListTool, sshExecTool, sshUploadTool, sshDownloadTool, sshTunnelTool, sshClusterTool,
    ]
    for (const factory of factories) {
      expect(() => factory(engine(stub))).not.toThrow()
    }
  })
})

describe('ssh_list', () => {
  it('returns hosts and renders a table', async () => {
    const stub = new StubEngine()
    stub.hosts = [host]
    const tool = sshListTool(engine(stub))
    const result = await run(tool, {})
    expect(result.ok).toBe(true)
    expect((result.hosts as SshHostSummary[])).toEqual([host])
    const text = render(tool, result)
    expect(text).toContain('web-01')
    expect(text).toContain('10.0.0.1')
  })
})

describe('ssh_exec', () => {
  it('propagates engine failures as a failed envelope, not a throw', async () => {
    const stub = new StubEngine()
    stub.execFailure = new Error('connection refused')
    const tool = sshExecTool(engine(stub))
    const result = await run(tool, { alias: 'web-01', command: 'true' })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('connection refused')
    expect(result.success).toBeUndefined()
  })

  it('keeps a non-zero remote exit as ok:true (tool call itself succeeded)', async () => {
    const stub = new StubEngine()
    stub.execResult = { success: false, exitCode: 7, timedOut: false, stdout: '', stderr: 'boom', durationMs: 5 }
    const tool = sshExecTool(engine(stub))
    const result = await run(tool, { alias: 'web-01', command: 'exit 7' })
    expect(result.ok).toBe(true)
    expect(result.success).toBe(false)
    expect(result.exitCode).toBe(7)
  })

  it('renders timed-out results with the timed-out marker', async () => {
    const stub = new StubEngine()
    const tool = sshExecTool(engine(stub))
    const result = await run(tool, { alias: 'web-01', command: 'hang' })
    const text = render(tool, { ...result, timedOut: true, exitCode: null, stdout: '', stderr: '' })
    expect(text).toContain('[timed out]')
  })
})

describe('ssh_tunnel', () => {
  it('reports an unknown tunnel id honestly (ok:false + error)', async () => {
    const stub = new StubEngine()
    stub.tunnelExists = false
    const tool = sshTunnelTool(engine(stub))
    const result = await run(tool, { action: 'stop', tunnelId: 'tun-999' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('not found')
    const text = render(tool, result)
    expect(text).toContain('ssh_tunnel failed')
  })

  it('renders a failed start as a failure envelope, no fake tunnel', async () => {
    const stub = new StubEngine()
    stub.tunnelStartError = new Error('EADDRINUSE')
    const tool = sshTunnelTool(engine(stub))
    const result = await run(tool, { action: 'start', alias: 'web-01', remotePort: 5432 })
    expect(result.ok).toBe(false)
    expect(result.tunnel).toBeUndefined()
    expect(result.error).toContain('EADDRINUSE')
    const text = render(tool, result)
    expect(text).toContain('ssh_tunnel failed')
    expect(text).toContain('EADDRINUSE')
  })
})

describe('uniform tool envelope (P1-20)', () => {
  it('list/cluster succeed with ok:true and their payloads', async () => {
    const stub = new StubEngine()
    const listResult = await run(sshListTool(engine(stub)), {})
    expect(listResult.ok).toBe(true)
    expect(Array.isArray(listResult.hosts)).toBe(true)
    const clusterResult = await run(sshClusterTool(engine(stub)), { command: 'true' })
    expect(clusterResult.ok).toBe(true)
    expect(Array.isArray(clusterResult.results)).toBe(true)
  })

  it('tunnel parameter errors return envelopes, not throws', async () => {
    const stub = new StubEngine()
    const tool = sshTunnelTool(engine(stub))
    const missing = await run(tool, { action: 'start' })
    expect(missing.ok).toBe(false)
    expect(missing.error).toContain('alias and remotePort')
    const unknown = await run(tool, { action: 'bogus' })
    expect(unknown.ok).toBe(false)
    expect(unknown.error).toContain('unknown action')
  })
})

describe('ssh_upload / ssh_download', () => {
  it('maps engine outcomes into ok results', async () => {
    const stub = new StubEngine()
    const upload = sshUploadTool(engine(stub))
    const up = await run(upload, { alias: 'web-01', localPath: '/tmp/a', remotePath: '/tmp/b' })
    expect(up.ok).toBe(true)
    expect(up.transferredBytes).toBe(12)

    const download = sshDownloadTool(engine(stub))
    const down = await run(download, { alias: 'web-01', remotePath: '/tmp/b', localPath: '/tmp/a' })
    expect(down.ok).toBe(true)
    expect(down.bytes).toBe(34)
  })
})
