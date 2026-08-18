import { spawnSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * electron-builder's bundled 7-Zip follows symbolic links on macOS/Linux
 * hosts. The staged DSH runtime contains pnpm workspace links that form
 * recursive paths; following them makes 7za emit gigabytes of
 * ENAMETOOLONG warnings to stderr, which blows past Node's string limit
 * ("RangeError: Invalid string length") while packaging a Windows target
 * on a non-Windows host. Wrap the cached 7za so it stores symlinks as
 * links (-snl) instead of following them. Windows hosts do not need this
 * (7-Zip treats Windows junctions as links) and the wrapper is skipped.
 */
function ensureSevenZipStoresSymlinks() {
  if (process.platform === 'win32') return
  const cacheRoot = process.env.ELECTRON_BUILDER_CACHE
    ?? join(homedir(), 'Library', 'Caches', 'electron-builder')
  const binaries = []
  const visit = directory => {
    if (!existsSync(directory)) return
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.name === '7za') binaries.push(path)
    }
  }
  visit(cacheRoot)
  for (const wrapped of binaries) {
    const dir = dirname(wrapped)
    const real = join(dir, '7zz')
    if (!existsSync(real)) continue
    const isSymlink = lstatSync(wrapped).isSymbolicLink()
    const alreadyWrapped = !isSymlink && readFileSafe(wrapped).includes('-snl')
    if (alreadyWrapped) continue
    try {
      unlinkSync(wrapped)
      writeFileSync(wrapped, '#!/bin/sh\nexec "$(dirname "$0")/7zz" -snl "$@"\n', { mode: 0o755 })
      console.log(`wrapped 7za with -snl: ${wrapped}`)
    } catch (error) {
      console.warn(`could not wrap ${wrapped}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

function readFileSafe(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

ensureSevenZipStoresSymlinks()

const arch = process.env.DEEPWORK_WIN_ARCH ?? 'x64'
// electron-builder is invoked through its JS entry via the current Node
// binary (see build-mac.mjs): spawning node_modules/.bin/electron-builder
// breaks on Windows, where the .bin shim is extensionless.
const builder = join(root, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js')
// `--publish never`: artifacts are attached to the GitHub Release by the
// release workflow (softprops/action-gh-release); letting electron-builder
// publish on CI would require a GH_TOKEN and fails without one.
const result = spawnSync(process.execPath, [builder, '--win', `--${arch}`, '--publish', 'never'], {
  cwd: root,
  env: {
    ...process.env,
    CSC_IDENTITY_AUTO_DISCOVERY: 'false',
  },
  stdio: 'inherit',
})
if (result.error !== undefined) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
