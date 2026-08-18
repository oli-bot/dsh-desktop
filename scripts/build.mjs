import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')
rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })

const shared = {
  bundle: true,
  logLevel: 'info',
  sourcemap: true,
  target: 'node24',
}

const builds = [
  build({
    ...shared,
    entryPoints: [join(root, 'src', 'main.ts')],
    outfile: join(dist, 'main.js'),
    platform: 'node',
    format: 'esm',
    external: ['electron'],
  }),
  build({
    ...shared,
    entryPoints: [join(root, 'src', 'preload.ts')],
    outfile: join(dist, 'preload.cjs'),
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  }),
  build({
    ...shared,
    entryPoints: [join(root, 'src', 'plugin.ts')],
    outfile: join(dist, 'plugin.js'),
    platform: 'node',
    format: 'esm',
  }),
  build({
    bundle: true,
    entryPoints: [join(root, 'src', 'client.ts')],
    outfile: join(dist, 'client.js'),
    platform: 'browser',
    format: 'cjs',
    target: 'es2022',
    sourcemap: true,
    logLevel: 'info',
    banner: {
      js: 'window.__ModuleLoader__.load({ id: "@deepwork/desktop", factory: (require) => { var module = { exports: {} }; var exports = module.exports;',
    },
    footer: { js: 'return module.exports; } });' },
  }),
]

await Promise.all(builds)

copyFileSync(join(root, 'src', 'splash.html'), join(dist, 'splash.html'))
copyFileSync(join(root, 'cordis.patch.yml'), join(dist, 'cordis.patch.yml'))
