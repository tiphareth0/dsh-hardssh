/**
 * SSH operations browser surfaces, hosted inside dsh-hardssh's client bundle
 * (migrated from the legacy dsh-ssh package): the 'dsh-ssh' locale
 * dictionaries and the SSH operations console mounted as a RIGHT-Sidebar page
 * tab.
 *
 * Nothing here touches the DOM. The old build injected a sidebar row and a
 * panel container by selector, which the 0.1.5 shell no longer renders — the
 * surfaces are standard plugin extension points now (see ./ops-tab.tsx).
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the LocaleNamespaceMap merge table.
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { SshApi } from './api.ts'
import { en, zh } from './locales.ts'
import { registerOperationsTab } from './ops-tab.tsx'
import type { SessionSshTargetSource } from './session-target.ts'

/** Locale namespace this capability owns (kept as 'dsh-ssh'). */
export const NS = 'dsh-ssh'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** dsh-ssh surface copy (now inside dsh-hardssh). */
    'dsh-ssh': import('./locales.ts').SshKey
  }
}

/**
 * Mount the SSH operations surfaces (locale dictionaries + the right-Sidebar tab).
 * @param ctx - client root context (locale service, slot registry, tab registry).
 * @param api - shared SSH API client.
 * @param target - selected Session's fixed SSH target, or null for local Sessions.
 */
export function mountSshOperations(
  ctx: ClientContext,
  api: SshApi,
  target: SessionSshTargetSource,
): void {
  try {
    registerOperationsTab(ctx, api, target)
  } catch (error) {
    // A wiring failure degrades the SSH operations tab only, never the GUI.
    console.warn('[dsh-ssh] operations tab registration failed:', error)
  }
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-ssh: dictionaries')
}
