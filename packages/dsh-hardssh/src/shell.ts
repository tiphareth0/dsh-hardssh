/**
 * Canonical POSIX shell single-quoting for remote command construction.
 * Replaces the three near-identical copies that used to live in backend.ts,
 * tools.ts and remote/environment.ts.
 */

/** Quote one argument for a POSIX login shell (single-quote, `'\''` for embedded quotes). */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
