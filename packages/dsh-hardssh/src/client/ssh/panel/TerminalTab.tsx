/**
 * Terminal tab: an xterm.js PTY view over the host's WebSocket terminal route.
 * The target alias is inherited from the selected Session; only connect /
 * disconnect controls remain. The terminal container is sized by FitAddon
 * (default 80x24 before first fit). On remote exit the last
 * output stays visible and input is disabled. xterm's stylesheet is injected
 * once per page load (module-level guard).
 */
import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { SshApi, TerminalConnection } from '../api.ts'
import { XTERM_CSS } from './xterm.css.ts'
import { tt } from './helpers.ts'
import css from './panel.module.css'

/** Terminal tab props. */
export interface TerminalTabProps {
  api: SshApi
  /** Fixed alias inherited from the selected Session's SSH workspace. */
  alias: string
}

/** The terminal session lifecycle state shown in the status banner. */
type TerminalStatus =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'connected'; alias: string }
  | { kind: 'exited'; alias: string; detail?: string }
  | { kind: 'error'; detail: string }

/** Injected-once guard for the xterm stylesheet (one tag per page load). */
let xtermCssInjected = false

function ensureXtermCss(): void {
  if (xtermCssInjected || typeof document === 'undefined') return
  xtermCssInjected = true
  if (document.querySelector('style[data-dsh-ssh-xterm]') !== null) return
  const style = document.createElement('style')
  style.dataset.dshSshXterm = ''
  style.textContent = XTERM_CSS
  document.head.appendChild(style)
}

/** The xterm terminal view. */
export function TerminalTab({ api, alias }: TerminalTabProps) {
  const [status, setStatus] = useState<TerminalStatus>({ kind: 'idle' })
  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const connRef = useRef<TerminalConnection | null>(null)

  useEffect(() => { ensureXtermCss() }, [])

  const teardown = (): void => {
    const connection = connRef.current
    connRef.current = null
    if (connection !== null) {
      connection.onReady = undefined
      connection.onOutput = undefined
      connection.onExit = undefined
      connection.close()
    }
    termRef.current?.dispose()
    termRef.current = null
    fitRef.current = null
  }

  // Unmount cleanup (never touches state on an unmounting component).
  useEffect(() => () => { teardown() }, [])

  // Keep the terminal fitted to its container while connected.
  useEffect(() => {
    const onResize = (): void => {
      const term = termRef.current
      const fit = fitRef.current
      if (term === null || fit === null) return
      fit.fit()
      connRef.current?.resize(term.cols, term.rows)
    }
    window.addEventListener('resize', onResize)
    return () => { window.removeEventListener('resize', onResize) }
  }, [])

  const connect = (): void => {
    const target = alias
    const container = containerRef.current
    if (target === '' || container === null) return
    if (status.kind === 'connecting' || status.kind === 'connected') return
    teardown()
    setStatus({ kind: 'connecting' })
    const term = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Menlo, Consolas, "Liberation Mono", monospace',
      theme: { background: '#0b0e14', foreground: '#d8dee9', cursor: '#a3b8d0' },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    fit.fit()
    // The WebSocket can be OPEN before the remote shell exists. Keep xterm
    // input disabled until the protocol's ready frame; the API also keeps a
    // bounded pre-ready queue as a defensive race buffer.
    term.options.disableStdin = true
    const connection = api.openTerminal(target, term.cols, term.rows)
    termRef.current = term
    fitRef.current = fit
    connRef.current = connection
    let settled = false
    const dataSub = term.onData(data => { connection.send(data) })
    connection.onReady = () => {
      term.options.disableStdin = false
      setStatus({ kind: 'connected', alias: target })
    }
    connection.onOutput = data => { term.write(data) }
    connection.onExit = (code, error) => {
      if (settled) return
      settled = true
      dataSub.dispose()
      term.options.disableStdin = true
      connRef.current = null
      // Keep the last output visible; input is now disabled.
      setStatus({ kind: 'exited', alias: target, detail: error })
    }
  }

  const disconnect = (): void => {
    teardown()
    setStatus({ kind: 'idle' })
  }

  const active = status.kind === 'connecting' || status.kind === 'connected'

  return (
    <div className={css.termBody}>
      <div className={css.controls}>
        <span className={css.targetBadge}>{alias}</span>
        <button type="button" className={css.primaryButton} disabled={active} onClick={connect}>{tt('terminal.connect')}</button>
        <button type="button" className={css.ghostButton} disabled={!active} onClick={disconnect}>{tt('terminal.disconnect')}</button>
      </div>
      {status.kind === 'connecting' && <div className={css.banner} data-kind="info">{tt('terminal.connecting')}</div>}
      {status.kind === 'connected' && <div className={css.banner} data-kind="ok">{tt('terminal.ready', { alias: status.alias })}</div>}
      {status.kind === 'exited' && (
        <div className={css.banner} data-kind="info">{tt('terminal.exited', { alias: status.alias })}{status.detail !== undefined ? ' (' + status.detail + ')' : ''}</div>
      )}
      {status.kind === 'error' && <div className={css.banner} data-kind="error">{tt('terminal.error', { error: status.detail })}</div>}
      <div className={css.termWrap}>
        <div ref={containerRef} className={css.termContainer} />
        {status.kind === 'idle' && (
          <div className={css.termPlaceholder}>{tt('terminal.placeholder')}</div>
        )}
      </div>
    </div>
  )
}
