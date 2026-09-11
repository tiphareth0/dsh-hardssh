import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const dirs: string[] = []
const script = resolve(dirname(fileURLToPath(import.meta.url)), '../../scripts/export-legacy-workspaces.mjs')

function run(args: string[]): Record<string, unknown> {
  const stdout = execFileSync(process.execPath, [script, ...args], { encoding: 'utf8' })
  return JSON.parse(stdout.trim()) as Record<string, unknown>
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('offline generic-to-legacy workspace export', () => {
  it('previews without writing and atomically exports only SSH records with identity preserved', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hardssh-rollback-'))
    dirs.push(dir)
    const genericPath = join(dir, 'workspaces', 'index.v1.json')
    const legacyPath = join(dir, 'legacy.json')
    mkdirSync(dirname(genericPath), { recursive: true })
    const ssh = {
      schemaVersion: 1,
      id: 'ssh-1',
      title: 'remote app',
      provider: { id: 'ssh', connectionRef: { id: 'prod', alias: 'prod' } },
      location: { kind: 'posix', root: '/srv/app' },
      anchor: { path: join(dir, 'anchor'), mode: 'managed' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    }
    const local = {
      schemaVersion: 1,
      id: 'local-1',
      title: 'local app',
      provider: { id: 'local' },
      location: { kind: 'native', root: dir },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    writeFileSync(genericPath, JSON.stringify([local, ssh]), { encoding: 'utf8', flag: 'wx' })

    const preview = run(['--generic', genericPath, '--legacy', legacyPath])
    expect(preview).toMatchObject({ mode: 'preview', recordCount: 1, ids: ['ssh-1'] })
    expect(existsSync(legacyPath)).toBe(false)

    const applied = run(['--generic', genericPath, '--legacy', legacyPath, '--apply'])
    expect(applied).toMatchObject({ mode: 'applied', recordCount: 1, ids: ['ssh-1'] })
    expect(JSON.parse(readFileSync(legacyPath, 'utf8'))).toEqual([{
      id: 'ssh-1',
      title: 'remote app',
      alias: 'prod',
      remoteRoot: '/srv/app',
      anchorPath: ssh.anchor.path,
      createdAt: ssh.createdAt,
    }])
  })

  it('backs up the previous legacy snapshot before replacement', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hardssh-rollback-backup-'))
    dirs.push(dir)
    const genericPath = join(dir, 'generic.json')
    const legacyPath = join(dir, 'legacy.json')
    writeFileSync(genericPath, JSON.stringify([{
      schemaVersion: 1,
      id: 'ssh-2',
      title: 'new',
      provider: { id: 'ssh', connectionRef: { id: 'host' } },
      location: { kind: 'posix', root: '/new' },
      anchor: { path: join(dir, 'anchor'), mode: 'managed' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }]), 'utf8')
    const oldBytes = '[{"id":"old"}]\n'
    writeFileSync(legacyPath, oldBytes, 'utf8')

    const applied = run(['--generic', genericPath, '--legacy', legacyPath, '--apply'])
    const backupPath = String(applied.backupPath)
    expect(backupPath).toContain(`${legacyPath}.backup-`)
    expect(readFileSync(backupPath, 'utf8')).toBe(oldBytes)
    expect(JSON.parse(readFileSync(legacyPath, 'utf8'))[0].id).toBe('ssh-2')
  })
})
