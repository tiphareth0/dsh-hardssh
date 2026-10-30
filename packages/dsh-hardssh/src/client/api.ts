/**
 * Browser-side API clients: the /api/dsh-hardssh route family (SSH workspace
 * CRUD, remote dir browsing, workspace file ops) plus the two /api/dsh-ssh
 * endpoints the config dialog needs (host create + test). Plain fetch, same
 * origin 鈥?the only data path the panel components use.
 */

import { HttpApiError, buildQuery, readJson, type HttpErrorBody } from '../client-http.ts'
import {
  WORKSPACE_API,
  type RemoteDirEntry,
  type SshWorkspaceRecord,
} from '../protocol.ts'

/**
 * Workspace-route error: the shared transport error under this family's name.
 * It adds no parsing — `readJson` in ../client-http.ts owns status/body
 * decoding for both route families.
 */
export class WorkspaceApiError extends HttpApiError {
  constructor(
    message: string,
    status?: number,
    body?: HttpErrorBody,
  ) {
    super(message, status, body)
    this.name = 'WorkspaceApiError'
  }
}

/** The workspace route family client. */
export class WorkspaceApi {
  /** List the SSH-bound workspaces. */
  async listWorkspaces(): Promise<SshWorkspaceRecord[]> {
    const response = await fetch(WORKSPACE_API.sshWorkspaces)
    const body = await readJson<{ workspaces: SshWorkspaceRecord[] }>(response)
    return body.workspaces
  }

  /** Create one SSH-bound workspace. */
  async createWorkspace(input: { title: string; alias: string; remoteRoot: string }): Promise<SshWorkspaceRecord> {
    const response = await fetch(WORKSPACE_API.sshWorkspaces, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
    const body = await readJson<{ workspace: SshWorkspaceRecord }>(response)
    return body.workspace
  }

  /** Rename one SSH-bound workspace. */
  async renameWorkspace(id: string, title: string): Promise<SshWorkspaceRecord> {
    const response = await fetch(WORKSPACE_API.sshWorkspaces + '/item' + buildQuery({ id }), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title }),
    })
    const body = await readJson<{ workspace: SshWorkspaceRecord }>(response)
    return body.workspace
  }

  /** Delete one SSH-bound workspace. */
  async deleteWorkspace(id: string): Promise<void> {
    const response = await fetch(WORKSPACE_API.sshWorkspaces + '/item' + buildQuery({ id }), {
      method: 'DELETE',
    })
    await readJson<{ ok: true }>(response)
  }

  /** Browse a remote directory (for the workspace picker). */
  async listRemoteDir(alias: string, path?: string): Promise<{ path: string; entries: RemoteDirEntry[] }> {
    const response = await fetch(WORKSPACE_API.sshWorkspaceDir + buildQuery({ alias, path }))
    const body = await readJson<{ path: string; entries: RemoteDirEntry[] }>(response)
    return body
  }
}
