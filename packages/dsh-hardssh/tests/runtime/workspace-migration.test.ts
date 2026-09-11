/** Focused Phase 3 conversion and read-only shadow comparison tests. */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { WorkspaceRecord } from '../../src/base/model.ts'
import type { SshWorkspaceRecord } from '../../src/protocol.ts'
import {
  compareWorkspaceShadow,
  legacySshRecordToWorkspaceRecord,
  migrateLegacySshLedger,
} from '../../src/runtime/workspace-migration.ts'

/** legacySshRecordToWorkspaceRecord() maps an existing source and cannot create isolated legacy test fixtures. */
function legacyRecord(id: string, anchorPath: string): SshWorkspaceRecord {
  return {
    id,
    title: `workspace ${id}`,
    alias: `host-${id}`,
    remoteRoot: `/srv/${id}`,
    anchorPath,
    createdAt: '2025-01-02T03:04:05.000Z',
  }
}

describe('workspace migration foundations', () => {
  it('preserves legacy fields, retains non-SSH records, backs up, reports, and is idempotent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'workspace-migration-'))
    const legacyPath = join(dir, 'legacy.json')
    const genericPath = join(dir, 'generic.json')
    const reportPath = join(dir, 'migration-report.json')
    const legacy = [legacyRecord('ssh-1', join(dir, 'ssh-anchor'))]
    const local: WorkspaceRecord = {
      schemaVersion: 1,
      id: 'local-1',
      title: 'local',
      provider: { id: 'local' },
      location: { kind: 'native', root: join(dir, 'local-root') },
      anchor: { path: join(dir, 'local-anchor'), mode: 'existing' },
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    }
    writeFileSync(legacyPath, JSON.stringify(legacy), 'utf8')
    writeFileSync(genericPath, JSON.stringify([local]), 'utf8')
    const before = readFileSync(genericPath, 'utf8')

    const first = await migrateLegacySshLedger({
      mode: 'generic',
      legacyPath,
      genericPath,
      reportPath,
      now: () => new Date('2026-02-03T04:05:06.000Z'),
    })
    expect(first.status).toBe('migrated')
    expect(first.backupPath).toBeDefined()
    expect(readFileSync(first.backupPath!, 'utf8')).toBe(before)
    expect(JSON.parse(readFileSync(reportPath, 'utf8'))).toMatchObject({ status: 'migrated', recordCount: 1 })
    const records = JSON.parse(readFileSync(genericPath, 'utf8')) as WorkspaceRecord[]
    expect(records.map(record => record.id).sort()).toEqual(['local-1', 'ssh-1'])
    expect(records.find(record => record.id === 'ssh-1')).toEqual(legacySshRecordToWorkspaceRecord(legacy[0]!))

    const second = await migrateLegacySshLedger({ mode: 'generic', legacyPath, genericPath })
    expect(second.status).toBe('unchanged')
    expect(second.backupPath).toBeUndefined()
  })

  it('aborts same-id conflicts without touching the target', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'workspace-migration-conflict-'))
    const legacyPath = join(dir, 'legacy.json')
    const genericPath = join(dir, 'generic.json')
    const source = legacyRecord('same', join(dir, 'anchor'))
    const conflicting = { ...legacySshRecordToWorkspaceRecord(source), title: 'different' }
    writeFileSync(legacyPath, JSON.stringify([source]), 'utf8')
    writeFileSync(genericPath, JSON.stringify([conflicting]), 'utf8')
    const before = readFileSync(genericPath, 'utf8')
    await expect(migrateLegacySshLedger({ mode: 'generic', legacyPath, genericPath })).rejects.toThrow("conflict for id 'same'")
    expect(readFileSync(genericPath, 'utf8')).toBe(before)
  })

  it('rejects malformed legacy input instead of treating it as empty', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'workspace-migration-malformed-'))
    const legacyPath = join(dir, 'legacy.json')
    writeFileSync(legacyPath, '{bad', 'utf8')
    await expect(migrateLegacySshLedger({ mode: 'generic', legacyPath, genericPath: join(dir, 'generic.json') })).rejects.toThrow()
  })

  it('compares records, routes, namespaces, and capability declarations without capability objects', () => {
    const dir = mkdtempSync(join(tmpdir(), 'workspace-shadow-'))
    mkdirSync(join(dir, 'anchor'), { recursive: true })
    const legacy = [legacyRecord('ssh-1', join(dir, 'anchor'))]
    const generic = [legacySshRecordToWorkspaceRecord(legacy[0]!)]
    const matching = compareWorkspaceShadow({
      legacy,
      generic,
      anchorProbes: [join(dir, 'anchor', 'src')],
      namespaceProbes: ['wfs://ssh-1/src', 'wfs://stale/src', 'wfs://%ZZ/src'],
      capabilities: [{ providerId: 'ssh', manifestCapabilities: ['workspace.fs'], availableCapabilities: ['workspace.fs'] }],
    })
    expect(matching).toEqual({ matches: true, differences: [] })

    const differing = compareWorkspaceShadow({
      legacy,
      generic: [{ ...generic[0]!, title: 'changed' }],
      capabilities: [{ providerId: 'ssh', manifestCapabilities: ['workspace.fs'], availableCapabilities: [] }],
    })
    expect(differing.matches).toBe(false)
    expect(differing.differences).toEqual(expect.arrayContaining([
      expect.stringContaining('title'),
      expect.stringContaining('capability'),
    ]))
  })
})
