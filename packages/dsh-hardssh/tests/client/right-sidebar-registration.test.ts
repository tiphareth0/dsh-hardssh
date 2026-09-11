import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const packageRoot = process.cwd()

describe('HardSSH right-sidebar registration dependencies', () => {
  it('waits for the sidebar tab registry service at runtime', () => {
    const source = readFileSync(resolve(packageRoot, 'src/client/index.ts'), 'utf8')
    const runtimeInject = /export const inject = \[([^\]]+)\]/su.exec(source)?.[1]
    expect(runtimeInject).toBeDefined()
    expect(runtimeInject).toContain("'sidebarRightTabs'")
  })

  it('orders the client bundle after ui-sidebar-right', () => {
    const manifest = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as {
      dsh?: { client?: { inject?: string[] } }
    }
    expect(manifest.dsh?.client?.inject).toContain('@deepseek-ai/dsh-client-ui-sidebar-right')
  })
})
