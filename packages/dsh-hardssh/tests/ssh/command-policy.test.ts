/**
 * Per-host command policy (guardrail): the matching rules operators configure
 * per server so an agent cannot accidentally compute on a login node.
 *
 * Both enforcement points consume this one module, so the rule text and the
 * refusal message can never drift between the tool layer and the seam layer.
 */

import { describe, expect, it } from 'vitest'
import {
  CompiledCommandPolicy,
  LOGIN_NODE_PRESET,
  checkCommand,
  commandGuardTargets,
  refusalMessage,
  validateCommandPolicy,
} from '../../src/ssh/command-policy.ts'

/** The login-node case: no direct compute, submit through Slurm instead. */
const LOGIN_NODE = {
  deny: ['# 登录节点禁止直接计算', ...LOGIN_NODE_PRESET.deny],
  hint: LOGIN_NODE_PRESET.hint,
}

describe('command policy validation', () => {
  it('accepts the stored shape, blank lines and comments', () => {
    expect(validateCommandPolicy(undefined)).toBeUndefined()
    expect(validateCommandPolicy(LOGIN_NODE)).toBeUndefined()
    expect(validateCommandPolicy({ deny: ['', '   ', '# note', 'python'] })).toBeUndefined()
  })

  it('rejects malformed shapes with an operator-readable message', () => {
    expect(validateCommandPolicy('nope')).toMatch(/must be an object/)
    expect(validateCommandPolicy({ deny: 'python' })).toMatch(/array of regex strings/)
    expect(validateCommandPolicy({ deny: [1] })).toMatch(/array of regex strings/)
    expect(validateCommandPolicy({ deny: ['python('] })).toMatch(/not a valid regular expression/)
    expect(validateCommandPolicy({ deny: ['x'.repeat(600)] })).toMatch(/at most 512/)
    expect(validateCommandPolicy({ deny: [], hint: 42 })).toMatch(/hint must be a string/)
    expect(validateCommandPolicy({ deny: Array.from({ length: 65 }, () => 'a') })).toMatch(/at most 64/)
  })
})

describe('command policy matching', () => {
  it('refuses the denied interpreters wherever they start a command', () => {
    const policy = CompiledCommandPolicy.compile(LOGIN_NODE)
    expect(policy.check('login-node', 'python train.py')).toMatch(/已阻止在 login-node/)
    expect(policy.check('login-node', 'cd /data && python -c "import torch"')).toBeDefined()
    expect(policy.check('login-node', 'echo hi; python3 x.py')).toBeDefined()
    expect(policy.check('login-node', 'Rscript plot.R')).toBeDefined()
    expect(policy.check('login-node', 'conda install numpy')).toBeDefined()
    // Case-insensitive, and the pattern anchors on a command position.
    expect(policy.check('login-node', 'PYTHON x.py')).toBeDefined()
  })

  it('allows the Slurm path and everything unrelated', () => {
    const policy = CompiledCommandPolicy.compile(LOGIN_NODE)
    expect(policy.check('login-node', 'srun -p gpu python train.py')).toBeUndefined()
    expect(policy.check('login-node', 'sbatch run.sh')).toBeUndefined()
    expect(policy.check('login-node', 'squeue -u alice')).toBeUndefined()
    expect(policy.check('login-node', 'ls -la && git status')).toBeUndefined()
    expect(policy.check('login-node', 'grep -rn python .')).toBeUndefined()
  })

  it('carries the operator hint into the refusal message', () => {
    const message = CompiledCommandPolicy.compile(LOGIN_NODE).check('login-node', 'python x.py') ?? ''
    expect(message).toContain('命中该主机的禁止规则')
    expect(message).toContain('srun -p gpu python train.py')
    // Without a hint the message still says how to fix it.
    const bare = refusalMessage('host1', 'rm -rf', undefined)
    expect(bare).toContain('commandPolicy')
    expect(bare).toContain('host1')
  })

  it('is a no-op for a host without a policy, and for a blank policy', () => {
    expect(checkCommand('plain', 'python x.py', undefined)).toBeUndefined()
    expect(CompiledCommandPolicy.compile({ deny: [] }).isEmpty).toBe(true)
    expect(CompiledCommandPolicy.compile({ deny: ['', '# only comments'] }).isEmpty).toBe(true)
    expect(checkCommand('plain', 'python x.py', { deny: [] })).toBeUndefined()
  })

  it('skips a hand-edited invalid rule instead of disabling the whole policy', () => {
    // The store rejects these on write; a hand-edited file must still enforce
    // every rule that does compile.
    const policy = CompiledCommandPolicy.compile({ deny: ['python(', 'rm -rf /'] })
    expect(policy.check('host', 'python x.py')).toBeUndefined()
    expect(policy.check('host', 'rm -rf /data')).toMatch(/已阻止/)
  })

  it('matches the seam-layer shape too (argv joined by spaces)', () => {
    const policy = CompiledCommandPolicy.compile(LOGIN_NODE)
    // SshSubprocessRuntime.spawn checks basename + joined argv, so an argv
    // spawn of python is refused the same way a shell line is.
    expect(policy.check('login-node', '/usr/bin/python3 -u train.py')).toBeDefined()
    expect(policy.check('login-node', 'srun python train.py')).toBeUndefined()
  })
})

describe('commandGuardTargets (tool-layer mapping)', () => {
  const lookup = {
    allAliases: () => ['a', 'b'],
    aliasForCwd: (cwd: string | undefined) => (cwd === '/anchor/ws-1' ? 'a' : undefined),
  }

  it('maps ssh_exec to its named alias', () => {
    expect(commandGuardTargets('ssh_exec', { alias: 'a', command: 'python x' }, undefined, lookup))
      .toEqual([{ alias: 'a', command: 'python x' }])
    // A missing/empty alias is not a guardable target.
    expect(commandGuardTargets('ssh_exec', { command: 'x' }, undefined, lookup)).toBeUndefined()
  })

  it('maps ssh_cluster to its explicit list or every host', () => {
    expect(commandGuardTargets('ssh_cluster', { aliases: ['a'], command: 'Rscript x' }, undefined, lookup))
      .toEqual([{ alias: 'a', command: 'Rscript x' }])
    expect(commandGuardTargets('ssh_cluster', { command: 'Rscript x' }, undefined, lookup))
      .toEqual([{ alias: 'a', command: 'Rscript x' }, { alias: 'b', command: 'Rscript x' }])
  })

  it('maps bash to the session-bound alias', () => {
    expect(commandGuardTargets('bash', { command: 'python x' }, '/anchor/ws-1', lookup))
      .toEqual([{ alias: 'a', command: 'python x' }])
    expect(commandGuardTargets('bash', { command: 'python x' }, '/local', lookup)).toBeUndefined()
  })

  it('does not treat other tools as command channels', () => {
    expect(commandGuardTargets('ssh_upload', { command: 'x' }, undefined, lookup)).toBeUndefined()
    expect(commandGuardTargets('ssh_exec', { alias: 'a' }, undefined, lookup)).toBeUndefined()
  })
})
