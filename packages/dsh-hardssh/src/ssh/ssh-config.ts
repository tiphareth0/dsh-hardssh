/**
 * Live reader for the user's `~/.ssh/config`.
 *
 * The plugin used to only IMPORT that file once, snapshotting it into
 * `~/.dsh/dsh-ssh.json`. VS Code Remote-SSH instead treats the file as the
 * source of truth: a host added there is usable immediately, and an edited
 * port/user/key is picked up without a re-import. This module is the read half
 * of that model.
 *
 * Scope is deliberately the field set the plugin actually models (the owner's
 * own config uses nothing else):
 *
 *   Host / HostName / Port / User / IdentityFile / ProxyJump
 *
 * Anything else in the file is ignored, except that blocks the plugin CANNOT
 * address are reported instead of disappearing silently:
 *  - a wildcard pattern (`Host *`, `Host web-?`) is a matcher, not an address;
 *  - a block without `HostName` is skipped exactly like the one-shot importer
 *    always did (`Host alias` alone would resolve to the alias as a DNS name,
 *    which is a different, surprising thing to do behind a GUI).
 * `Include` / `Match` / multi-pattern `Host a b` are intentionally out of scope;
 * they are left for a later, evidence-backed step rather than half-implemented.
 *
 * Nothing here writes to the file: the plugin never edits the user's ssh config.
 * @module dsh-hardssh/ssh-config
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SshHostEntry } from './protocol.ts'

/** The user's standard OpenSSH config path (single source: this module reads and
 *  the store imports through it, so it cannot live in the store's file). */
export function sshConfigPath(): string {
  return join(homedir(), '.ssh', 'config')
}

/** One addressable host from `~/.ssh/config`. */
export interface SshConfigHost {
  /** The block's `Host` pattern (the alias the user types). */
  alias: string
  /** `HostName` — the real address. */
  host: string
  port: number
  user: string
  /** First `IdentityFile` of the block; ssh2 attempts one key per connection. */
  identityFile?: string
  proxyJump: string[]
}

/** Why one block cannot become a host. */
export type SshConfigSkipReason = 'wildcard' | 'no-hostname' | 'unknown-host'

/** One block the reader could not turn into an address. */
export interface SshConfigSkip {
  pattern: string
  reason: SshConfigSkipReason
}

/** The result of one read. */
export interface SshConfigRead {
  hosts: SshConfigHost[]
  skipped: SshConfigSkip[]
}

interface Block {
  pattern: string
  props: Record<string, string>
}

/**
 * Parse ssh-config TEXT into addressable hosts.
 *
 * Case-insensitive keywords, `#` comments and blank lines, values with spaces
 * (an escaped/quoted `IdentityFile` path keeps its text). A repeated keyword
 * inside one block keeps its last value, except `IdentityFile`, which is
 * additive in OpenSSH and therefore keeps its FIRST entry here (one key per
 * connection is all ssh2 attempts).
 * @param text - the file content.
 * @returns addressable hosts plus the blocks that were skipped and why.
 */
export function parseSshConfigText(text: string): SshConfigRead {
  const blocks: Block[] = []
  let current: Block | undefined
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const match = /^([A-Za-z0-9_-]+)\s+(.+)$/.exec(line)
    if (match === null) continue
    const key = match[1]!.toLowerCase()
    const value = match[2]!.trim()
    if (key === 'host') {
      current = { pattern: value, props: {} }
      blocks.push(current)
      continue
    }
    if (current !== undefined) {
      // IdentityFile is ADDITIVE in OpenSSH (the client tries each), while this
      // model carries one key per attempt — so the FIRST listed stays the
      // primary instead of being replaced by a later entry.
      if (key === 'identityfile' && current.props.identityfile !== undefined) continue
      current.props[key] = value
    }
  }

  const hosts: SshConfigHost[] = []
  const skipped: SshConfigSkip[] = []
  for (const block of blocks) {
    // `Host a b` would need multi-pattern support; report it rather than
    // silently taking the first name (which may not be the one the user uses).
    const patterns = block.pattern.split(/\s+/).filter(part => part !== '')
    const pattern = patterns[0] ?? ''
    const hostName = block.props.hostname
    if (pattern === '') continue
    if (pattern.includes('*') || pattern.includes('?') || patterns.length > 1) {
      skipped.push({ pattern: block.pattern, reason: 'wildcard' })
      continue
    }
    if (hostName === undefined || hostName === '') {
      skipped.push({ pattern, reason: 'no-hostname' })
      continue
    }
    const port = block.props.port !== undefined ? Number.parseInt(block.props.port, 10) : 22
    const identityFile = block.props.identityfile
    hosts.push({
      alias: pattern,
      host: hostName,
      port: Number.isSafeInteger(port) && port > 0 ? port : 22,
      user: block.props.user ?? process.env.USER ?? 'root',
      ...(identityFile === undefined || identityFile === '' ? {} : { identityFile }),
      proxyJump: block.props.proxyjump === undefined
        ? []
        : block.props.proxyjump.split(',').map(hop => hop.trim()).filter(hop => hop !== ''),
    })
  }
  return { hosts, skipped }
}

/**
 * Read and parse the user's `~/.ssh/config` on demand.
 *
 * A missing or unreadable file is an EMPTY result, not an error: the plugin must
 * stay usable for users who keep every host in `dsh-ssh.json`, and a permissions
 * problem on this optional source must not break the host list.
 * @param configPath - file to read; defaults to the standard location.
 * @returns addressable hosts plus skipped blocks.
 */
export function readSshConfig(configPath = sshConfigPath()): SshConfigRead {
  let text: string
  try {
    text = readFileSync(configPath, 'utf8')
  } catch {
    return { hosts: [], skipped: [] }
  }
  return parseSshConfigText(text)
}

/**
 * Every addressable ssh-config host, keyed by alias, with the EARLIEST block
 * winning (OpenSSH takes the first matching block).
 * @param configPath - file to read; defaults to the standard location.
 * @returns a map from alias to host.
 */
export function sshConfigHostMap(configPath = sshConfigPath()): Map<string, SshConfigHost> {
  const map = new Map<string, SshConfigHost>()
  for (const host of readSshConfig(configPath).hosts) {
    if (!map.has(host.alias)) map.set(host.alias, host)
  }
  return map
}

/** The `HostStoreView` slice the engine reads, generic over its summary type. */
export interface HostView<Summary> {
  readonly path: string
  list(): SshHostEntry[]
  find(alias: string): SshHostEntry | undefined
  summarize(entry: SshHostEntry): Summary
}

/**
 * Project one ssh-config block into the plugin's entry shape.
 *
 * A block WITH `IdentityFile` is a key host. Without one the entry is a
 * password-kind host carrying NO secret: the engine tries keys and the agent
 * first and only prompts when the server still refuses — which is what an
 * ssh-config-only host expects.
 * @param host - parsed ssh-config block.
 * @returns a usable host entry (sourced, never persisted by this module).
 */
export function sshConfigHostEntry(host: SshConfigHost): SshHostEntry {
  return {
    alias: host.alias,
    host: host.host,
    port: host.port,
    user: host.user,
    auth: host.identityFile === undefined
      ? { kind: 'password' }
      : { kind: 'key', keyPath: host.identityFile },
    proxyJump: [...host.proxyJump],
    tags: [],
    // Sourced, not stored: the timestamps describe the JSON store, and a config
    // host has no record there.
    createdAt: 0,
    updatedAt: 0,
  }
}

/**
 * Compose the stored hosts with the live ssh config, store entries winning.
 *
 * This is the read half of the VS Code Remote-SSH model: `~/.ssh/config` is
 * re-read on every call, so a host added or edited there is usable immediately,
 * while `dsh-ssh.json` keeps the override/metadata layer (a GUI edit never
 * writes back to the user's ssh config). The plugin never mutates that file.
 * @param base - the stored host view (owned by the plugin).
 * @param configPath - ssh config to read; defaults to the standard location.
 * @returns a view whose `list`/`find` include the live config hosts.
 */
export function withSshConfig<Summary>(base: HostView<Summary>, configPath?: string): HostView<Summary> {
  const fromConfig = (): Map<string, SshHostEntry> => {
    const entries = new Map<string, SshHostEntry>()
    for (const host of sshConfigHostMap(configPath).values()) entries.set(host.alias, sshConfigHostEntry(host))
    return entries
  }
  return {
    path: base.path,
    list: () => {
      const merged = fromConfig()
      // The stored layer overrides the file: its port/user/key/metadata edits win.
      for (const entry of base.list()) merged.set(entry.alias, entry)
      return [...merged.values()]
    },
    find: (alias) => base.find(alias) ?? fromConfig().get(alias),
    summarize: (entry) => base.summarize(entry),
  }
}
