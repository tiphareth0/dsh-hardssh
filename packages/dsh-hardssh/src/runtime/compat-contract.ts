import type { Context } from '@deepseek-ai/cordis'

/**
 * DSH component line covered by the compatibility matrix.
 *
 * The matrix first claimed `>=0.1.5-alpha.1`; running that earliest set
 * disproved it — `@deepseek-ai/dsh-client-ui-slots@0.1.5-alpha.1` has no `main`
 * slot, so `registerWorkspacePanel` fails typecheck and the center panel would
 * have nowhere to mount. `0.1.5-alpha.*` therefore remains unsupported
 * (recorded as verified-incompatible, see compat/README.md).
 *
 * The declared range covers the empirically verified lines: `0.1.5-rc.1`,
 * `0.1.5-rc.2`, `0.1.6-alpha.1` and `0.1.6-alpha.2` (every component publishes
 * the 0.1.6 alphas except `dsh-code-runtime`, which stays on `0.1.5-rc.2` in
 * those sets). The `|| >=0.1.6-alpha.1` arm exists because semver only matches
 * a prerelease candidate when some comparator carries the same
 * major.minor.patch tuple with a prerelease — a plain `>=0.1.5-rc.1 <0.1.7`
 * would silently exclude `0.1.6-alpha.x`.
 */
export const TESTED_DSH_RANGE = '>=0.1.5-rc.1 <0.1.7 || >=0.1.6-alpha.1'
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

/** One accepted generation of an optional service's surface. */
type ServiceSurface = readonly string[]

function methodMissing(value: unknown, methods: ServiceSurface): string[] {
  if (typeof value !== 'object' || value === null) return [...methods]
  return methods.filter(method => typeof (value as Record<string, unknown>)[method] !== 'function')
}

/**
 * The generations of each optional service that count as available.
 *
 * A service can be rewritten between dsh lines, so a service is reported
 * available when ANY listed surface is complete. `settings` is the concrete
 * case: 0.1.x exposes `installSection(owner, ns, schema, entry, hooks)`, while
 * 0.2.0 replaced the service with `SettingsForms` (`configure` / `describe` /
 * `update`) and generates each plugin's page from its own `Config` schema
 * instead. Probing only the old name reported `settings` as unavailable on
 * 0.2.0 — a false alarm that claimed the configuration surface had disappeared
 * while the UI was in fact working from the schema this plugin already exports.
 */
const OPTIONAL_SERVICE_SURFACES: ReadonlyArray<{ service: string; surfaces: readonly ServiceSurface[] }> = [
  { service: 'webServer', surfaces: [['register', 'registerUpgrade']] },
  { service: 'settings', surfaces: [['installSection'], ['configure', 'describe']] },
  { service: 'systemPrompt', surfaces: [['section']] },
]

/** Probe optional Cordis surfaces without importing their implementation. */
export function probeOptionalServices(ctx: Context): ServiceProbe[] {
  return OPTIONAL_SERVICE_SURFACES.map(({ service, surfaces }) => {
    const value = ctx.get(service as never) as unknown
    // Report the generation the service is closest to: more present members
    // first, then fewer missing ones. Without this, a 0.2.0 settings service that
    // merely lacks `configure` would be reported as "missing installSection" —
    // the generation it plainly is not.
    let closest: string[] | undefined
    let closestPresent = -1
    for (const surface of surfaces) {
      const missing = methodMissing(value, surface)
      if (missing.length === 0) return { service, available: true, missingMethods: [] }
      const present = surface.length - missing.length
      const better = present > closestPresent || (present === closestPresent && closest !== undefined && missing.length < closest.length)
      if (better) {
        closest = missing
        closestPresent = present
      }
    }
    return { service, available: false, missingMethods: closest ?? [] }
  })
}
