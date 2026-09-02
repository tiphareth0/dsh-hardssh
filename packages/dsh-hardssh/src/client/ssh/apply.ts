/**
 * SSH operations browser surfaces, hosted inside dsh-hardssh's client bundle
 * (migrated from the legacy dsh-ssh package): the 'dsh-ssh'
 * locale dictionaries, the sidebar entry row, and the SSH operations panel
 * in the center column. Mounted from src/client/index.ts alongside the
 * workspace surfaces; a DOM failure here degrades the SSH panel only, never
 * the GUI.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the LocaleNamespaceMap merge table.
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { SshApi } from './api.ts'
import { en, zh } from './locales.ts'
import { mountPanel } from './mount.tsx'
import { PanelController } from './panel/controller.ts'
import { mountSidebarEntry } from './sidebar-entry.ts'

/** Locale namespace this capability owns (kept as 'dsh-ssh'). */
export const NS = 'dsh-ssh'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** dsh-ssh surface copy (now inside dsh-hardssh). */
    'dsh-ssh': import('./locales.ts').SshKey
  }
}

/**
 * Mount the SSH operations surfaces (sidebar entry + operations panel).
 * @param ctx - client root context (locale service).
 */
export function mountSshOperations(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-ssh: dictionaries')

  const controller = new PanelController()
  const api = new SshApi()
  const disposers: Array<() => void> = []
  try {
    disposers.push(mountSidebarEntry(controller))
    disposers.push(mountPanel(controller, api))
  } catch (error) {
    // DOM failures degrade the panel, never the GUI.
    console.warn('[dsh-ssh] mount failed:', error)
  }
  ctx.effect(() => () => {
    for (const dispose of disposers.splice(0)) dispose()
  }, 'dsh-ssh: ui mounts')
}
