/**
 * Agent tools: the remote-workspace counterpart of the local fs tools. Every
 * tool is bound to the SSH workspace OF THE CALLING SESSION: the tool's
 * `exec` carries `agent.session.header.cwd` (the session's workspace), which
 * the ledger resolves to a bound SSH workspace (alias + remote root). A
 * session in a local workspace gets a clear "this workspace is not SSH-bound"
 * error; sessions in SSH-bound workspaces operate on the remote host.
 *
 * Plain file operations (read / write / edit / mkdir / rm / rename) are NOT
 * duplicated here: the fs seam routes them automatically by the session cwd
 * (SFTP on the remote host). This surface keeps only the tools the seam does
 * not cover: status (self-description), directory listing, and search.
 *
 * @module dsh-hardssh/tools
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { SshEngine } from './ssh/engine.ts'
import { isInside } from './backend.ts'
import { RemoteSearchService } from './remote-search.ts'
import type { SshWorkspaceLedger } from './ledger.ts'
import type { SshWorkspaceRecord } from './protocol.ts'

/** One text content block (the only render shape these tools emit). */
function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

/** Tool-set dependencies. */
export interface WorkspaceToolsDeps {
  engine: SshEngine
  ledger: SshWorkspaceLedger
  search: RemoteSearchService
}

/** Failure envelope shared by every tool. */
interface ToolFailure {
  ok: false
  error: string
}

/** The SSH bound workspace for the calling session's cwd. */
function boundWorkspace(ledger: SshWorkspaceLedger, exec: ToolRunContext): Promise<SshWorkspaceRecord | undefined> {
  const cwd = exec.agent?.session?.header?.cwd
  if (cwd === undefined || cwd === '') return Promise.resolve(undefined)
  return ledger.findByAnchor(cwd)
}

/** True when `abs` is inside (or equals) the remote root. */
function insideRoot(root: string, abs: string): boolean {
  return isInside(root, abs)
}

/** Build every remote_* tool (registered by the host half). */
export function makeWorkspaceTools(deps: WorkspaceToolsDeps) {
  const { engine, ledger, search } = deps

  /** The bound workspace for this call, or a failure when the session's
   *  workspace is not SSH-bound. */
  const bound = async (exec: ToolRunContext): Promise<{ workspace: SshWorkspaceRecord } | ToolFailure> => {
    const workspace = await boundWorkspace(ledger, exec)
    if (workspace === undefined) {
      return { ok: false, error: 'this session\'s workspace is not SSH-bound — create an SSH workspace and open a session in it first' }
    }
    return { workspace }
  }

  /** Gate one absolute remote path to the workspace's remote root. */
  const gatePath = (workspace: SshWorkspaceRecord, abs: string): string | undefined => {
    if (!insideRoot(workspace.remoteRoot, abs)) {
      return `path '${abs}' is outside the remote root '${workspace.remoteRoot}' of workspace '${workspace.title}'`
    }
    return undefined
  }

  /** Run one remote op, catching errors into the failure envelope. */
  const run = async <T>(operation: () => Promise<T>): Promise<T | ToolFailure> => {
    try {
      return await operation()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, error: message }
    }
  }

  return [
    defineTool({
      name: 'remote_status',
      description: 'List the SSH-bound workspaces and report whether the CALLING SESSION\'s workspace is SSH-bound (and to which host/root). Call this before any remote_* tool. Triggers: SSH mode, remote workspace, where am I working, which servers are bound.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            bound: { type: 'boolean', required: true },
            workspaceTitle: { type: 'string' },
            alias: { type: 'string' },
            remoteRoot: { type: 'string' },
            anchorPath: { type: 'string' },
            workspaces: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
              id: { type: 'string', required: true }, title: { type: 'string', required: true }, alias: { type: 'string', required: true }, remoteRoot: { type: 'string', required: true }, anchorPath: { type: 'string', required: true },
            } } },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => {
          if (value.ok !== true) return text(`remote_status failed: ${value.error ?? 'unknown error'}`)
          const list = (value.workspaces ?? []).map((w: { title: string; alias: string; remoteRoot: string; anchorPath: string }) =>
            `- ${w.title}  (${w.alias} @ ${w.remoteRoot}, anchor ${w.anchorPath})`)
          const bound = value.bound === true
            ? `current session: BOUND -> ${value.workspaceTitle ?? ''} (${value.alias ?? ''} @ ${value.remoteRoot ?? ''})`
            : 'current session: NOT bound (this workspace is local)'
          return text([bound, '', 'SSH workspaces:', ...(list.length > 0 ? list : ['(none)'])].join('\n'))
        },
      },
      async execute(_args, exec) {
        const workspaces = await ledger.list()
        const workspace = await boundWorkspace(ledger, exec)
        return {
          ok: true,
          bound: workspace !== undefined,
          workspaceTitle: workspace?.title,
          alias: workspace?.alias,
          remoteRoot: workspace?.remoteRoot,
          anchorPath: workspace?.anchorPath,
          workspaces: workspaces.map((w) => ({ id: w.id, title: w.title, alias: w.alias, remoteRoot: w.remoteRoot, anchorPath: w.anchorPath })),
        }
      },
    }),

    defineTool({
      name: 'remote_ls',
      description: 'List a directory on the SSH host bound to the CALLING SESSION\'s workspace (the path must be inside that workspace\'s remote root). Triggers: list remote directory, remote files, ls on the server.',
      parameters: {
        path: { type: 'string', required: true, description: 'Absolute remote directory path inside the workspace\'s remote root (e.g. /home/user/project/src).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            path: { type: 'string' },
            entries: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
              name: { type: 'string', required: true }, type: { type: 'string', required: true }, size: { type: 'integer', required: true }, mtimeMs: { type: 'integer', required: true },
            } } },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => {
          if (value.ok !== true) return text(`remote_ls failed: ${value.error ?? 'unknown error'}`)
          const rows = (value.entries ?? []).map((entry: { name: string; type: string; size: number }) =>
            `${entry.type === 'dir' ? 'dir ' : 'file'} ${entry.name}${entry.type === 'file' ? ` (${entry.size} bytes)` : ''}`)
          return text([`${value.path}`, ...(rows.length > 0 ? rows : ['(empty)'])].join('\n'))
        },
      },
      async execute(args, exec) {
        const check = await bound(exec)
        if ('error' in check) return check
        const gate = gatePath(check.workspace, args.path)
        if (gate !== undefined) return { ok: false, error: gate }
        return run(async () => {
          const entries = await engine.ls(check.workspace.alias, args.path)
          return { ok: true, path: args.path, entries: entries.map((entry) => ({ name: entry.name, type: entry.type, size: entry.size, mtimeMs: entry.mtimeMs })) }
        })
      },
    }),

    defineTool({
      name: 'remote_search',
      description: 'Search the SSH workspace bound to the CALLING SESSION. mode="glob" matches FILE NAMES by pattern (root-relative, e.g. src/**/*.ts or *.log; max depth 6, capped at 200 hits); mode="grep" searches file CONTENTS for a FIXED STRING (not a regex; skips .git and node_modules; capped at 200 matches per file and 200KB of output). Triggers: find remote files by pattern, glob on the server, grep remote code, search remote contents.',
      parameters: {
        mode: { type: 'string', enum: ['glob', 'grep'], required: true, description: 'glob = match file names by pattern; grep = search file contents for a fixed string.' },
        pattern: { type: 'string', required: true, description: 'glob: root-relative pattern like src/**/*.ts or *.log; grep: the literal text to find (not a regular expression).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            mode: { type: 'string' },
            hits: { type: 'array', items: { type: 'string' } },
            lines: { type: 'array', items: { type: 'string' } },
            truncated: { type: 'boolean' },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => {
          if (value.ok !== true) return text(`remote_search failed: ${value.error ?? 'unknown error'}`)
          const tail = value.truncated === true
            ? value.mode === 'grep' ? '\n[output truncated at 200KB]' : '\n[truncated at 200 hits]'
            : ''
          const body = value.mode === 'grep' ? (value.lines ?? []) : (value.hits ?? [])
          return text(body.length > 0 ? body.join('\n') + tail : '(no matches)')
        },
      },
      async execute(args, exec) {
        const check = await bound(exec)
        if ('error' in check) return check
        return run(async () => {
          if (args.mode === 'grep') {
            const found = await search.grepFixed(
              { alias: check.workspace.alias, root: check.workspace.remoteRoot },
              args.pattern,
            )
            return { ok: true, mode: 'grep', lines: found.lines, hits: [], truncated: found.truncated }
          }
          const found = await search.glob(
            { alias: check.workspace.alias, root: check.workspace.remoteRoot },
            args.pattern,
          )
          return { ok: true, mode: 'glob', hits: found.hits, lines: [], truncated: found.truncated }
        })
      },
    }),
  ]
}
