import type { Context } from '@deepseek-ai/cordis'
import packageInfo from '../../package.json' with { type: 'json' }
import { TESTED_DSH_RANGE, probeOptionalServices, type ServiceProbe } from './compat-contract.ts'
import type {
  HardsshFeatureHealth as FeatureHealth,
  HardsshHealthFeature as HealthFeature,
  HardsshHealthSnapshot,
} from '../ssh/protocol.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host-side compatibility/degradation status. */
    hardsshHealth: HardsshHealthRegistry
  }
}

function copyFeature(value: FeatureHealth): FeatureHealth {
  return { ...value, ...(value.missing === undefined ? {} : { missing: [...value.missing] }) }
}

function sameFeature(left: FeatureHealth, right: FeatureHealth): boolean {
  if (left.state !== right.state || left.reason !== right.reason) return false
  const a = left.missing ?? []
  const b = right.missing ?? []
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function initial(reason: string): FeatureHealth {
  return { state: 'degraded', reason }
}

/** Mutable owner of one immutable health snapshot; routes only expose copies. */
export class HardsshHealthRegistry {
  private features: Record<HealthFeature, FeatureHealth> = {
    sshTools: initial('SSH tool surface has not mounted yet'),
    workspaceCore: initial('workspace core has not initialized yet'),
    fsRouting: initial('filesystem routing facade has not mounted yet'),
    subprocessRouting: initial('subprocess routing facade has not mounted yet'),
  }
  private optionalServices: ServiceProbe[] = []
  private updatedAt = new Date().toISOString()

  set(feature: HealthFeature, value: FeatureHealth): void {
    const next = copyFeature(value)
    // fs/subprocess can report the same degraded state on every call while a
    // core is unavailable. Keep updatedAt meaningful and avoid churn in health
    // polling by making identical writes a no-op.
    if (sameFeature(this.features[feature], next)) return
    this.features = { ...this.features, [feature]: next }
    this.updatedAt = new Date().toISOString()
  }

  probeServices(ctx: Context): void {
    this.optionalServices = probeOptionalServices(ctx)
    this.updatedAt = new Date().toISOString()
  }

  snapshot(): HardsshHealthSnapshot {
    return {
      packageVersion: packageInfo.version,
      testedDshRange: TESTED_DSH_RANGE,
      features: {
        sshTools: { ...this.features.sshTools, ...(this.features.sshTools.missing === undefined ? {} : { missing: [...this.features.sshTools.missing] }) },
        workspaceCore: { ...this.features.workspaceCore, ...(this.features.workspaceCore.missing === undefined ? {} : { missing: [...this.features.workspaceCore.missing] }) },
        fsRouting: { ...this.features.fsRouting, ...(this.features.fsRouting.missing === undefined ? {} : { missing: [...this.features.fsRouting.missing] }) },
        subprocessRouting: { ...this.features.subprocessRouting, ...(this.features.subprocessRouting.missing === undefined ? {} : { missing: [...this.features.subprocessRouting.missing] }) },
      },
      optionalServices: this.optionalServices.map(probe => ({ ...probe, missingMethods: [...probe.missingMethods] })),
      updatedAt: this.updatedAt,
    }
  }
}

/**
 * Mount the ONE health provider. Only the main `hardssh` bundle entry calls
 * this function; sibling seam entries use `bindHardsshHealthFeature()` below.
 * Keeping ownership explicit is what prevents Cordis parallel-load duplicate
 * registration races.
 */
export function mountHardsshHealth(ctx: Context): HardsshHealthRegistry {
  const existing = ctx.get('hardsshHealth') as HardsshHealthRegistry | undefined
  if (existing !== undefined) return existing
  const health = new HardsshHealthRegistry()
  ctx.provide('hardsshHealth', health)
  return health
}

/**
 * Publish one feature without competing with the main bundle entry for service
 * ownership. Loader entries are activated concurrently, so a sibling may run
 * after `provide()` but before that provider's fiber becomes visible to
 * `ctx.get()`. Dynamic injection closes that window and replays the latest
 * feature state when the main registry becomes available.
 */
export function bindHardsshHealthFeature(
  ctx: Context,
  feature: HealthFeature,
  initialValue: FeatureHealth,
): (value: FeatureHealth) => void {
  // Own a copy: callers often reuse object literals and must not be able to
  // mutate the value that will be replayed after a later provider/HMR cycle.
  let latest = copyFeature(initialValue)
  let registry: HardsshHealthRegistry | undefined

  ctx.inject(['hardsshHealth'], (scoped) => {
    // Capture the bound provider NOW. Reading scoped.hardsshHealth again during
    // cleanup is unsafe: the service may already have disappeared, which is
    // exactly the lifecycle edge this cleanup handles.
    const bound = scoped.hardsshHealth
    registry = bound
    bound.set(feature, latest)
    return () => {
      if (registry === bound) registry = undefined
    }
  })

  return (value: FeatureHealth): void => {
    latest = copyFeature(value)
    registry?.set(feature, latest)
  }
}

/**
 * Track optional services across parallel activation and HMR. A one-shot probe
 * at main-entry startup is racy: webServer/settings/systemPrompt may become
 * visible a tick later and health would incorrectly report them missing
 * forever. Dynamic inject refreshes the complete probe whenever any optional
 * service appears or disappears.
 */
export function watchHardsshOptionalServices(ctx: Context, health: HardsshHealthRegistry): void {
  health.probeServices(ctx)
  for (const service of ['webServer', 'settings', 'systemPrompt'] as const) {
    ctx.inject([service], (scoped) => {
      health.probeServices(scoped)
      return () => {
        // Cleanup can run while Cordis is still changing the provider fiber;
        // defer one microtask so ctx.get() observes the settled post-unload set.
        queueMicrotask(() => health.probeServices(ctx))
      }
    })
  }
}

/** Read health without making it a hard inject dependency. */
export function getHardsshHealth(ctx: Context): HardsshHealthRegistry | undefined {
  return ctx.get('hardsshHealth') as HardsshHealthRegistry | undefined
}
