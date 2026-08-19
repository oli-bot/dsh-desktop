import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronPackage = join(root, 'node_modules', 'electron')
const electronBinary = join(electronPackage, 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
if (!existsSync(electronBinary)) {
  const installResult = spawnSync(process.execPath, [join(electronPackage, 'install.js')], {
    cwd: root,
    stdio: 'inherit',
  })
  if (installResult.error !== undefined) throw installResult.error
  if (installResult.status !== 0) process.exit(installResult.status ?? 1)
}

const icon = join(root, 'assets', 'DeepWork.icns')
if (!existsSync(icon)) {
  const iconResult = spawnSync('sh', [join(root, 'scripts', 'generate-icon.sh')], {
    cwd: root,
    stdio: 'inherit',
  })
  if (iconResult.error !== undefined) throw iconResult.error
  if (iconResult.status !== 0) process.exit(iconResult.status ?? 1)
}

// electron-builder CLI JS entry: spawning node_modules/.bin/electron-builder
// breaks on Windows (Node only appends .exe when resolving PATH names, and
// the .bin shim there is extensionless); `node <cli.js>` is identical on
// every platform.
const builder = join(root, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js')
const arch = process.env.DEEPWORK_MAC_ARCH ?? 'arm64'
// electron-builder MERGES CLI arch flags with the arch lists in the build
// config, so `--mac --x64` beside a config `mac.target` arch:[arm64] would
// package BOTH arches. afterPack stages a single runtime flavor, so the other
// arch would silently get the wrong node binary. Pin the target arch in
// package.json for this run and restore it afterwards.
const pkgPath = join(root, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const savedMacTarget = pkg.build.mac.target
pkg.build.mac.target = [
  { target: 'dmg', arch: [arch] },
  { target: 'zip', arch: [arch] },
]
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
// `--publish never`: artifacts are attached to the GitHub Release by the
// release workflow (softprops/action-gh-release); letting electron-builder
// publish on CI would require a GH_TOKEN and fails without one.
try {
  const result = spawnSync(process.execPath, [builder, '--mac', '--publish', 'never'], {
    cwd: root,
    env: {
      ...process.env,
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    },
    stdio: 'inherit',
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
} finally {
  pkg.build.mac.target = savedMacTarget
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
}
