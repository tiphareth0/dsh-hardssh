/**
 * Glob matching for remote path searches (P1-D).
 *
 * `find -path` cannot express this dialect: GNU find's `-path` lets `*` cross
 * the `/` separator, so `**\/*.ts` silently missed depth-1 files and a single
 * `*` matched across directories. Both the shell backend and the SFTP fallback
 * therefore filter with ONE local matcher, so the two rungs of the search
 * ladder agree on what a pattern means.
 *
 * Dialect (the same one the DSH file tools use):
 *   - `*`  matches any run of characters except `/`
 *   - `?`  matches one character except `/`
 *   - `**` crosses directories; `**\/` may also match zero directories
 *   - `[abc]`, `[!abc]` / `[^abc]` character classes
 * Any other character is literal.
 */

/** Escape one literal character for a RegExp source. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Convert a glob pattern (root-relative, `/`-separated) into an anchored RegExp. */
export function globToRegExp(pattern: string): RegExp {
  let source = '^'
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        index += 1
        // `**/` may match zero directory levels; a trailing `**` crosses anything.
        if (pattern[index + 1] === '/') {
          index += 1
          source += '(?:[^/]*/)*'
        } else {
          source += '.*'
        }
      } else {
        source += '[^/]*'
      }
      continue
    }
    if (char === '?') {
      source += '[^/]'
      continue
    }
    if (char === '[') {
      const end = pattern.indexOf(']', index + 1)
      if (end > index + 1) {
        const body = pattern.slice(index + 1, end).replace(/\\/g, '\\\\')
        source += `[${body.startsWith('!') ? `^${body.slice(1)}` : body}]`
        index = end
        continue
      }
    }
    source += escapeRegExp(char)
  }
  return new RegExp(`${source}$`)
}

/** True when the root-relative path matches the glob pattern. */
export function globMatches(pattern: string, relativePath: string): boolean {
  return globToRegExp(pattern).test(relativePath)
}

/**
 * The longest literal directory prefix of a pattern (used to start a shell
 * search deeper than the root instead of walking the whole tree).
 *
 * The segment holding the file name is never part of the anchor: `src/*.ts`
 * anchors at `src` (which is also fine for a directory hit), and `*.ts` or
 * `**\/*.ts` anchor at the root.
 */
export function globLiteralPrefix(pattern: string): string {
  const segments = pattern.replace(/^\/+/, '').split('/')
  const literal: string[] = []
  for (const segment of segments.slice(0, -1)) {
    if (segment === '' || segment === '.' || /[*?[\]]/.test(segment)) break
    literal.push(segment)
  }
  return literal.join('/')
}
