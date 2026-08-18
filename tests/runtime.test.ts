import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SidecarSupervisor } from '../src/runtime.ts'

/** A fake CLI that prints the DSH readiness line, then keeps running. */
function fakeCli(dir: string, readyLine: string): string {
  const file = join(dir, 'fake-cli.mjs')
  writeFileSync(file, [
    'process.stdout.write(' + JSON.stringify(readyLine + '\n') + ')',
    'setInterval(() => {}, 1000)',
    'process.on("SIGTERM", () => process.exit(0))',
  ].join('\n'))
  return file
}

test('sidecar supervisor resolves the readiness URL line', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'deepwork-runtime-'))
  const cli = fakeCli(dir, 'dsh web: http://127.0.0.1:41023')
  const supervisor = new SidecarSupervisor({
    args: [],
    cliEntry: cli,
    cwd: dir,
    env: { ...process.env },
    nodeBinary: process.execPath,
    readyTimeoutMs: 10_000,
  })
  const url = await supervisor.start()
  assert.equal(url.href, 'http://127.0.0.1:41023/')
  assert.equal(supervisor.running, true)
  await supervisor.stop()
  assert.equal(supervisor.running, false)
})

test('sidecar supervisor rejects when the engine exits before readiness', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'deepwork-runtime-'))
  const cli = join(dir, 'exit-cli.mjs')
  writeFileSync(cli, 'process.exit(3)\n')
  const supervisor = new SidecarSupervisor({
    args: [],
    cliEntry: cli,
    cwd: dir,
    env: { ...process.env },
    nodeBinary: process.execPath,
    readyTimeoutMs: 5_000,
  })
  await assert.rejects(supervisor.start(), /exited before readiness \(code=3/)
})

test('sidecar supervisor times out when no readiness line arrives', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'deepwork-runtime-'))
  const cli = join(dir, 'quiet-cli.mjs')
  writeFileSync(cli, 'setInterval(() => {}, 1000)\n')
  const supervisor = new SidecarSupervisor({
    args: [],
    cliEntry: cli,
    cwd: dir,
    env: { ...process.env },
    nodeBinary: process.execPath,
    readyTimeoutMs: 1_500,
  })
  await assert.rejects(supervisor.start(), /did not become ready within/)
})
