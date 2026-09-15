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

// The script runs only in an ephemeral CI checkout. Root overrides keep
// transitive DSH components on the same tested line; they are not committed to
// the release package and therefore cannot force a user's profile versions.
rootPackage.pnpm = {
  ...(rootPackage.pnpm ?? {}),
  overrides: {
    ...(rootPackage.pnpm?.overrides ?? {}),
    ...versions,
  },
}

fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8')
fs.writeFileSync(rootPackagePath, `${JSON.stringify(rootPackage, null, 2)}\n`, 'utf8')
console.log(`applied compatibility set '${manifest.name}' (${Object.keys(versions).length} package versions)`)
