/**
 * Agent tools: the remote-workspace counterpart of the local fs tools. Every
 * tool is bound to the SSH workspace OF THE CALLING SESSION: the tool's
 * `exec` carries `agent.session.header.cwd` (the session's workspace), which
 * the SSH-workspace record source resolves to a bound SSH workspace (alias +
 * remote root). A session in a local workspace gets a clear "this workspace is
 * not SSH-bound" error; sessions in SSH-bound workspaces operate on the remote
 * host.
 *
 * Plain file operations (read / write / edit / mkdir / rm / rename) are NOT
 * duplicated here: the fs seam routes them automatically by the session cwd
 * (SFTP on the remote host). This surface keeps only the tools the seam does
 * not cover: status (self-description), directory listing, and search.
 *
 * The bound-workspace operations (listing / glob / grep) come from the
 * `ops` resolver supplied at mount: it opens the logical connection via
 * `WorkspaceCore` and uses its `workspace.fs` / `workspace.search`
 * capabilities (provider-neutral). The tools never branch on `provider.id`.
 *
 * @module dsh-hardssh/tools
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { isInside, type WorkspaceStoreView } from './backend.ts'
import type { SshWorkspaceRecord } from './protocol.ts'
import type { ToolOpsResolver } from './workspace-tool-ops.ts'

/** One text content block (the only render shape these tools emit). */
function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

/** Tool-set dependencies. */
export interface WorkspaceToolsDeps {
  /** SSH-workspace record source (the generic projection store). */
  workspaces: WorkspaceStoreView
  /** Bound-workspace operations provider (generic capability seam). Resolves
   *  the calling session's cwd to its ops. */
  ops: ToolOpsResolver
}

/** Failure envelope shared by every tool. */
interface ToolFailure {
  ok: false
  error: string
}

/** The bound workspace record for the calling session's cwd, if any. */
async function boundWorkspace(workspaces: WorkspaceStoreView, exec: ToolRunContext): Promise<SshWorkspaceRecord | undefined> {
  const cwd = exec.agent?.session?.header?.cwd
  if (cwd === undefined || cwd === '') return undefined
  return workspaces.findByAnchor(cwd)
}

/** Build every remote_* tool (registered by the host half). */
export function makeWorkspaceTools(deps: WorkspaceToolsDeps) {
  const { workspaces, ops } = deps

  /** The bound workspace + ops for this call, or a failure when the session's
   *  workspace is not SSH-bound. */
  const bound = async (exec: ToolRunContext): Promise<{ record: SshWorkspaceRecord; ops: import('./workspace-tool-ops.ts').WorkspaceToolOps; resolve: (abs: string) => string | undefined } | ToolFailure> => {
    const cwd = exec.agent?.session?.header?.cwd
    const outcome = await ops(cwd)
    if (outcome === null) {
      return { ok: false, error: 'this session\'s workspace is not SSH-bound — create an SSH workspace and open a session in it first' }
    }
    const root = outcome.record.remoteRoot
    return {
      record: outcome.record,
      ops: outcome.ops,
      // Return undefined when the absolute path escapes the workspace root.
      resolve: (abs: string): string | undefined => (isInside(root, abs) ? abs : undefined),
    }
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
          const boundText = value.bound === true
            ? `current session: BOUND -> ${value.workspaceTitle ?? ''} (${value.alias ?? ''} @ ${value.remoteRoot ?? ''})`
            : 'current session: NOT bound (this workspace is local)'
          return text([boundText, '', 'SSH workspaces:', ...(list.length > 0 ? list : ['(none)'])].join('\n'))
        },
      },
      async execute(_args, exec) {
        const records = await workspaces.list()
        const workspace = await boundWorkspace(workspaces, exec)
        return {
          ok: true,
          bound: workspace !== undefined,
          workspaceTitle: workspace?.title,
          alias: workspace?.alias,
          remoteRoot: workspace?.remoteRoot,
          anchorPath: workspace?.anchorPath,
          workspaces: records.map((w) => ({ id: w.id, title: w.title, alias: w.alias, remoteRoot: w.remoteRoot, anchorPath: w.anchorPath })),
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
        const abs = check.resolve(args.path)
        if (abs === undefined) {
          return { ok: false, error: `path '${args.path}' is outside the remote root '${check.record.remoteRoot}' of workspace '${check.record.title}'` }
        }
        return run(async () => {
          const entries = await check.ops.listDir(abs)
          return { ok: true, path: abs, entries }
        })
      },
    }),

    defineTool({
      name: 'remote_search',
      description: 'Search the SSH workspace bound to the CALLING SESSION. mode="glob" matches FILE NAMES by pattern (root-relative, e.g. src/**/*.ts or *.log; `*` does not cross "/", `**` does; capped at 200 hits); mode="grep" searches file CONTENTS (skips .git and node_modules) and returns matched `path:line:content` records. `syntax` defaults to "fixed" (literal text); "regex" needs ripgrep or GNU grep on the host and fails loudly when neither is available. Triggers: find remote files by pattern, glob on the server, grep remote code, search remote contents.',
      parameters: {
        mode: { type: 'string', enum: ['glob', 'grep'], required: true, description: 'glob = match file names by pattern; grep = search file contents.' },
        pattern: { type: 'string', required: true, description: 'glob: root-relative pattern like src/**/*.ts or *.log; grep: the text to find (literal by default, regular expression with syntax="regex").' },
        syntax: { type: 'string', enum: ['fixed', 'regex'], description: 'grep only: "fixed" (default) treats pattern as literal text; "regex" treats it as an extended regular expression.' },
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
            ? value.mode === 'grep' ? '\n[output truncated]' : '\n[truncated at 200 hits]'
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
            const found = await check.ops.grep(args.pattern, args.syntax === undefined ? {} : { syntax: args.syntax })
            return { ok: true, mode: 'grep', lines: found.lines, hits: [], truncated: found.truncated }
          }
          const found = await check.ops.glob(args.pattern)
          return { ok: true, mode: 'glob', hits: found.hits, lines: [], truncated: found.truncated }
        })
      },
    }),
  ]
}
