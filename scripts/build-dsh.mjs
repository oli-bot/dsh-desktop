import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDshSource } from './dsh-source.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const dshSource = resolveDshSource()

// Run pnpm through its JS entry via the current Node binary: spawning the
// bare `pnpm` command on Windows fails (Node only appends .exe when
// resolving PATH names, not .cmd), and `shell: true` would break paths with
// spaces. `node <pnpm.cjs>` is identical behavior on every platform.
const pnpmCli = join(resolve(here, '..'), 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')

function run(args) {
  const result = spawnSync(process.execPath, [pnpmCli, ...args], {
    cwd: dshSource,
    env: process.env,
    stdio: 'inherit',
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

run(['install', '--frozen-lockfile'])
run(['run', 'build'])