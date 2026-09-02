/**
 * @tiphareth/dsh-hardssh/base — the generic workspace base.
 *
 * Provider-agnostic core: workspace model, provider/connection/capability
 * contracts, registry, ledger, namespace codec, router, and the plugin
 * registration API. No SSH, no Cordis, no React.
 *
 * @module @tiphareth/dsh-hardssh/base
 */

export * from './model.ts'
export * from './capability.ts'
export * from './registry.ts'
export * from './ledger.ts'
export * from './namespace.ts'
export * from './router.ts'
export * from './ledger-router.ts'
export * from './plugin.ts'