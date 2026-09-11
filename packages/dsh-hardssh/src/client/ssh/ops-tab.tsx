/**
 * The SSH operations surface as a RIGHT-Sidebar page tab.
 *
 * Registration follows the same public two-stage path any shipped tab type
 * uses:
 * 1. `ctx.sidebarRightTabs.register(...)` declares the type — its `id` is the
 *    key its body and chip title register under, its `kind` is what
 *    `ctx.sidebarRight.openTab(kind)` names.
 * 2. the body goes into the keyed `sidebar.right.pane.tab` seat, the chip title
 *    into `sidebar.right.pane.tab.title`, both under that `id`.
 *
 * It is a PAGE type (no `patterns`): it recognizes no resource address, so it is
 * opened by kind from the right sidebar's own add control or from its guide
 * entry — the plugin never forces the column open.
 *
 * The left sidebar's workspace manager is a separate, GLOBAL surface; host
 * CRUD lives there, so this console keeps only the per-session operations:
 * terminal, transfer, tunnels, cluster.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the SidebarRightTabDefinition type and the `sidebar.right.*`
// SlotMap augmentations.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
// Type-only: pulls the LocaleNamespaceMap augmentation.
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { tt } from '../text.ts'
import { SshPanel } from './panel/SshPanel.tsx'
import type { SshApi } from './api.ts'
import type { SessionSshTargetSource } from './session-target.ts'

/** This implementation's identity in the tab system; also the body/title key. */
export const OPS_TAB_ID = '@tiphareth/dsh-hardssh/operations'

/** The page kind `ctx.sidebarRight.openTab(kind)` names. */
export const OPS_TAB_KIND = 'hardssh-operations'

/**
 * Register the regression type, its body, and its chip title.
 * @param ctx - client root context carrying the tab registry and slot registry.
 * @param api - the SSH API client the panel's tabs operate through.
 * @param target - live target inherited from the selected Session.
 */
export function registerOperationsTab(
  ctx: ClientContext,
  api: SshApi,
  target: SessionSshTargetSource,
): void {
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: OPS_TAB_ID,
    kind: OPS_TAB_KIND,
    // The chip's initial text is captured into the layout record at open time;
    // a thunk keeps it following the active language without re-registering.
    title: () => tt('ops.tab'),
    // An entry box on the right sidebar's empty-state guide, so the surface is
    // discoverable without a plugin-owned button.
    guide: [{
      order: 100,
      title: () => tt('ops.tab'),
      description: () => tt('ops.guide'),
    }],
  }), 'dsh-hardssh: operations tab type')

  // The body: receives every tab of this kind, in every pane, docked or floating.
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: OPS_TAB_ID, inject: () => ({ api, target }) },
    SshPanel,
  ))

  // The chip title in the strip and a floating panel's header.
  ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab.title', key: OPS_TAB_ID },
    OpsTabTitle,
  ))
}

/** The tab chip and floating-panel header text. */
function OpsTabTitle(): string {
  return tt('ops.tab')
}
