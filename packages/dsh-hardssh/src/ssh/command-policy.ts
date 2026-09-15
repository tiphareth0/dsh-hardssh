/**
 * Per-host command policy: the regex list a host must never run, plus the
 * message shown when a command is refused (P1-F/guard).
 *
 * One policy per host entry, consumed by TWO enforcement points so both the
 * agent-driven paths and any plugin that spawns directly are covered:
 *
 *   tool layer    `ctx.tools.guard()` — ssh_exec / ssh_cluster / bash, where the
 *                 session cwd resolves to the bound host alias;
 *   seam layer    `SshSubprocessRuntime.spawn()` — every `ctx.subprocess`
 *                 consumer, matched on argv[0]'s basename and on the joined argv.
 *
 * This is a GUARDRAIL, not a sandbox: shell quoting, `$(…)`, base64 or a script
 * that calls the tool later all evade a command-line regex. Hard enforcement
 * belongs on the server (Slurm limits, pam_slurm_adopt, a PATH shim). The point
 * here is to stop accidental login-node compute and teach the srun/sbatch path.
 *
 * @module dsh-hardssh/ssh/command-policy
 */

/** Stored policy shape (one entry per host, all fields optional). */
export interface SshCommandPolicy {
  /**
   * One regular expression per line/entry, matched case-insensitively against
   * the command line. An entry that is blank or starts with `#` is ignored.
   */
  deny: string[]
  /** Operator message appended to every refusal (how to run it properly). */
  hint?: string
}

/** Longest accepted regex source / hint (defensive bounds on stored config). */
const MAX_PATTERN_LENGTH = 512
const MAX_HINT_LENGTH = 1024
const MAX_DENY_ENTRIES = 64

/**
 * Recommended deny patterns for a Slurm login node (paste into a host's policy
 * or use {@link LOGIN_NODE_PRESET}).
 *
 * The anchor matters: a leading `(^|[;&|(])` plus optional spaces (and an
 * optional directory prefix) matches an interpreter only at a COMMAND position,
 * so `srun -p gpu python train.py` stays allowed while `cd x && python y.py` is
 * refused. A bare whitespace prefix would wrongly refuse the `srun` form.
 */
export const LOGIN_NODE_PATTERNS: readonly string[] = [
  '(^|[;&|(])\\s*(?:\\S*/)?(python[0-9.]*|ipython|Rscript|R|julia|matlab)(\\s|$)',
  '(^|[;&|(])\\s*(?:\\S*/)?(pip|conda|mamba)\\s+(install|run)',
]

/** A ready-made login-node policy (patterns above plus the Slurm hint). */
export const LOGIN_NODE_PRESET: SshCommandPolicy = {
  deny: [...LOGIN_NODE_PATTERNS],
  hint: '这是登录节点，禁止直接计算。请用 srun/sbatch 提交到计算节点，例如：srun -p gpu python train.py',
}

/**
 * Validate a stored policy (also used by the host store on create/update).
 * @returns an operator-readable message, or undefined when the shape is usable.
 */
export function validateCommandPolicy(policy: unknown): string | undefined {
  if (policy === undefined) return undefined
  if (typeof policy !== 'object' || policy === null) return 'commandPolicy must be an object'
  const p = policy as Record<string, unknown>
  if (p.deny !== undefined && !Array.isArray(p.deny)) return 'commandPolicy.deny must be an array of regex strings'
  const deny = (p.deny ?? []) as unknown[]
  if (deny.length > MAX_DENY_ENTRIES) return `commandPolicy.deny accepts at most ${MAX_DENY_ENTRIES} entries`
  for (const entry of deny) {
    if (typeof entry !== 'string') return 'commandPolicy.deny must be an array of regex strings'
    if (entry.length > MAX_PATTERN_LENGTH) return `commandPolicy.deny entries must be at most ${MAX_PATTERN_LENGTH} characters`
    if (entry.trim() === '' || entry.trimStart().startsWith('#')) continue
    try {
      new RegExp(entry, 'i')
    } catch (error: unknown) {
      return `commandPolicy.deny entry is not a valid regular expression: ${entry} (${error instanceof Error ? error.message : String(error)})`
    }
  }
  if (p.hint !== undefined) {
    if (typeof p.hint !== 'string') return 'commandPolicy.hint must be a string'
    if (p.hint.length > MAX_HINT_LENGTH) return `commandPolicy.hint must be at most ${MAX_HINT_LENGTH} characters`
  }
  return undefined
}

/** One compiled deny rule. */
interface DenyRule {
  source: string
  regex: RegExp
}

/** A host's rules, compiled once and reusable by both enforcement points. */
export class CompiledCommandPolicy {
  private constructor(
    private readonly rules: readonly DenyRule[],
    private readonly hint: string | undefined,
  ) {}

  /** True when this policy can never refuse anything. */
  get isEmpty(): boolean {
    return this.rules.length === 0
  }

  /**
   * Check one command line for one host.
   * @returns the refusal message, or undefined when the command is allowed.
   */
  check(alias: string, command: string): string | undefined {
    for (const rule of this.rules) {
      if (!rule.regex.test(command)) continue
      return refusalMessage(alias, rule.source, this.hint)
    }
    return undefined
  }

  /** Compile a stored policy (blank/`#` entries ignored). */
  static compile(policy: SshCommandPolicy | undefined): CompiledCommandPolicy {
    const hint = policy?.hint?.trim() === '' ? undefined : policy?.hint
    const rules: DenyRule[] = []
    for (const entry of policy?.deny ?? []) {
      const source = entry.trim()
      if (source === '' || source.startsWith('#')) continue
      try {
        rules.push({ source, regex: new RegExp(source, 'i') })
      } catch {
        // Unreachable through the store (validated on write); a hand-edited
        // file must not disable every other rule, so skip just this one.
      }
    }
    return new CompiledCommandPolicy(rules, hint)
  }
}

/** The refusal text: what happened, which rule, and how to do it properly. */
export function refusalMessage(alias: string, pattern: string, hint: string | undefined): string {
  return [
    `dsh-hardssh: 已阻止在 ${alias} 上执行该命令（命中该主机的禁止规则 /${pattern}/）。`,
    hint === undefined || hint.trim() === ''
      ? '如需调整，请修改该主机的命令策略（commandPolicy）。'
      : hint.trim(),
  ].join('\n')
}

/** Convenience for callers that only have the stored shape. */
export function checkCommand(alias: string, command: string, policy: SshCommandPolicy | undefined): string | undefined {
  return CompiledCommandPolicy.compile(policy).check(alias, command)
}
