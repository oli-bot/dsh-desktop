const { spawnSync } = require('node:child_process')
const { existsSync, mkdirSync, cpSync } = require('node:fs')
const { join } = require('node:path')

/**
 * afterPack hook.
 *
 * electron-builder's own extraResources copier skips dot-directories and
 * node_modules trees, so the staged runtimes are copied into the app bundle
 * here with fs.cpSync (verbatimSymlinks preserves the symlink layout — the
 * staged runtime is a pnpm virtual store full of relative links). macOS
 * builds are then ad-hoc signed before DMG/ZIP targets consume the app
 * directory.
 *
 * The resources directory differs per platform: macOS bundles the app as
 * <Product>.app/Contents/Resources, Windows and Linux keep a flat
 * resources/ dir next to the executable. Hard-coding the macOS layout
 * silently staged the runtime into a dead path on Windows.
 */
module.exports = async function afterPack(context) {
  const projectRoot = context.packager.info.appDir
  const product = context.packager.appInfo.productFilename
  const resourcesDir = context.electronPlatformName === 'darwin'
    ? join(context.appOutDir, `${product}.app`, 'Contents', 'Resources')
    : join(context.appOutDir, 'resources')
  const resourcesStage = join(resourcesDir, '.stage')

  const staged = join(projectRoot, 'stage')
  if (existsSync(join(staged, 'dsh-runtime')) && existsSync(join(staged, 'node-runtime'))) {
    mkdirSync(resourcesStage, { recursive: true })
    for (const name of ['dsh-runtime', 'node-runtime']) {
      console.log(`afterPack: copying ${name} into ${resourcesStage}`)
      cpSync(join(staged, name), join(resourcesStage, name), {
        recursive: true,
        verbatimSymlinks: true,
        dereference: false,
      })
    }
    console.log(`afterPack: staged runtimes copied into ${resourcesStage}`)
  } else {
    console.warn('stage/dsh-runtime or stage/node-runtime missing; run pnpm run stage:dsh first')
  }

  if (context.electronPlatformName !== 'darwin') return
  const appPath = join(
    context.appOutDir,
    `${product}.app`,
  )
  const identity = process.env.DEEPWORK_SIGN_IDENTITY || '-'
  const args = ['--force', '--deep', '--sign', identity]
  if (identity === '-') args.push('--timestamp=none')
  args.push(appPath)
  const result = spawnSync('/usr/bin/codesign', args, { stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`codesign failed with status ${String(result.status)}`)
  }
}