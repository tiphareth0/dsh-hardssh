#!/usr/bin/env node

/**
 * Offline emergency export: convert the authoritative generic workspace ledger
 * back to the frozen legacy SSH ledger shape. This command never changes
 * anchors and defaults to preview-only; pass --apply to write the legacy file.
 */
import { constants } from 'node:fs'
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'

function parseArgs(argv) {
  const result = {
    genericPath: join(homedir(), '.dsh', 'workspaces', 'index.v1.json'),
    legacyPath: join(homedir(), '.dsh', 'dsh-hardssh-workspaces.json'),
    apply: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--apply') {
      result.apply = true
    } else if (arg === '--generic' || arg === '--legacy') {
      const value = argv[index + 1]
      if (value === undefined || value === '') throw new Error(`${arg} requires a path`)
      if (arg === '--generic') result.genericPath = value
      else result.legacyPath = value
      index += 1
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write('Usage: export-legacy-workspaces [--generic PATH] [--legacy PATH] [--apply]\n')
      process.exit(0)
    } else {
      throw new Error(`unknown argument '${arg}'`)
    }
  }
  return result
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value === '') throw new Error(`invalid generic SSH workspace: ${label} is required`)
  return value
}

function toLegacyRecord(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('generic workspace entries must be objects')
  }
  const provider = value.provider
  const location = value.location
  const anchor = value.anchor
  if (typeof provider !== 'object' || provider === null || Array.isArray(provider)) throw new Error('generic workspace provider is invalid')
  if (provider.id !== 'ssh') return undefined
  if (typeof provider.connectionRef !== 'object' || provider.connectionRef === null || Array.isArray(provider.connectionRef)) {
    throw new Error(`generic SSH workspace '${String(value.id)}' has no connectionRef`)
  }
  if (typeof location !== 'object' || location === null || Array.isArray(location)) throw new Error(`generic SSH workspace '${String(value.id)}' has no location`)
  if (typeof anchor !== 'object' || anchor === null || Array.isArray(anchor)) throw new Error(`generic SSH workspace '${String(value.id)}' has no anchor`)
  return {
    id: requiredString(value.id, 'id'),
    title: requiredString(value.title, 'title'),
    alias: requiredString(provider.connectionRef.id, 'provider.connectionRef.id'),
    remoteRoot: requiredString(location.root, 'location.root'),
    anchorPath: requiredString(anchor.path, 'anchor.path'),
    createdAt: requiredString(value.createdAt, 'createdAt'),
  }
}

async function exists(path) {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

async function atomicExport(path, bytes) {
  await mkdir(dirname(path), { recursive: true })
  const tempPath = `${path}.tmp-${process.pid}-${randomUUID()}`
  const backupPath = await exists(path)
    ? `${path}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`
    : undefined
  await writeFile(tempPath, bytes, { encoding: 'utf8', mode: 0o600 })
  try {
    if (backupPath !== undefined) await rename(path, backupPath)
    try {
      await rename(tempPath, path)
    } catch (error) {
      if (backupPath !== undefined) await rename(backupPath, path).catch(() => undefined)
      throw error
    }
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined)
  }
  return backupPath
}

export async function exportLegacyWorkspaces(options) {
  const raw = JSON.parse(await readFile(options.genericPath, 'utf8'))
  if (!Array.isArray(raw)) throw new Error('generic workspace ledger must be a JSON array')
  const records = []
  const ids = new Set()
  const anchors = new Set()
  for (const value of raw) {
    const mapped = toLegacyRecord(value)
    if (mapped === undefined) continue
    if (ids.has(mapped.id)) throw new Error(`duplicate SSH workspace id '${mapped.id}'`)
    if (anchors.has(mapped.anchorPath)) throw new Error(`duplicate SSH workspace anchor '${mapped.anchorPath}'`)
    ids.add(mapped.id)
    anchors.add(mapped.anchorPath)
    records.push(mapped)
  }
  const bytes = `${JSON.stringify(records, null, 2)}\n`
  const backupPath = options.apply ? await atomicExport(options.legacyPath, bytes) : undefined
  return {
    mode: options.apply ? 'applied' : 'preview',
    genericPath: options.genericPath,
    legacyPath: options.legacyPath,
    recordCount: records.length,
    ids: records.map(record => record.id),
    ...(backupPath === undefined ? {} : { backupPath }),
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  exportLegacyWorkspaces(parseArgs(process.argv.slice(2))).then(
    result => { process.stdout.write(`${JSON.stringify(result)}\n`) },
    error => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    },
  )
}
