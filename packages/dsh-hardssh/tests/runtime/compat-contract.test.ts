import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  HARDSSH_CONTRACT,
  TESTED_DSH_RANGE,
  TESTED_NODE_RANGE,
  probeOptionalServices,
} from '../../src/runtime/compat-contract.ts'

interface CompatManifest {
  name: string
  packages: Record<string, string>
}

const repoRoot = resolve(import.meta.dirname, '../../../..')
const packageJson = JSON.parse(readFileSync(resolve(repoRoot, 'packages/dsh-hardssh/package.json'), 'utf8')) as {
  peerDependencies: Record<string, string>
}

function manifest(name: string): CompatManifest {
  return JSON.parse(readFileSync(resolve(repoRoot, `compat/${name}.json`), 'utf8')) as CompatManifest
}

describe('runtime compatibility contract', () => {
  it('lists every required runtime export and the installed test set supplies it', async () => {
    const required = HARDSSH_CONTRACT.filter(entry => entry.kind === 'required-runtime')
    expect(required.length).toBeGreaterThan(0)
    for (const entry of required) {
      const loaded = await import(entry.packageName) as Record<string, unknown>
      for (const name of entry.exports ?? []) {
        expect(loaded[name], `${entry.packageName} must export ${name}`).toBeDefined()
      }
    }
  })

  it('keeps optional Cordis services optional in a minimal context', async () => {
    const { Context } = await import('@deepseek-ai/cordis')
    const probes = probeOptionalServices(new Context())
    expect(probes.map(probe => probe.service)).toEqual(['webServer', 'settings', 'systemPrompt'])
    expect(probes.every(probe => !probe.available && probe.missingMethods.length > 0)).toBe(true)
  })

  it('covers every DeepSeek peer in both tested component manifests', () => {
    const peers = Object.keys(packageJson.peerDependencies).filter(name => name.startsWith('@deepseek-ai/'))
    for (const set of [manifest('dsh-0.1.5-alpha.1'), manifest('dsh-0.1.5-rc.1')]) {
      expect(set.name).toMatch(/^dsh-0\.1\.5-/)
      for (const peer of peers) expect(set.packages[peer], `${set.name} omits ${peer}`).toBeTypeOf('string')
    }
  })

  it('publishes bounded compatibility claims, never an unbounded wildcard', () => {
    expect(TESTED_DSH_RANGE).toBe('>=0.1.5-alpha.1 <0.1.6')
    expect(TESTED_NODE_RANGE).toContain('22.19')
    for (const [name, range] of Object.entries(packageJson.peerDependencies)) {
      if (name.startsWith('@deepseek-ai/')) expect(range, `${name} must be bounded`).not.toBe('*')
    }
  })
})
