/**
 * Per-host command policy: what a host must never run, plus the message shown
 * when a command is refused. Two complementary mechanisms, both driven by the
 * same config field set (P1-F/guard):
 *
 *   `deny`          one regular expression per line, matched case-insensitively
 *                   against the whole command line (command-position anchoring
 *                   lets operators allow e.g. `srun python …`);
 *   `denyCommands`  command NAMES that are denied after unwrapping: leading
 *                   `FOO=bar` assignments and wrapper keywords
 *                   (`sudo`/`env`/`time`/`bash -c "python …"`/…) are peeled, a
 *                   path prefix is stripped to the basename, then the name is
 *                   matched against `denyCommands`/`allowCommands`. This is the
 *                   mechanism that catches `bash -c 'python …'` / `sudo python …`
 *                   which a pure text regex cannot reliably see.
 *
 * One policy per host entry, consumed by TWO enforcement points so both the
 * agent-driven paths and any plugin that spawns directly are covered:
 *
 *   tool layer    `ctx.tools.guard()` — ssh_exec / ssh_cluster / bash, where the
 *                 session cwd resolves to the bound host alias;
 *   seam layer    `SshSubprocessRuntime.spawn()` — every `ctx.subprocess`
 *                 consumer, matched on argv[0]'s basename and on the joined argv.
 *
 * Default is NO interception: a host with no `commandPolicy` field, or one with
 * empty `deny` and empty `denyCommands`, refuses nothing.
 *
 * This is a GUARDRAIL, not a sandbox: `$(…)`, base64, or a script that calls
 * the tool later all evade it. Hard enforcement belongs on the server (Slurm
 * limits, pam_slurm_adopt, a PATH shim). The point here is to stop accidental
 * login-node compute and teach the srun/sbatch path.
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
  /**
   * Command basenames denied after unwrap (e.g. `python`, `python3`, `Rscript`).
   * `bash -c "python …"`, `sudo -u me python …`, `/usr/bin/python3 …` and
   * leading `FOO=bar` assignments are resolved to the effective name first.
   * Blank entries and `#` lines are ignored.
   */
  denyCommands?: string[]
  /** Basenames that override a `denyCommands` entry (specific exceptions). */
  allowCommands?: string[]
  /** Operator message appended to every refusal (how to run it properly). */
  hint?: string
}

/** Longest accepted regex source / hint / command name (defensive bounds). */
const MAX_PATTERN_LENGTH = 512
const MAX_HINT_LENGTH = 1024
const MAX_DENY_ENTRIES = 64
const MAX_NAME_LENGTH = 64
const MAX_NAME_ENTRIES = 128

/** Tokens that prefix the real command without changing its nature. */
const WRAPPERS = new Set(['sudo', 'env', 'time', 'timeout', 'nohup', 'setsid', 'nice', 'exec', 'eval', 'bash', 'sh', 'zsh', 'ksh', 'dash', 'xargs', 'command'])

/** Short flags that take one value (used to skip `sudo -u foo` style arguments). */
const VALUE_FLAGS = new Set(['-u', '-g', '-p', '-n', '-c', '-C', '-D', '-H', '-S', '-r', '-t', '-i', '-l', '-s', '-E', '-e'])

/** Split a command line into independent command segments (`&& || ; |` + newlines). */
export function segmentCommands(command: string): string[] {
  return command
    .split(/\n|&&|\|\||;|\|/)
    .map(segment => segment.trim())
    .filter(segment => segment.length > 0)
}

/**
 * The effective command basename of one segment: unwraps `bash -c "python …"`
 * quoting, skips leading environment assignments and wrapper keywords (and
 * their flag arguments), then strips a path prefix.
 *
 * @returns the basename, or undefined when the segment names no command.
 */
export function commandName(segment: string): string | undefined {
  let rest = segment.trim()
  // Unwrap shell -c quoting first (bash -c "python x.py" / sh -c 'Rscript a.R').
  const shellC = /^(bash|sh|zsh|ksh|dash)\s+-c\s+(.*)$/.exec(rest)
  if (shellC !== null) {
    const payload = shellC[2]!.trim()
    const quoted = /^(["'])([\s\S]*)\1$/.exec(payload)
    rest = quoted === null ? payload.replace(/^["']+|["']+$/g, '') : quoted[2]!
  }
  const tokens = rest.split(/\s+/).filter(token => token.length > 0)
  for (let index = 0; index < tokens.length && index < 16; index += 1) {
    const token = tokens[index]!
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue // env assignment
    if (WRAPPERS.has(token)) {
      index += 1
      while (index < tokens.length && tokens[index]!.startsWith('-')) {
        const flag = tokens[index]!
        index += 1
        if (VALUE_FLAGS.has(flag)) index += 1 // consume the flag's value
      }
      index -= 1
      continue
    }
    return token.replace(/^.*\//, '')
  }
  return undefined
}

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

/** Command names the preset denies after unwrap (`bash -c python …` included). */
export const LOGIN_NODE_DENY_COMMANDS: readonly string[] = [
  'python', 'python2', 'python3', 'ipython',
  'matlab', 'octave', 'R', 'Rscript', 'julia', 'perl', 'scilab',
]

/** A ready-made login-node policy (patterns + names + the Slurm hint). */
export const LOGIN_NODE_PRESET: SshCommandPolicy = {
  deny: [...LOGIN_NODE_PATTERNS],
  denyCommands: [...LOGIN_NODE_DENY_COMMANDS],
  hint: '这是登录节点，禁止直接计算。请用 srun/sbatch 提交到计算节点，例如：srun -p gpu python train.py',
}

/** Validate a name-list field (denyCommands / allowCommands). */
function validateNameList(name: 'denyCommands' | 'allowCommands', value: unknown): string | undefined {
  if (!Array.isArray(value)) return `commandPolicy.${name} must be an array of command names`
  if (value.length > MAX_NAME_ENTRIES) return `commandPolicy.${name} accepts at most ${MAX_NAME_ENTRIES} entries`
  for (const entry of value) {
    if (typeof entry !== 'string') return `commandPolicy.${name} must be an array of command names`
    const token = entry.trim()
    if (token === '') return `commandPolicy.${name} entries must be non-empty command names`
    if (token.length > MAX_NAME_LENGTH) return `commandPolicy.${name} entries must be at most ${MAX_NAME_LENGTH} characters`
    if (/[\s/]/.test(token) || token.startsWith('#')) {
      return `commandPolicy.${name} entry is not a plain command name (no spaces/slashes, no '# comments'): ${token}`
    }
  }
  return undefined
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
  if (p.denyCommands !== undefined) {
    const error = validateNameList('denyCommands', p.denyCommands)
    if (error !== undefined) return error
  }
  if (p.allowCommands !== undefined) {
    const error = validateNameList('allowCommands', p.allowCommands)
    if (error !== undefined) return error
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

/** Normalize one configured command name (trim; `#`/blank lines skipped by compile). */
function normalizeName(entry: string): string | undefined {
  const token = entry.trim()
  return token === '' || token.startsWith('#') ? undefined : token
}

/** A host's rules, compiled once and reusable by both enforcement points. */
export class CompiledCommandPolicy {
  private constructor(
    private readonly rules: readonly DenyRule[],
    private readonly denyNames: ReadonlySet<string>,
    private readonly allowNames: ReadonlySet<string>,
    private readonly hint: string | undefined,
  ) {}

  /** True when this policy can never refuse anything. */
  get isEmpty(): boolean {
    return this.rules.length === 0 && this.denyNames.size === 0
  }

  /**
   * Check one command line for one host.
   * @returns the refusal message, or undefined when the command is allowed.
   */
  check(alias: string, command: string): string | undefined {
    // 1) Command-name rule (unwraps bash -c / sudo / env / paths).
    if (this.denyNames.size > 0) {
      for (const segment of segmentCommands(command)) {
        const name = commandName(segment)
        if (name === undefined) continue
        if (this.allowNames.has(name)) continue
        if (this.denyNames.has(name)) {
          return nameRefusalMessage(alias, name, this.hint)
        }
      }
    }
    // 2) Regex rule (command-text matching).
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
    const denyNames = new Set<string>()
    for (const entry of policy?.denyCommands ?? []) {
      const token = normalizeName(entry)
      if (token !== undefined) denyNames.add(token)
    }
    const allowNames = new Set<string>()
    for (const entry of policy?.allowCommands ?? []) {
      const token = normalizeName(entry)
      if (token !== undefined) allowNames.add(token)
    }
    return new CompiledCommandPolicy(rules, denyNames, allowNames, hint)
  }
}

/** The refusal text for a regex rule. */
export function refusalMessage(alias: string, pattern: string, hint: string | undefined): string {
  return [
    `dsh-hardssh: 已阻止在 ${alias} 上执行该命令（命中该主机的禁止规则 /${pattern}/）。`,
    hint === undefined || hint.trim() === ''
      ? '如需调整，请修改该主机的命令策略（commandPolicy）。'
      : hint.trim(),
  ].join('\n')
}

/** The refusal text for a denied command name. */
export function nameRefusalMessage(alias: string, name: string, hint: string | undefined): string {
  return [
    `dsh-hardssh: 已阻止在 ${alias} 上执行该命令（命中该主机的禁止命令 "${name}"）。`,
    hint === undefined || hint.trim() === ''
      ? '如需调整，请修改该主机的命令策略（commandPolicy）。'
      : hint.trim(),
  ].join('\n')
}

/** Convenience for callers that only have the stored shape. */
export function checkCommand(alias: string, command: string, policy: SshCommandPolicy | undefined): string | undefined {
  return CompiledCommandPolicy.compile(policy).check(alias, command)
}

/** How the tool-layer guard resolves the (alias, command) pairs of one call. */
export interface CommandGuardLookup {
  /** Every configured alias (for `ssh_cluster` without an explicit list). */
  allAliases(): readonly string[]
  /** Alias owning a session cwd (a bound SSH workspace), for `bash`. */
  aliasForCwd(cwd: string | undefined): string | undefined
}

/**
 * Map one tool execution to the (alias, command) pairs the guard must check,
 * or `undefined` when the call cannot carry a remote command.
 *
 * Covers the three remote-command channels:
 *  - `ssh_exec`    → the explicitly named alias + its command;
 *  - `ssh_cluster` → the explicit alias list, or EVERY host when absent;
 *  - `bash`        → the alias bound to the calling session's cwd.
 * Every other tool is not a remote-command channel and returns `undefined`.
 */
export function commandGuardTargets(
  toolName: string,
  args: Readonly<Record<string, unknown>> | undefined,
  cwd: string | undefined,
  lookup: CommandGuardLookup,
): Array<{ alias: string; command: string }> | undefined {
  const command = typeof args?.command === 'string' ? args.command : undefined
  if (command === undefined) return undefined
  if (toolName === 'ssh_exec') {
    const alias = args?.alias
    return typeof alias === 'string' && alias !== '' ? [{ alias, command }] : undefined
  }
  if (toolName === 'ssh_cluster') {
    const explicit = args?.aliases
    const aliases = Array.isArray(explicit)
      ? (explicit as unknown[]).filter((entry): entry is string => typeof entry === 'string' && entry !== '')
      : [...lookup.allAliases()]
    return aliases.map(alias => ({ alias, command }))
  }
  if (toolName === 'bash') {
    const alias = lookup.aliasForCwd(cwd)
    return alias === undefined ? undefined : [{ alias, command }]
  }
  return undefined
}
