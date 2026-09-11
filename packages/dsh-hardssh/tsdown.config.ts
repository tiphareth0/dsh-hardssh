/**
 * Standalone build config for the dsh-hardssh plugin.
 *
 * Uses the in-package client-bundle preset (tsdown.client.ts):
 * node-half lib/ (host mode store + routes + tools) plus the browser bundle
 * lib/client.js (closure-factory artifact for the GUI's __ModuleLoader__,
 * CSS Modules inlined with auto-injected <style data-plugin>). The client
 * entry is auto-detected at src/client/index.ts by the preset.
 *
 * The host half owns the SSH engine/store internally (src/ssh/ — merged from
 * the legacy dsh-ssh package); ssh2/ws stay external install
 * dependencies resolved from package.json at runtime.
 */
import { clientBundle } from './tsdown.client.ts'

// Phase 6: the stable ./workspace public entry is a separate lib chunk (only
// types re-exported from internal modules), so third-party plugins can import
// it without pulling in the host-half index.js runtime.
// C-02: ./base is a REAL built entry (src/base/index.ts → lib/base/index.js)
// so the advertised reusable base is consumable through the package exports
// map instead of reaching into src/.
export default clientBundle('@tiphareth/dsh-hardssh', ['src/index.ts', 'src/fs.ts', 'src/subprocess.ts', 'src/workspace.ts', 'src/base/index.ts'], {
  libExternal: [
    '@deepseek-ai/dsh-host-webserver',
    '@deepseek-ai/dsh-settings',
    '@deepseek-ai/schemastery',
    '@deepseek-ai/dsh-system-prompt',
    '@deepseek-ai/dsh-tools',
  ],
})