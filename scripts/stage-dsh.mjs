import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDshSource } from './dsh-source.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dshSource = resolveDshSource()
const stage = join(root, 'stage')
const runtime = join(stage, 'dsh-runtime')
const nodeRuntime = join(stage, 'node-runtime')
const cache = join(root, '.cache')
const nodeVersion = process.env.DEEPWORK_NODE_VERSION ?? '26.0.0'
// Node.js distribution triples use `linux`/`darwin`/`win` and `x64`/`arm64`.
// Stage a Node runtime for the current host unless an override asks for a
// specific platform (used for cross-packaging).
const nodePlatform = process.env.DEEPWORK_NODE_PLATFORM
  ?? { darwin: 'darwin', linux: 'linux', win32: 'win' }[process.platform]
  ?? process.platform
const nodeArch = process.env.DEEPWORK_NODE_ARCH
  ?? { arm64: 'arm64', x64: 'x64' }[process.arch]
  ?? process.arch
const nodeFolder = `node-v${nodeVersion}-${nodePlatform}-${nodeArch}`
// Node.js ships Windows as a zip and POSIX as a tarball; keep the checksum
// filename in sync with the archive actually downloaded.
const isWinTarget = nodePlatform === 'win'
const nodeArchiveName = isWinTarget ? `${nodeFolder}.zip` : `${nodeFolder}.tar.gz`
const nodeArchive = join(cache, nodeArchiveName)
const nodeCache = join(cache, nodeFolder)

if (!existsSync(join(dshSource, 'apps', 'web', 'dist', 'index.html'))
  || !existsSync(join(dshSource, 'apps', 'cli', 'lib', 'bin.js'))) {
  throw new Error(`DSH build artifacts are missing at ${dshSource}; run pnpm run build:dsh first`)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with status ${String(result.status)}`)
  }
}

/**
 * Create a symlink that works on Windows CI hosts without special
 * privileges: directory links become junctions (absolute target), which
 * Windows allows for unprivileged users. POSIX hosts use normal symlinks.
 */
function makeLink(target, link) {
  if (process.platform === 'win32') {
    const absolute = resolve(dirname(link), target)
    symlinkSync(absolute, link, 'junction')
    return
  }
  symlinkSync(target, link)
}

function download(url, target) {
  const temporary = `${target}.download-${String(process.pid)}`
  rmSync(temporary, { force: true })
  run('curl', ['--fail', '--location', '--silent', '--show-error', url, '--output', temporary])
  rmSync(target, { force: true })
  writeFileSync(target, readFileSync(temporary))
  rmSync(temporary, { force: true })
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function ensureNodeRuntime() {
  mkdirSync(cache, { recursive: true })
  const base = `https://nodejs.org/dist/v${nodeVersion}`
  const sumsPath = join(cache, `SHASUMS256-v${nodeVersion}.txt`)
  if (!existsSync(nodeArchive)) download(`${base}/${nodeArchiveName}`, nodeArchive)
  if (!existsSync(sumsPath)) download(`${base}/SHASUMS256.txt`, sumsPath)
  const expectedLine = readFileSync(sumsPath, 'utf8').split('\n')
    .find(line => line.endsWith(`  ${nodeArchiveName}`))
  if (expectedLine === undefined) throw new Error(`Node checksum entry missing for ${nodeArchiveName}`)
  const expected = expectedLine.split(/\s+/)[0]
  const actual = sha256(nodeArchive)
  if (actual !== expected) {
    throw new Error(`Node archive checksum mismatch: expected ${expected}, received ${actual}`)
  }
  const nodeEntry = isWinTarget ? 'node.exe' : join('bin', 'node')
  if (!existsSync(join(nodeCache, nodeEntry))) {
    const extraction = join(cache, `.node-extract-${String(process.pid)}`)
    rmSync(extraction, { recursive: true, force: true })
    mkdirSync(extraction, { recursive: true })
    if (isWinTarget) {
      // bsdtar reads zip archives on both macOS and Windows hosts.
      run('tar', ['-xf', nodeArchive, '-C', extraction])
    } else {
      run('tar', ['-xzf', nodeArchive, '-C', extraction])
    }
    rmSync(nodeCache, { recursive: true, force: true })
    cpSync(join(extraction, nodeFolder), nodeCache, {
      recursive: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    })
    rmSync(extraction, { recursive: true, force: true })
  }
  // POSIX Node tarballs need npm/npx launchers; the Windows zip ships them.
  if (!isWinTarget) {
    for (const [name, target] of [
      ['npm', '../lib/node_modules/npm/bin/npm-cli.js'],
      ['npx', '../lib/node_modules/npm/bin/npx-cli.js'],
    ]) {
      const launcher = join(nodeCache, 'bin', name)
      rmSync(launcher, { force: true })
      symlinkSync(target, launcher)
    }
  }
  rmSync(nodeRuntime, { recursive: true, force: true })
  cpSync(nodeCache, nodeRuntime, {
    recursive: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  })
  if (!isWinTarget) chmodSync(join(nodeRuntime, 'bin', 'node'), 0o755)

  const pnpmSource = join(root, 'node_modules', 'pnpm')
  if (!existsSync(join(pnpmSource, 'dist', 'pnpm.mjs'))) {
    throw new Error('pnpm package is missing; run pnpm install before staging')
  }
  const pnpmTarget = join(nodeRuntime, 'lib', 'node_modules', 'pnpm')
  rmSync(pnpmTarget, { recursive: true, force: true })
  mkdirSync(pnpmTarget, { recursive: true })
  for (const name of ['bin', 'dist']) {
    cpSync(join(pnpmSource, name), join(pnpmTarget, name), {
      recursive: true,
      preserveTimestamps: true,
    })
  }
  for (const name of ['LICENSE', 'package.json']) {
    copyFileSync(join(pnpmSource, name), join(pnpmTarget, name))
  }
  if (isWinTarget) {
    // Windows shim: `pnpm.cmd` next to node.exe (runtime-paths expects it).
    const shim = join(nodeRuntime, 'pnpm.cmd')
    rmSync(shim, { force: true })
    writeFileSync(shim, [
      '@echo off',
      '"%~dp0node.exe" "%~dp0lib\\node_modules\\pnpm\\bin\\pnpm.mjs" %*',
      '',
    ].join('\r\n'))
  } else {
    const pnpmBinary = join(nodeRuntime, 'bin', 'pnpm')
    rmSync(pnpmBinary, { force: true })
    symlinkSync('../lib/node_modules/pnpm/bin/pnpm.mjs', pnpmBinary)
    chmodSync(join(pnpmTarget, 'bin', 'pnpm.mjs'), 0o755)
  }
}

function shouldCopyWorkspaceEntry(sourceRoot, source) {
  const rel = relative(sourceRoot, source)
  if (rel === '') return true
  const top = rel.split(sep)[0]
  return !new Set([
    '.git', '.agents', '.claude', 'node_modules', 'src', 'test', 'tests',
    'coverage', 'docs', 'website',
  ]).has(top)
}

const copiedTargets = new Map()
const deployedPackageTargets = new Map()
let sourcePackages

function isWithin(parent, candidate) {
  return candidate === parent || candidate.startsWith(parent + sep)
}

function discoverSourcePackages() {
  if (sourcePackages !== undefined) return sourcePackages
  const packages = new Map()
  const ignored = new Set([
    '.cache', '.git', '.pnpm-store', 'coverage', 'dist', 'docs', 'lib',
    'node_modules', 'src', 'test', 'tests', 'website',
  ])
  const visit = directory => {
    const manifestPath = join(directory, 'package.json')
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      if (typeof manifest.name === 'string') packages.set(manifest.name, directory)
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || ignored.has(entry.name) || entry.name.startsWith('.')
        || entry.name.startsWith('staging-')) continue
      visit(join(directory, entry.name))
    }
  }
  visit(dshSource)
  sourcePackages = packages
  return packages
}

function dependencyNames(manifest) {
  return new Map([
    ...Object.keys(manifest.peerDependencies ?? {}).map(name => [name, true]),
    ...Object.keys(manifest.optionalDependencies ?? {}).map(name => [name, true]),
    ...Object.keys(manifest.dependencies ?? {}).map(name => [name, false]),
  ])
}

function findDeployedPackage(sourceTarget) {
  const manifestPath = join(sourceTarget, 'package.json')
  if (!existsSync(manifestPath)) return undefined
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') return undefined
  const key = `${manifest.name}@${manifest.version}`
  if (deployedPackageTargets.has(key)) return deployedPackageTargets.get(key)
  const store = join(runtime, 'node_modules', '.pnpm')
  let exact
  let sameMajor
  let any
  for (const entry of readdirSync(store, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const candidate = join(store, entry.name, 'node_modules', ...manifest.name.split('/'))
    const candidateManifest = join(candidate, 'package.json')
    if (!existsSync(candidateManifest)) continue
    const deployed = JSON.parse(readFileSync(candidateManifest, 'utf8'))
    if (deployed.name !== manifest.name) continue
    if (deployed.version === manifest.version) {
      exact = candidate
      break
    }
    if (deployed.version.split('.')[0] === manifest.version.split('.')[0] && sameMajor === undefined) {
      sameMajor = candidate
    }
    if (any === undefined) any = candidate
  }
  // Exact match first; otherwise fall back to the same-major (or any) version
  // in the staged store. The staged store is deployed from the harness's own
  // lockfile, so it is the coherent runtime set even when the source checkout
  // was installed inside a merged workspace that re-resolved newer versions.
  const chosen = exact ?? sameMajor ?? any
  deployedPackageTargets.set(key, chosen)
  return chosen
}

function stageDependencyTarget(sourceTarget) {
  const sourceStore = join(dshSource, 'node_modules', '.pnpm')
  if (isWithin(sourceStore, sourceTarget)) {
    const target = join(runtime, 'node_modules', '.pnpm', relative(sourceStore, sourceTarget))
    if (existsSync(target)) return target
    const equivalent = findDeployedPackage(sourceTarget)
    if (equivalent !== undefined) return equivalent
    throw new Error(`deployed pnpm store is missing runtime dependency: ${sourceTarget}`)
  }
  if (isWithin(dshSource, sourceTarget)) return stageWorkspaceTarget(sourceTarget)
  // The harness checkout may be installed as part of a merged workspace whose
  // virtual store lives outside the checkout (e.g. the DeepWork workspace
  // merges ../deepseek-harness). Resolve such links to the equivalent package
  // already deployed in the staged store when the name@version matches.
  const equivalent = findDeployedPackage(sourceTarget)
  if (equivalent !== undefined) return equivalent
  throw new Error(`DSH package dependency points outside the source checkout: ${sourceTarget}`)
}

function mirrorPackageDependencies(sourcePackage, targetPackage) {
  const manifestPath = join(sourcePackage, 'package.json')
  if (!existsSync(manifestPath)) return
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  for (const [dependency, optional] of dependencyNames(manifest)) {
    const sourceLink = join(sourcePackage, 'node_modules', ...dependency.split('/'))
    if (!existsSync(sourceLink)) {
      if (optional) continue
      throw new Error(`${manifest.name ?? sourcePackage} is missing installed dependency ${dependency}`)
    }
    const stat = lstatSync(sourceLink)
    if (!stat.isSymbolicLink()) {
      throw new Error(`${manifest.name ?? sourcePackage} dependency is not a pnpm link: ${sourceLink}`)
    }
    const sourceTarget = resolve(dirname(sourceLink), readlinkSync(sourceLink))
    const target = stageDependencyTarget(sourceTarget)
    const targetLink = join(targetPackage, 'node_modules', ...dependency.split('/'))
    mkdirSync(dirname(targetLink), { recursive: true })
    rmSync(targetLink, { recursive: true, force: true })
    makeLink(relative(dirname(targetLink), target), targetLink)
  }
}

function stageWorkspaceTarget(source) {
  const rel = relative(dshSource, source)
  if (rel.startsWith(`..${sep}`) || rel === '..' || rel === '') {
    throw new Error(`cannot stage external DSH workspace target: ${source}`)
  }
  const existing = copiedTargets.get(source)
  if (existing !== undefined) return existing
  const target = join(runtime, 'workspace', rel)
  mkdirSync(dirname(target), { recursive: true })
  const stat = lstatSync(source)
  if (stat.isDirectory()) {
    cpSync(source, target, {
      recursive: true,
      preserveTimestamps: true,
      filter: candidate => shouldCopyWorkspaceEntry(source, candidate),
    })
  } else {
    copyFileSync(source, target)
  }
  copiedTargets.set(source, target)
  if (stat.isDirectory()) mirrorPackageDependencies(source, target)
  return target
}

function walk(rootPath, visit) {
  for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
    const path = join(rootPath, entry.name)
    if (entry.isSymbolicLink()) visit(path)
    else if (entry.isDirectory()) walk(path, visit)
  }
}

function rewriteWorkspaceLinks() {
  const links = []
  walk(runtime, path => { links.push(path) })
  for (const link of links) {
    const raw = readlinkSync(link)
    const logicalTarget = resolve(dirname(link), raw)
    if (logicalTarget !== dshSource && !logicalTarget.startsWith(dshSource + sep)) continue
    const stagedTarget = stageWorkspaceTarget(logicalTarget)
    rmSync(link)
    makeLink(relative(dirname(link), stagedTarget), link)
  }
}

function relinkInstallationWorkspacePackages() {
  for (const [packageName, source] of discoverSourcePackages()) {
    const link = join(runtime, 'node_modules', ...packageName.split('/'))
    if (!existsSync(link)) continue
    const stagedTarget = stageWorkspaceTarget(source)
    rmSync(link, { recursive: true, force: true })
    symlinkSync(relative(dirname(link), stagedTarget), link)
  }
}

function assertSelfContained(rootPath, label) {
  const failures = []
  walk(rootPath, link => {
    const target = resolve(dirname(link), readlinkSync(link))
    // Skip dangling symlinks inside .pnpm store — pnpm sometimes leaves
    // optional-dep stubs that point to packages it didn't install; these
    // are never in the final app bundle so they are harmless.
    if (link.includes('.pnpm') && !existsSync(target)) return
    if (!existsSync(target)) {
      failures.push(`${link} -> ${readlinkSync(link)} (dangling)`)
      return
    }
    if (target !== rootPath && !target.startsWith(rootPath + sep)) {
      failures.push(`${link} -> ${readlinkSync(link)} (outside stage)`)
    }
  })
  if (failures.length > 0) {
    throw new Error(`${label} contains non-portable symlinks:\n${failures.slice(0, 40).join('\n')}`)
  }
}

function runtimePackageDirectory(name) {
  return join(runtime, 'node_modules', ...name.split('/'))
}

function resolveDependencyManifest(requireFromPackage, dependency) {
  try {
    return requireFromPackage.resolve(`${dependency}/package.json`)
  } catch (packageJsonError) {
    let directory = dirname(requireFromPackage.resolve(dependency))
    for (;;) {
      const manifestPath = join(directory, 'package.json')
      if (existsSync(manifestPath)) {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
        if (manifest.name === dependency) return manifestPath
      }
      const parent = dirname(directory)
      if (parent === directory) throw packageJsonError
      directory = parent
    }
  }
}

function installCompiledPackageDependencies(sourceManifestPath, packageDir) {
  const installRoot = join(packageDir, 'node_modules')
  const installed = new Set()

  const installManifest = manifestPath => {
    const source = dirname(manifestPath)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
      throw new Error(`invalid runtime dependency manifest: ${manifestPath}`)
    }
    const key = `${manifest.name}@${manifest.version}`
    if (installed.has(key)) return
    installed.add(key)
    const target = join(installRoot, ...manifest.name.split('/'))
    rmSync(target, { recursive: true, force: true })
    mkdirSync(dirname(target), { recursive: true })
    cpSync(source, target, {
      dereference: true,
      preserveTimestamps: true,
      recursive: true,
      filter: candidate => {
        const rel = relative(source, candidate)
        return rel === '' || rel.split(sep)[0] !== 'node_modules'
      },
    })

    const requireFromPackage = createRequire(manifestPath)
    for (const [dependency, optional] of dependencyNames(manifest)) {
      try {
        installManifest(resolveDependencyManifest(requireFromPackage, dependency))
      } catch (error) {
        if (optional) continue
        throw new Error(`${manifest.name} is missing runtime dependency ${dependency}`, { cause: error })
      }
    }
  }

  const sourceManifest = JSON.parse(readFileSync(sourceManifestPath, 'utf8'))
  const requireFromSource = createRequire(sourceManifestPath)
  for (const dependency of Object.keys(sourceManifest.dependencies ?? {})) {
    installManifest(resolveDependencyManifest(requireFromSource, dependency))
  }
}

function installCompiledPackageHostDependencies(sourceManifestPath, packageDir) {
  const manifest = JSON.parse(readFileSync(sourceManifestPath, 'utf8'))
  const sourcePackages = discoverSourcePackages()
  for (const dependency of manifest.deepWork?.hostDependencies ?? []) {
    const source = sourcePackages.get(dependency)
    if (source === undefined) {
      throw new Error(`${manifest.name} cannot resolve DSH peer ${dependency}`)
    }
    const target = stageWorkspaceTarget(source)
    const link = join(packageDir, 'node_modules', ...dependency.split('/'))
    mkdirSync(dirname(link), { recursive: true })
    rmSync(link, { recursive: true, force: true })
    makeLink(relative(dirname(link), target), link)
  }
}

function installDesktopPackages() {
  const packages = [
    {
      manifest: join(root, 'package.json'),
      files: [
        [join(root, 'dist', 'plugin.js'), 'dist/plugin.js'],
        [join(root, 'dist', 'client.js'), 'dist/client.js'],
        [join(root, 'dist', 'client.js.map'), 'dist/client.js.map'],
        [join(root, 'dist', 'cordis.patch.yml'), 'dist/cordis.patch.yml'],
      ],
    },
  ]
  const installedVersions = {}
  for (const spec of packages) {
    const manifest = JSON.parse(readFileSync(spec.manifest, 'utf8'))
    delete manifest.build
    delete manifest.devDependencies
    delete manifest.scripts
    if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
      throw new Error(`invalid bundled plugin manifest: ${spec.manifest}`)
    }
    const packageDir = runtimePackageDirectory(manifest.name)
    mkdirSync(packageDir, { recursive: true })
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify(manifest, undefined, 2) + '\n')
    installCompiledPackageDependencies(spec.manifest, packageDir)
    installCompiledPackageHostDependencies(spec.manifest, packageDir)
    for (const [source, target] of spec.files) {
      const output = join(packageDir, target)
      mkdirSync(dirname(output), { recursive: true })
      copyFileSync(source, output)
    }
    installedVersions[manifest.name] = manifest.version
  }
  const cliManifestPath = join(runtime, 'package.json')
  const cliManifest = JSON.parse(readFileSync(cliManifestPath, 'utf8'))
  cliManifest.dependencies = {
    ...cliManifest.dependencies,
    ...installedVersions,
  }
  writeFileSync(cliManifestPath, JSON.stringify(cliManifest, undefined, 2) + '\n')
}

function restoreExecutableHelpers() {
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.name === 'spawn-helper' && !entry.isSymbolicLink()) chmodSync(path, 0o755)
    }
  }
  visit(runtime)
}

/**
 * node-pty publishes darwin/win32 prebuilds but no Linux ones, and the
 * `pnpm deploy` step reinstalls packages from the store, which drops the
 * `build/` output produced during `pnpm install`. Rebuild the native module
 * inside the staged runtime against the staged Node so the PTY host works on
 * Linux; macOS keeps using its published prebuild.
 */
function ensureLinuxPtyBuild() {
  if (process.platform !== 'linux') return
  const storeRoot = join(runtime, 'node_modules', '.pnpm')
  const ptyEntry = readdirSync(storeRoot, { withFileTypes: true })
    .find(entry => entry.isDirectory() && entry.name.startsWith('node-pty@'))
  if (ptyEntry === undefined) return
  const packageDir = join(storeRoot, ptyEntry.name, 'node_modules', 'node-pty')
  const prebuild = join(packageDir, 'prebuilds', `linux-${nodeArch}`)
  if (existsSync(join(packageDir, 'build', 'Release', 'pty.node')) || existsSync(join(prebuild, 'pty.node'))) return
  const addonEntry = readdirSync(storeRoot, { withFileTypes: true })
    .find(entry => entry.isDirectory() && entry.name.startsWith('node-addon-api@'))
  if (addonEntry === undefined) {
    throw new Error('staged runtime is missing node-addon-api; cannot compile node-pty')
  }
  const addonTarget = join(storeRoot, addonEntry.name, 'node_modules', 'node-addon-api')
  const dependencyDir = join(packageDir, 'node_modules')
  mkdirSync(dependencyDir, { recursive: true })
  const addonLink = join(dependencyDir, 'node-addon-api')
  rmSync(addonLink, { recursive: true, force: true })
  makeLink(relative(dependencyDir, addonTarget), addonLink)
  const nodeGyp = join(nodeRuntime, 'lib', 'node_modules', 'npm', 'node_modules', 'node-gyp', 'bin', 'node-gyp.js')
  if (!existsSync(nodeGyp)) {
    throw new Error('staged Node runtime is missing node-gyp; cannot compile node-pty')
  }
  try {
    run(join(nodeRuntime, 'bin', 'node'), [nodeGyp, 'rebuild'], { cwd: packageDir, env: process.env })
  } finally {
    rmSync(addonLink, { force: true })
    rmSync(dependencyDir, { recursive: true, force: true })
  }
  if (!existsSync(join(packageDir, 'build', 'Release', 'pty.node'))) {
    throw new Error('node-pty build did not produce build/Release/pty.node')
  }
}

if (!existsSync(join(dshSource, 'apps', 'cli', 'package.json'))) {
  throw new Error(`DSH source checkout not found: ${dshSource}`)
}
for (const required of [
  'plugin.js',
  'client.js',
  'client.js.map',
  'cordis.patch.yml',
]) {
  if (!existsSync(join(root, 'dist', required))) {
    throw new Error(`desktop artifact missing: dist/${required}; run pnpm run build first`)
  }
}

// ── Collect cordis patch packages ───────────────────────────────────
// `pnpm deploy --prod` only installs the CLI's direct dependencies, but the
// cordis plugin system dynamically loads additional packages at runtime
// (referenced by cordis.patch.yml).  We collect them here and will copy them
// into node_modules AFTER deploy, along with their non-peer dependencies.
const cordisPatchFiles = []
const srcWorkspaceBundle = join(dshSource, 'packages', 'bundle')
if (existsSync(srcWorkspaceBundle)) {
  for (const entry of readdirSync(srcWorkspaceBundle, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const patch = join(srcWorkspaceBundle, entry.name, 'cordis.patch.yml')
    if (existsSync(patch)) cordisPatchFiles.push(patch)
  }
}
const desktopPatch = join(root, 'dist', 'cordis.patch.yml')
if (existsSync(desktopPatch)) cordisPatchFiles.push(desktopPatch)

const pkgRe = /name:\s*['"]?(@deepseek-ai\/[a-zA-Z0-9_/.-]+)/g
const cordisPackages = new Set()
for (const patchFile of cordisPatchFiles) {
  const content = readFileSync(patchFile, 'utf8')
  for (const m of content.matchAll(pkgRe)) {
    const fullPkg = m[1]
    const parts = fullPkg.split('/')
    const pkg = parts.length > 2 ? parts.slice(0, 2).join('/') : fullPkg
    if (pkg.includes('/')) cordisPackages.add(pkg)
  }
}

rmSync(stage, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })
const pnpmBin = join(root, 'node_modules', '.bin', 'pnpm')
run(existsSync(pnpmBin) ? pnpmBin : 'pnpm', [
  '--ignore-scripts',
  '--filter', '@deepseek-ai/dsh',
  'deploy', '--prod', '--legacy', runtime,
], { cwd: dshSource, env: process.env })

rewriteWorkspaceLinks()
relinkInstallationWorkspacePackages()
installDesktopPackages()
copyFileSync(join(dshSource, 'THIRD_PARTY_NOTICES.md'), join(runtime, 'THIRD_PARTY_NOTICES.md'))
restoreExecutableHelpers()

// ── Copy cordis patch packages into node_modules ────────────────────
// pnpm deploy only installs CLI direct deps. The cordis plugin system loads
// additional packages at runtime. Copy them from the workspace, then
// recursively ensure their non-peer deps are accessible.
{
  const workspaceDir = join(runtime, 'workspace')
  const nodeModulesDir = join(runtime, 'node_modules', '@deepseek-ai')
  const copied = new Set()
  // Build a registry of all workspace packages (name → source path)
  const workspaceRegistry = new Map()
  const scanWorkspace = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'node_modules') continue
      const mp = join(dir, entry.name, 'package.json')
      if (existsSync(mp)) {
        try {
          const m = JSON.parse(readFileSync(mp, 'utf8'))
          if (m.name && m.name.startsWith('@deepseek-ai/')) {
            workspaceRegistry.set(m.name, join(dir, entry.name))
          }
        } catch {}
      }
      scanWorkspace(join(dir, entry.name))
    }
  }
  scanWorkspace(join(workspaceDir, 'packages'))
  scanWorkspace(join(workspaceDir, 'vendor'))

  const copyPkg = (pkgName) => {
    if (copied.has(pkgName)) return
    if (existsSync(join(nodeModulesDir, pkgName.split('/')[1]))) return
    const src = workspaceRegistry.get(pkgName)
    if (src === undefined) return
    copied.add(pkgName)
    const dst = join(nodeModulesDir, pkgName.split('/')[1])
    copyWorkspacePackage(src, dst)
    // Resolve non-peer dependencies
    const mp = join(src, 'package.json')
    if (!existsSync(mp)) return
    const manifest = JSON.parse(readFileSync(mp, 'utf8'))
    for (const dep of Object.keys(manifest.dependencies ?? {})) {
      if (dep.startsWith('@deepseek-ai/')) copyPkg(dep)
      // Non-workspace deps (e.g. @standard-schema/spec) should already be
      // in node_modules from the deploy or in the .pnpm store; skip them.
    }
  }

  for (const pkg of cordisPackages) copyPkg(pkg)
  if (copied.size > 0) console.log(`Copied ${copied.size} cordis patch packages into node_modules`)
}

// ── Ensure optional native dependencies are accessible ───────────────
// Packages like koffi declare platform-specific optionalDependencies
// (e.g. @koromix/koffi-darwin-arm64) which pnpm deploy may not properly
// link into nested node_modules.  Walk every deployed package, check both
// its own node_modules and its parent's node_modules, and create symlinks
// for any missing optional deps from the .pnpm store.
{
  const storeDir = join(runtime, 'node_modules', '.pnpm')
  if (existsSync(storeDir)) {
    let fixed = 0
    const linkOptionalDep = (depName, targetDir) => {
      if (existsSync(targetDir)) return false
      const depShort = depName.split('/').pop()
      const scope = depName.startsWith('@') ? depName.split('/')[0] : ''
      for (const storeEntry of readdirSync(storeDir, { withFileTypes: true })) {
        if (!storeEntry.isDirectory()) continue
        const prefix = scope ? `${scope.replace('@', '')}+${depShort}@` : `${depShort}@`
        if (!storeEntry.name.startsWith(prefix)) continue
        const candidate = join(storeDir, storeEntry.name, 'node_modules', depName)
        if (existsSync(candidate)) {
          mkdirSync(dirname(targetDir), { recursive: true })
          makeLink(relative(dirname(targetDir), candidate), targetDir)
          return true
        }
      }
      return false
    }
    const visit = (pkgDir) => {
      for (const entry of readdirSync(pkgDir, { withFileTypes: true })) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
        if (entry.name === '.bin' || entry.name === '.pnpm') continue
        const manifestPath = join(pkgDir, entry.name, 'package.json')
        if (!existsSync(manifestPath)) continue
        let manifest
        try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) } catch { continue }
        const optionalDeps = manifest.optionalDependencies ?? {}
        if (Object.keys(optionalDeps).length > 0) {
          // Check own node_modules first, then parent's node_modules
          const ownNm = join(pkgDir, entry.name, 'node_modules')
          const parentNm = join(pkgDir, 'node_modules')
          for (const depName of Object.keys(optionalDeps)) {
            if (existsSync(join(ownNm, depName))) continue
            if (existsSync(join(parentNm, depName))) continue
            if (linkOptionalDep(depName, join(ownNm, depName))) {
              fixed++
            } else if (linkOptionalDep(depName, join(parentNm, depName))) {
              fixed++
            }
          }
        }
        // Follow symlinks and recurse into node_modules (symlinks may point to dirs)
        const childNm = join(pkgDir, entry.name, 'node_modules')
        if (existsSync(childNm)) visit(childNm)
      }
    }
    // Walk both top-level node_modules and workspace nested node_modules
    visit(join(runtime, 'node_modules'))
    const wsNm = join(runtime, 'workspace', 'node_modules')
    if (existsSync(wsNm)) visit(wsNm)
    // Also walk workspace packages' own node_modules (e.g. sandbox-windows-acl/node_modules/koffi)
    const wsPkgDir = join(runtime, 'workspace', 'packages')
    if (existsSync(wsPkgDir)) {
      const visitWs = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (!entry.isDirectory() || entry.name === 'node_modules') continue
          const nm = join(dir, entry.name, 'node_modules')
          if (existsSync(nm)) visit(nm)
          visitWs(join(dir, entry.name))
        }
      }
      visitWs(wsPkgDir)
    }
    if (fixed > 0) console.log(`Linked ${fixed} missing optional native dependencies`)
  }
}

function copyWorkspacePackage(source, target) {
  mkdirSync(target, { recursive: true })
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'src' || entry.name === '.git') continue
    const srcPath = join(source, entry.name)
    const dstPath = join(target, entry.name)
    if (entry.isDirectory()) {
      copyWorkspacePackage(srcPath, dstPath)
    } else {
      copyFileSync(srcPath, dstPath)
    }
  }
}

function findWorkspacePackage(searchRoot, packageName) {
  if (!existsSync(searchRoot)) return undefined
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'node_modules') continue
      const candidate = join(dir, entry.name, 'package.json')
      if (existsSync(candidate)) {
        try {
          const manifest = JSON.parse(readFileSync(candidate, 'utf8'))
          if (manifest.name === packageName) return join(dir, entry.name)
        } catch {}
      }
      const deeper = visit(join(dir, entry.name))
      if (deeper !== undefined) return deeper
    }
    return undefined
  }
  return visit(searchRoot)
}

assertSelfContained(runtime, 'DSH runtime')
ensureNodeRuntime()
assertSelfContained(nodeRuntime, 'Node runtime')
ensureLinuxPtyBuild()

// Smoke-test the staged runtime only when it targets this host; a
// cross-platform stage (e.g. win on darwin) cannot execute foreign binaries.
const hostPlatform = { darwin: 'darwin', linux: 'linux', win32: 'win' }[process.platform]
if (nodePlatform === hostPlatform) {
  run(join(nodeRuntime, isWinTarget ? 'node.exe' : join('bin', 'node')), [join(runtime, 'lib', 'bin.js'), '--version'], {
    cwd: runtime,
    env: { ...process.env, DSH_HOME: join(stage, 'smoke-home') },
  })
  if (isWinTarget) {
    run(join(nodeRuntime, 'node.exe'), [join(nodeRuntime, 'lib', 'node_modules', 'pnpm', 'bin', 'pnpm.mjs'), '--version'], { cwd: runtime, env: process.env })
  } else {
    run(join(nodeRuntime, 'bin', 'pnpm'), ['--version'], { cwd: runtime, env: process.env })
  }
} else {
  const stagedNode = join(nodeRuntime, isWinTarget ? 'node.exe' : join('bin', 'node'))
  if (!existsSync(stagedNode)) throw new Error(`staged Node runtime missing ${stagedNode}`)
  console.log(`Skipped staged-runtime smoke: target ${nodePlatform}-${nodeArch} != host ${hostPlatform}`)
}

console.log(`Staged DSH runtime: ${runtime}`)
console.log(`Staged Node ${nodeVersion}: ${nodeRuntime}`)
