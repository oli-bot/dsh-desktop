/**
 * Sidecar engine supervisor.
 *
 * DeepWork's engine is a plain `dsh` process booted as a sidecar: the
 * Electron shell spawns it, waits for its loopback URL line, loads that URL
 * in Chromium, and tears it down on quit. The engine and the shell share one
 * `$DSH_HOME` — the same home the CLI and the browser GUI use — so model
 * configuration, credentials, sessions, and attachments are shared without
 * any extra wiring.
 *
 * This module owns only process supervision. Window, menu, and bridge
 * concerns live in main.ts.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Readable } from 'node:stream'

/** The readiness line printed by the web-app bundle once the Loader settles. */
const READY_LINE = /^dsh web: (http:\/\/127\.0\.0\.1:\d+)(?:\s|$)/

/** Default sidecar timeout before the boot is considered failed. */
const DEFAULT_READY_TIMEOUT_MS = 60_000

/** Grace window for SIGTERM before the supervisor escalates to SIGKILL. */
const DEFAULT_STOP_TIMEOUT_MS = 8_000

/** Profile name reserved for the DeepWork desktop surface. */
export const DESKTOP_PROFILE = 'deepwork'

/** Process launch contract for the sidecar engine. */
export interface SidecarOptions {
  /** CLI entry (JS file run by the engine binary), or the engine command itself. */
  cliEntry: string
  /** Arguments after the CLI entry (launcher flags first). */
  args: string[]
  /** Working directory for the engine process. */
  cwd: string
  /** Environment passed to the engine (must already carry DSH_HOME etc.). */
  env: NodeJS.ProcessEnv
  /** Node binary used to run the CLI entry (when cliEntry is a JS file). */
  nodeBinary: string
  readyTimeoutMs?: number
  onLog?: (stream: 'stderr' | 'stdout', line: string) => void
}

/** Exit details emitted after an already-ready runtime terminates. */
export interface RuntimeExit {
  code: number | null
  signal: NodeJS.Signals | null
}

interface Deferred<T> {
  promise: Promise<T>
  reject(reason: unknown): void
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, reject, resolve }
}

/** Split a byte stream into lines, carrying partial lines across chunks. */
function lineReader(consume: (line: string) => void): (chunk: Buffer) => void {
  let pending = ''
  return (chunk: Buffer): void => {
    pending += chunk.toString('utf8')
    for (let newline = pending.indexOf('\n'); newline >= 0; newline = pending.indexOf('\n')) {
      const line = pending.slice(0, newline).replace(/\r$/, '')
      pending = pending.slice(newline + 1)
      consume(line)
    }
  }
}

/**
 * Supervise one `dsh web` sidecar process.
 *
 * Lifecycle: `start()` spawns the engine and resolves with its loopback URL
 * once the web-app bundle prints the readiness line; the engine then runs
 * until `stop()` is called or it exits on its own (surfaced through the
 * `exit` event).
 */
export class SidecarSupervisor {
  private child: import('node:child_process').ChildProcessByStdio<null, Readable, Readable> | undefined
  private ready = false
  private readonly options: SidecarOptions

  constructor(options: SidecarOptions) {
    this.options = options
  }

  /** Whether a child process is currently owned by this supervisor. */
  get running(): boolean {
    return this.child !== undefined
  }

  /** Start the engine and resolve only after the bundle's URL line. */
  async start(): Promise<URL> {
    if (this.child !== undefined) throw new Error('DeepWork engine is already running')
    this.ready = false
    const child = spawn(this.options.nodeBinary, [this.options.cliEntry, ...this.options.args], {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child = child
    const readiness = deferred<URL>()
    let settled = false
    const settleFailure = (error: Error): void => {
      if (settled) return
      settled = true
      readiness.reject(error)
    }
    const consume = (stream: 'stderr' | 'stdout', line: string): void => {
      this.options.onLog?.(stream, line)
      if (stream !== 'stdout' || settled) return
      const match = READY_LINE.exec(line)
      if (match?.[1] === undefined) return
      settled = true
      this.ready = true
      readiness.resolve(new URL(match[1]))
    }
    child.stdout.on('data', lineReader(line => { consume('stdout', line) }))
    child.stderr.on('data', lineReader(line => { consume('stderr', line) }))
    child.once('error', (error) => {
      settleFailure(new Error(`failed to launch DeepWork engine: ${error.message}`, { cause: error }))
    })
    child.once('exit', (code, signal) => {
      if (this.child === child) this.child = undefined
      if (!this.ready) {
        settleFailure(new Error(`DeepWork engine exited before readiness (code=${String(code)}, signal=${String(signal)})`))
      } else {
        this.ready = false
        this.emitExit({ code, signal })
      }
    })
    const timeout = setTimeout(() => {
      settleFailure(new Error(`DeepWork engine did not become ready within ${String(this.options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS)} ms`))
      child.kill('SIGTERM')
    }, this.options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS)
    try {
      return await readiness.promise
    } finally {
      clearTimeout(timeout)
    }
  }

  private emitExit(exit: RuntimeExit): void {
    this.onExit?.(exit)
  }

  /** Invoked when an already-ready engine exits on its own. */
  onExit: ((exit: RuntimeExit) => void) | undefined

  /** Stop the engine gracefully, escalating only after the bounded teardown window. */
  async stop(timeoutMs = DEFAULT_STOP_TIMEOUT_MS): Promise<void> {
    const child = this.child
    if (child === undefined) return
    const exited = new Promise<void>((resolve) => { child.once('exit', () => { resolve() }) })
    child.kill('SIGTERM')
    let timer: NodeJS.Timeout | undefined
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => { resolve('timeout') }, timeoutMs)
    })
    const result = await Promise.race([exited.then(() => 'exit' as const), timedOut])
    if (timer !== undefined) clearTimeout(timer)
    if (result === 'timeout' && child.exitCode === null) {
      child.kill('SIGKILL')
      await exited
    }
    if (this.child === child) this.child = undefined
    this.ready = false
  }
}

/**
 * Resolve the engine CLI entry:
 * DEEPWORK_ENGINE > packaged .stage/dsh-runtime > workspace harness > global dsh.
 */
export function resolveEngineCliEntry(): string {
  const explicit = process.env.DEEPWORK_ENGINE
  if (explicit !== undefined && explicit.trim() !== '') return resolve(explicit.trim())
  // Packaged layout: the staged runtime sits in the app's Resources/.stage
  // (pnpm deploy lays the CLI package out at the runtime root, lib/bin.js).
  const resourcesStage = join(process.resourcesPath, '.stage', 'dsh-runtime')
  const packagedCli = join(resourcesStage, 'lib', 'bin.js')
  if (existsSync(packagedCli)) return packagedCli
  const packagedCliWorkspace = join(resourcesStage, 'apps', 'cli', 'lib', 'bin.js')
  if (existsSync(packagedCliWorkspace)) return packagedCliWorkspace
  // Sibling deepseek-harness checkout (the workspace layout DeepWork is built for).
  const here = dirname(fileURLToPath(import.meta.url))
  const siblingCli = join(resolve(here, '..', '..'), 'deepseek-harness', 'apps', 'cli', 'lib', 'bin.js')
  if (existsSync(siblingCli)) return siblingCli
  return 'dsh'
}

/** Resolve the shared DSH home (env DSH_HOME, defaulting to ~/.dsh). */
export function sharedDshHome(): string {
  const fromEnv = process.env.DSH_HOME
  if (fromEnv !== undefined && fromEnv.trim() !== '') return resolve(fromEnv)
  return join(homedir(), '.dsh')
}

/**
 * The Node binary that runs the CLI entry.
 *
 * The engine must run under a real Node: the harness loader reaches Node
 * internals through node-addon-require-builtin, which Electron's embedded
 * Node cannot provide. Resolution order:
 *  1. DEEPWORK_NODE (explicit override)
 *  2. packaged layout: <resources>/.stage/node-runtime/bin/node
 *  3. dev layout: sibling .stage/node-runtime/bin/node
 *  4. a node on PATH (dev layout)
 *  5. process.execPath (plain-Node scripts and tests)
 */
export function engineNodeBinary(): string {
  const explicit = process.env.DEEPWORK_NODE
  if (explicit !== undefined && explicit.trim() !== '') return resolve(explicit.trim())
  if (process.versions.electron === undefined) return process.execPath
  const here = dirname(fileURLToPath(import.meta.url))
  const nodeName = process.platform === 'win32' ? 'node.exe' : 'node'
  const stagedInResources = join(process.resourcesPath, '.stage', 'node-runtime', 'bin', nodeName)
  if (existsSync(stagedInResources)) return stagedInResources
  const staged = join(resolve(here, '..'), 'stage', 'node-runtime', 'bin', nodeName)
  if (existsSync(staged)) return staged
  const stagedLegacy = join(resolve(here, '..'), '.stage', 'node-runtime', 'bin', nodeName)
  if (existsSync(stagedLegacy)) return stagedLegacy
  const searchPath = process.env.PATH ?? ''
  for (const dir of searchPath.split(':')) {
    if (dir === '') continue
    const candidate = join(dir, nodeName)
    if (existsSync(candidate)) return candidate
  }
  return process.execPath
}
