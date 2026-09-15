import type { Context } from '@deepseek-ai/cordis'

/** DSH component line covered by the compatibility matrix. */
export const TESTED_DSH_RANGE = '>=0.1.5-alpha.1 <0.1.6'
/** Node versions exercised in CI and accepted by package.json. */
export const TESTED_NODE_RANGE = '^22.19.0 || >=24.0.0'

export type ContractKind = 'required-runtime' | 'optional-service' | 'type-only'

export interface ContractRequirement {
  packageName: string
  kind: ContractKind
  /** Runtime exports the package must expose; absent for service/type contracts. */
  exports?: readonly string[]
  /** Cordis services consumed through ctx.get()/dynamic inject. */
  services?: readonly string[]
  reason: string
}

/**
 * Actual package/service contracts used by production source. Keep this list
 * narrow: it is a compatibility gate, not a copy of peerDependencies.
 */
export const HARDSSH_CONTRACT: readonly ContractRequirement[] = Object.freeze([
  {
    packageName: '@deepseek-ai/cordis',
    kind: 'required-runtime',
    exports: ['Context'],
    reason: 'all host and client services are mounted through Cordis',
  },
  {
    packageName: '@deepseek-ai/dsh-fs',
    kind: 'required-runtime',
    exports: ['FileSystem', 'FsError', 'FsTargetKey', 'FsVersion'],
    reason: 'filesystem facade inheritance, target identity and structured errors',
  },
  {
    packageName: '@deepseek-ai/dsh-fs-local',
    kind: 'required-runtime',
    exports: ['LocalFileSystem'],
    reason: 'local provider and compatibility fallback',
  },
  {
    packageName: '@deepseek-ai/dsh-fs-sandbox',
    kind: 'required-runtime',
    exports: ['SandboxedFileSystem'],
    reason: 'the replacement fs row must preserve the deployment sandbox locally',
  },
  {
    packageName: '@deepseek-ai/dsh-subprocess',
    kind: 'required-runtime',
    exports: ['SubprocessRuntime', 'SENSITIVE_ENV_PATTERN'],
    reason: 'subprocess facade inheritance and remote environment filtering',
  },
  {
    packageName: '@deepseek-ai/dsh-subprocess-local',
    kind: 'required-runtime',
    exports: ['LocalSubprocessRuntime'],
    reason: 'local subprocess fallback',
  },
  {
    packageName: '@deepseek-ai/dsh-tools',
    kind: 'required-runtime',
    exports: ['defineTool'],
    reason: 'ssh_* and remote_* tool definitions',
  },
  {
    packageName: '@deepseek-ai/dsh-timeout',
    kind: 'required-runtime',
    exports: ['MAX_TIMER_DELAY_MS'],
    reason: 'bounded remote subprocess timers',
  },
  {
    packageName: '@deepseek-ai/schemastery',
    kind: 'required-runtime',
    exports: ['default'],
    reason: 'host/plugin settings schemas',
  },
  {
    packageName: '@deepseek-ai/dsh-host-webserver',
    kind: 'optional-service',
    services: ['webServer'],
    reason: 'headless profiles keep tools but omit HTTP/WebSocket routes',
  },
  {
    packageName: '@deepseek-ai/dsh-settings',
    kind: 'optional-service',
    services: ['settings'],
    reason: 'settings UI integration is optional; config defaults remain usable',
  },
  {
    packageName: '@deepseek-ai/dsh-system-prompt',
    kind: 'optional-service',
    services: ['systemPrompt'],
    reason: 'announcement text is optional and must not gate host operation',
  },
  {
    packageName: '@deepseek-ai/dsh-client-runtime',
    kind: 'type-only',
    reason: 'ClientContext typing and module augmentation',
  },
  {
    packageName: '@deepseek-ai/dsh-client-ui-sidebar-right',
    kind: 'type-only',
    reason: 'right-sidebar client service typing; runtime presence is checked by the client mount',
  },
])

export interface ServiceProbe {
  service: string
  available: boolean
  missingMethods: string[]
}

function methodMissing(value: unknown, methods: readonly string[]): string[] {
  if (typeof value !== 'object' || value === null) return [...methods]
  return methods.filter(method => typeof (value as Record<string, unknown>)[method] !== 'function')
}

/** Probe optional Cordis surfaces without importing their implementation. */
export function probeOptionalServices(ctx: Context): ServiceProbe[] {
  const specs: Array<{ service: string; methods: readonly string[] }> = [
    { service: 'webServer', methods: ['register', 'registerUpgrade'] },
    { service: 'settings', methods: ['installSection'] },
    { service: 'systemPrompt', methods: ['section'] },
  ]
  return specs.map(({ service, methods }) => {
    const value = ctx.get(service as never) as unknown
    const missingMethods = methodMissing(value, methods)
    return { service, available: missingMethods.length === 0, missingMethods }
  })
}
