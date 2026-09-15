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
    this.features = { ...this.features, [feature]: { ...value, ...(value.missing === undefined ? {} : { missing: [...value.missing] }) } }
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

/** Mount once, or adopt the registry a sibling bundle entry already supplied. */
export function mountHardsshHealth(ctx: Context): HardsshHealthRegistry {
  const existing = ctx.get('hardsshHealth') as HardsshHealthRegistry | undefined
  if (existing !== undefined) return existing
  const health = new HardsshHealthRegistry()
  ctx.provide('hardsshHealth', health)
  return health
}

/** Read health without making it a hard inject dependency. */
export function getHardsshHealth(ctx: Context): HardsshHealthRegistry | undefined {
  return ctx.get('hardsshHealth') as HardsshHealthRegistry | undefined
}
