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
 */
module.exports = async function afterPack(context) {
  const projectRoot = context.packager.info.appDir
  const resourcesStage = join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    'Contents',
    'Resources',
    '.stage',
  )

  const staged = join(projectRoot, 'stage')
  if (existsSync(join(staged, 'dsh-runtime')) && existsSync(join(staged, 'node-runtime'))) {
    mkdirSync(resourcesStage, { recursive: true })
    for (const name of ['dsh-runtime', 'node-runtime']) {
      cpSync(join(staged, name), join(resourcesStage, name), {
        recursive: true,
        verbatimSymlinks: true,
        dereference: false,
      })
    }
    console.log(`staged runtimes copied into ${resourcesStage}`)
  } else {
    console.warn('stage/dsh-runtime or stage/node-runtime missing; run pnpm run stage:dsh first')
  }

  if (context.electronPlatformName !== 'darwin') return
  const appPath = join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
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
