/**
 * Browser-side API clients: the /api/dsh-hardssh route family (SSH workspace
 * CRUD, remote dir browsing, workspace file ops) plus the two /api/dsh-ssh
 * endpoints the config dialog needs (host create + test). Plain fetch, same
 * origin 鈥?the only data path the panel components use.
 */

import { HttpApiError, buildQuery, readJson } from '../client-http.ts'
import {
  WORKSPACE_API,
  type DirListing,
  type FileRead,
  type FileWriteResult,
  type RemoteDirEntry,
  type SearchView,
  type SshWorkspaceRecord,
} from '../protocol.ts'

/** Error carrying the route's JSON error message and stable code/status. */
export class WorkspaceApiError extends HttpApiError {
  constructor(
    message: string,
    code?: string,
    status?: number,
  ) {
    super(message, code, status)
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

  /** List the configured SSH hosts (from the shared dsh-ssh store). */
  async listHosts(): Promise<Array<{ alias: string; host: string; port: number; user: string }>> {
    const response = await fetch(WORKSPACE_API.sshWorkspaces + '/hosts')
    const body = await readJson<{ hosts: Array<{ alias: string; host: string; port: number; user: string }> }>(response)
    return body.hosts
  }

  /** Browse a remote directory (for the workspace picker). */
  async listRemoteDir(alias: string, path?: string): Promise<{ path: string; entries: RemoteDirEntry[] }> {
    const response = await fetch(WORKSPACE_API.sshWorkspaceDir + buildQuery({ alias, path }))
    const body = await readJson<{ path: string; entries: RemoteDirEntry[] }>(response)
    return body
  }

  async list(root: string, path: string): Promise<DirListing> {
    const response = await fetch(WORKSPACE_API.tree + buildQuery({ root, path }))
    const body = await readJson<{ listing: DirListing }>(response)
    return body.listing
  }

  async read(root: string, path: string): Promise<FileRead> {
    const response = await fetch(WORKSPACE_API.file + buildQuery({ root, path }))
    const body = await readJson<{ file: FileRead }>(response)
    return body.file
  }

  async write(root: string, path: string, content: string, expectedMtime?: number): Promise<FileWriteResult> {
    const response = await fetch(WORKSPACE_API.file, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root, path, content, expectedMtime }),
    })
    const body = await readJson<{ result: FileWriteResult }>(response)
    return body.result
  }

  async search(root: string, queryText: string): Promise<SearchView> {
    const response = await fetch(WORKSPACE_API.search + buildQuery({ root, query: queryText }))
    const body = await readJson<{ search: SearchView }>(response)
    return body.search
  }
}

/** The two /api/dsh-ssh endpoints the config dialog needs (host create/test). */
export interface SshHostPayload {
  alias?: string
  host: string
  port?: number
  user: string
  auth?: {
    kind: 'key' | 'password'
    keyPath?: string
    passphrase?: string
    password?: string
  }
  description?: string
}

export interface SshHostSummary {
  alias: string
  host: string
  port: number
  user: string
  auth: 'key' | 'password'
  keyReady: boolean
  description?: string
  createdAt: number
  updatedAt: number
}

export interface TestResult {
  ok: boolean
  latencyMs?: number
  error?: string
}

const HOSTS_API = '/api/dsh-ssh/hosts'
const TEST_API = '/api/dsh-ssh/test'

export class SshHostsApi {
  async list(): Promise<SshHostSummary[]> {
    const response = await fetch(HOSTS_API)
    const body = await readJson<{ hosts: SshHostSummary[] }>(response)
    return body.hosts
  }

  async create(payload: SshHostPayload): Promise<SshHostSummary> {
    const response = await fetch(HOSTS_API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const body = await readJson<{ host: SshHostSummary }>(response)
    return body.host
  }

  /** Update an existing host (PATCH /api/dsh-ssh/hosts?alias=鈥?. The payload
   *  may carry only the fields being changed; omitted auth keeps the stored
   *  secret. */
  async update(alias: string, payload: SshHostPayload): Promise<SshHostSummary> {
    const response = await fetch(`${HOSTS_API}?alias=${encodeURIComponent(alias)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const body = await readJson<{ host: SshHostSummary }>(response)
    return body.host
  }

  /** Delete a host (DELETE /api/dsh-ssh/hosts?alias=鈥?. */
  async remove(alias: string): Promise<void> {
    const response = await fetch(`${HOSTS_API}?alias=${encodeURIComponent(alias)}`, {
      method: 'DELETE',
    })
    await readJson<{ ok: true }>(response)
  }

  async test(alias: string): Promise<TestResult> {
    const response = await fetch(TEST_API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ alias }),
    })
    const body = await readJson<{ result: TestResult }>(response)
    return body.result
  }
}
