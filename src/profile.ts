/**
 * DeepWork profile provisioning.
 *
 * The desktop surface boots its own DSH profile (`deepwork`) under the
 * shared home, composed from the same bundles as the browser web profile
 * (dsh-base + dsh-web-app) so the Chromium UI is the stock DSH UI. DeepWork's
 * own plugin is registered as an out-of-tree file: dependency of the profile
 * (pnpm-linked into the profile's node_modules), and the desktop patch layer
 * is passed at boot time with `--patch`, leaving the profile's own
 * cordis.patch.yml free for the user.
 *
 * Sessions, credentials, settings, and attachments all live in the shared
 * home and are therefore shared with the CLI and the browser GUI.
 */

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DESKTOP_PROFILE } from './runtime.ts'

/** Bundle layers the DeepWork profile composes (identical to the web template). */
export const DESKTOP_BUNDLES = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
] as const

const PROFILE_PATCH_TEMPLATE = '# Your patch layer for this dsh profile, applied after every bundle layer:\n'
  + '# a top-level YAML array of loader patch entries (id-targeted config\n'
  + '# overrides, disables, and insert lists; !!js expressions allowed).\n'
  + '[]\n'

const PROFILE_PNPM_WORKSPACE = 'packages:\n'
  + '  - .\n'
  + '\n'
  + 'nodeLinker: hoisted\n'
  + 'autoInstallPeers: false\n'

/** Files that make up the profile's install fingerprint (profile files + built artifacts). */
const FINGERPRINT_SOURCES = ['package.json', 'pnpm-workspace.yaml', 'cordis.patch.yml'] as const

/** Absolute path of the app root (src/profile.ts compiles into dist/profile.js). */
function appRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return resolve(here, '..')
}

/** Built artifacts whose content changes must refresh the profile install. */
function fingerprintArtifacts(appRootPath: string): string[] {
  const hashed = (dir: string): string[] => {
    if (!existsSync(dir)) return []
    const found: string[] = []
    const visit = (current: string): void => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const full = join(current, entry.name)
        if (entry.isDirectory()) visit(full)
        else found.push(full)
      }
    }
    visit(dir)
    return found.sort()
  }
  return [
    join(appRootPath, 'package.json'),
    join(appRootPath, 'dist', 'plugin.js'),
    join(appRootPath, 'dist', 'client.js'),
    join(appRootPath, 'dist', 'cordis.patch.yml'),
    ...hashed(join(appRootPath, 'dist', 'plugins')),
  ]
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

/** Fingerprint of the files that decide whether the profile needs (re)installing. */
export function profileFingerprint(profileDir: string): string {
  let digest = ''
  for (const name of FINGERPRINT_SOURCES) {
    const file = join(profileDir, name)
    if (!existsSync(file)) continue
    digest += name + ':' + readFileSync(file, 'utf8') + '\n'
  }
  for (const file of fingerprintArtifacts(appRoot())) {
    if (!existsSync(file)) continue
    digest += file + ':' + readFileSync(file, 'utf8').length + ':' + sha256(readFileSync(file, 'utf8')) + '\n'
  }
  return sha256(digest)
}

/**
 * Initialize or refresh the DeepWork profile under the shared home.
 *
 * Never touches user layers: the profile's own cordis.patch.yml is created
 * only when missing. The manifest's bundles and file: dependencies are owned
 * by the desktop and rewritten on every start (cheap, atomic); pnpm install
 * runs only when the fingerprint changes.
 * @param dshHome - the shared DSH home.
 * @param onLog - progress callback for install output.
 * @returns the resolved profile directory.
 */
export function ensureProfile(
  dshHome: string,
  onLog: (line: string) => void = () => {},
): { profileDir: string; installed: boolean } {
  const appRootPath = appRoot()
  const profileDir = join(dshHome, 'profiles', DESKTOP_PROFILE)
  mkdirSync(profileDir, { recursive: true, mode: 0o700 })

  const manifest = {
    name: 'dsh-profile-deepwork',
    private: true,
    // link: symlinks the package into the profile without installing its
    // dependency trees — runtime resolution rides the checkout's own workspace
    // links and the dsh app's healed profiles module fallback.
    dependencies: {
      '@deepwork/desktop': 'link:' + appRootPath,
    },
    dsh: { profile: { bundles: [...DESKTOP_BUNDLES] } },
  }
  const manifestPath = join(profileDir, 'package.json')
  const previous = existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8') : null
  const next = JSON.stringify(manifest, undefined, 2) + '\n'
  if (previous !== next) {
    const temporary = join(profileDir, 'package.json.deepwork-tmp')
    writeFileSync(temporary, next, { mode: 0o600 })
    renameSync(temporary, manifestPath)
  }

  const patchPath = join(profileDir, 'cordis.patch.yml')
  if (!existsSync(patchPath)) writeFileSync(patchPath, PROFILE_PATCH_TEMPLATE, { mode: 0o600 })
  const workspacePath = join(profileDir, 'pnpm-workspace.yaml')
  if (!existsSync(workspacePath)) writeFileSync(workspacePath, PROFILE_PNPM_WORKSPACE, { mode: 0o600 })

  const marker = join(profileDir, '.deepwork-install-fingerprint')
  const fingerprint = profileFingerprint(profileDir)
  const installed = existsSync(marker) && readFileSync(marker, 'utf8') === fingerprint
  if (installed) return { profileDir, installed: false }

  // file: dependencies are cached by version; clear the linked tree so a
  // rebuilt artifact (dist changes with the same version) is re-copied.
  rmSync(join(profileDir, 'node_modules'), { recursive: true, force: true })
  rmSync(join(profileDir, 'pnpm-lock.yaml'), { force: true })

  const pnpm = spawnSync('pnpm', ['install', '--no-frozen-lockfile'], {
    cwd: profileDir,
    env: process.env,
    encoding: 'utf8',
    timeout: 300_000,
  })
  if (pnpm.error !== undefined && (pnpm.error as NodeJS.ErrnoException).code === 'ENOENT') {
    // Packaged apps launched from Finder/Explorer get a minimal PATH without
    // pnpm; the profile only carries link: dependencies, so link them by hand
    // (Windows: directory junctions need no special privileges).
    const modules = join(profileDir, 'node_modules')
    mkdirSync(modules, { recursive: true, mode: 0o700 })
    for (const [name, spec] of Object.entries(manifest.dependencies)) {
      const target = resolve(String(spec).replace(/^link:/, ''))
      const link = join(modules, ...name.split('/'))
      mkdirSync(dirname(link), { recursive: true })
      rmSync(link, { recursive: true, force: true })
      if (process.platform === 'win32') {
        symlinkSync(target, link, 'junction')
      } else {
        symlinkSync(target, link)
      }
    }
    onLog('pnpm not found on PATH; linked profile dependencies manually\n')
  } else if (pnpm.error !== undefined || pnpm.status !== 0) {
    const detail = (pnpm.stderr ?? pnpm.stdout ?? '').slice(-2000) || String(pnpm.error)
    throw new Error('DeepWork profile install failed: ' + detail)
  } else {
    onLog(pnpm.stdout ?? '')
  }
  writeFileSync(marker, fingerprint, { mode: 0o600 })
  return { profileDir, installed: true }
}
