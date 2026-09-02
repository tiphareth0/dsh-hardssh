/**
 * Standalone build config for the dsh-hardssh plugin.
 *
 * Uses the repo's shared client-bundle preset (shared/tsdown.client.ts):
 * node-half lib/ (host mode store + routes + tools) plus the browser bundle
 * lib/client.js (closure-factory artifact for the GUI's __ModuleLoader__,
 * CSS Modules inlined with auto-injected <style data-plugin>). The client
 * entry is auto-detected at src/client/index.ts by the preset.
 *
 * The host half owns the SSH engine/store internally (src/ssh/ — merged from
 * the legacy dsh-ssh package); ssh2/ws stay external install
 * dependencies resolved from package.json at runtime.
 */
import { clientBundle } from '../../shared/tsdown.client.ts'

export default clientBundle('@tiphareth/dsh-hardssh', ['src/index.ts', 'src/fs.ts', 'src/subprocess.ts'], {
  libExternal: [
    '@deepseek-ai/dsh-host-webserver',
    '@deepseek-ai/dsh-settings',
    '@deepseek-ai/schemastery',
    '@deepseek-ai/dsh-system-prompt',
    '@deepseek-ai/dsh-tools',
  ],
})