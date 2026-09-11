/**
 * The SSH workspace manager's LEFT-sidebar global entry and its CENTER panel.
 *
 * Both are standard plugin extension points, not DOM injection:
 * - `sidebar.panellist` declares the row between "New session" and the
 *   workspace browser. Its `id` IS the main-panel key the row selects, and the
 *   shell owns the button, the label, and the active highlight.
 * - `main` hosts the panel body under that same key.
 *
 * The id is deliberately our own rather than a shipped one: a fresh id is
 * added beside the shipped rows, while reusing one would replace that row.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the SlotMap augmentation for `sidebar.panellist` / `main`
// and their owner-prop shapes.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceManager } from './state.ts'
import type { SshApi } from './ssh/api.ts'
import { tt } from './text.ts'
import { WorkspaceManagerPanel } from './workspace-panel.tsx'

/** The main-panel key AND the sidebar row id: one identity addresses both. */
export const WORKSPACE_PANEL_ID = 'dsh-hardssh-workspaces'

/** Order among the global panel rows; the shipped rows sit around 0. */
const WORKSPACE_PANEL_ORDER = 100

/** Icon presentation the sidebar supplies to a global panel row. */
interface PanelIconProps {
  size: number
  active: boolean
}

/** The cloud/terminal glyph the workspace row shows in both the wide and rail sidebar. */
function WorkspacePanelIcon({ size }: PanelIconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
      <path d="M4.5 5.5l2.5 2.5-2.5 2.5" />
      <path d="M8.5 10.5h3" />
    </svg>
  )
}

/** Dependencies the panel body needs at render time. */
export interface WorkspacePanelDeps {
  manager: WorkspaceManager
  /** Absent when the plugin is mounted without the SSH operations half. */
  sshApi?: SshApi
}

/**
 * Register the left-sidebar row and the center panel body.
 * @param ctx - client root context carrying the slot registry.
 * @param deps - the workspace manager and the host API the panel uses.
 */
export function registerWorkspacePanel(ctx: ClientContext, deps: WorkspacePanelDeps): void {
  const inject = (): Record<string, unknown> => ({ manager: deps.manager, sshApi: deps.sshApi })

  // The global row: the shell renders the button and the active highlight from
  // the list metadata, and selecting it calls layout.selectPanel(id).
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
    {
      name: 'sidebar.panellist',
      id: WORKSPACE_PANEL_ID,
      order: WORKSPACE_PANEL_ORDER,
      // A thunk is re-read on every projection, so a language change needs no
      // re-registration.
      label: () => tt('panel.workspaces'),
    },
    WorkspacePanelIcon,
  ))

  // The center panel body, under the same key the row selects.
  ctx.slots.inject('main', () => ctx.slots.register(
    { name: 'main', key: WORKSPACE_PANEL_ID, inject },
    WorkspaceManagerPanel,
  ))
}
