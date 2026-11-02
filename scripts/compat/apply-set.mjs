import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const manifestArg = process.argv[2]
if (manifestArg === undefined) {
  console.error('usage: node scripts/compat/apply-set.mjs <compat-set.json>')
  process.exit(2)
}

const root = process.cwd()
const manifestPath = path.resolve(root, manifestArg)
const packagePath = path.join(root, 'packages', 'dsh-hardssh', 'package.json')
const rootPackagePath = path.join(root, 'package.json')

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
if (typeof manifest?.name !== 'string' || typeof manifest?.packages !== 'object' || manifest.packages === null) {
  throw new Error(`invalid compatibility manifest: ${manifestPath}`)
}
const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'))
const rootPackage = JSON.parse(fs.readFileSync(rootPackagePath, 'utf8'))
const versions = manifest.packages

const dshPeers = Object.keys(packageJson.peerDependencies ?? {})
  .filter(name => name.startsWith('@deepseek-ai/'))
const missing = dshPeers.filter(name => typeof versions[name] !== 'string')
if (missing.length > 0) {
  throw new Error(`compatibility set '${manifest.name}' omits peer(s): ${missing.join(', ')}`)
}

for (const [name, version] of Object.entries(versions)) {
  if (typeof version !== 'string' || version === '') throw new Error(`invalid version for '${name}'`)
  if (Object.hasOwn(packageJson.devDependencies ?? {}, name)) packageJson.devDependencies[name] = version
}

// The script runs only in an ephemeral CI checkout. Overrides keep transitive
// DSH components on the same tested line; they are not committed to the release
// package and therefore cannot force a user's profile versions.
//
// pnpm >= 10 reads `overrides` only from pnpm-workspace.yaml and IGNORES
// package.json's `pnpm` field (it logs a warning and drops the block), so the
// matrix used to install unpinned transitive components while claiming to pin
// them. The overrides therefore live in the workspace file.
const workspacePath = path.join(root, 'pnpm-workspace.yaml')
let workspace = fs.existsSync(workspacePath) ? fs.readFileSync(workspacePath, 'utf8') : ''
// Replace an existing overrides block (idempotent on repeated runs).
workspace = workspace.replace(/\noverrides:\n(?:[ \t]+[^\n]*\n?)*/u, '\n')
const overrideLines = Object.entries(versions)
  .map(([name, version]) => `  '${name}': ${version}`)
  .join('\n')
workspace = `${workspace.replace(/\n*$/u, '\n')}overrides:\n${overrideLines}\n`
fs.writeFileSync(workspacePath, workspace, 'utf8')

fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8')
fs.writeFileSync(rootPackagePath, `${JSON.stringify(rootPackage, null, 2)}\n`, 'utf8')
console.log(`applied compatibility set '${manifest.name}' (${Object.keys(versions).length} package versions)`)
