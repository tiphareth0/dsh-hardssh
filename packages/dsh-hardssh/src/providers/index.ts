/**
 * Registry of every built-in provider. The DSH runtime (and any consumer)
 * uses this to mount local + ssh providers; third-party providers register
 * the same way through the base plugin API.
 *
 * @module @tiphareth/dsh-hardssh/providers
 */

import type { WorkspaceProvider } from '../base/model.ts'
import type { WorkspaceProviderRegistry } from '../base/registry.ts'
import type { SshEngine } from '../ssh/engine.ts'
import type { HostStoreView } from '../core.ts'
import type { Context } from '@deepseek-ai/cordis'
import { createSshWorkspaceProvider } from './ssh/provider.ts'
import { createLocalWorkspaceProvider } from './local/provider.ts'

/** Register both built-in providers. Returns per-provider disposers. The
 *  Cordis context is mandatory: both providers serve only the real DSH
 *  fs/process capabilities, which need a per-workspace Cordis scope. */
export function registerBuiltinProviders(
  registry: WorkspaceProviderRegistry,
  deps: { engine?: SshEngine; hosts?: HostStoreView },
  context: Context,
): Array<() => void> {
  const disposers: Array<() => void> = []
  // Local first: always available, no external state.
  disposers.push(registry.register(createLocalWorkspaceProvider(context)))
  // SSH requires the engine; when absent (headless / partial load) it is
  // simply not registered — the base keeps working for local workspaces.
  if (deps.engine !== undefined) {
    disposers.push(registry.register(createSshWorkspaceProvider(deps.engine, context)))
  }
  return disposers
}

/** The canonical provider ids. */
export const BUILTIN_PROVIDER_IDS = ['local', 'ssh'] as const
export type BuiltinProviderId = (typeof BUILTIN_PROVIDER_IDS)[number]