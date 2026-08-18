/**
 * DeepWork desktop shell (Electron main).
 *
 * Responsibilities:
 *  - create the native window, application menu, and lifecycle;
 *  - provision the shared-profile under $DSH_HOME and supervise the sidecar
 *    dsh engine that serves the web UI (Chromium hosts that UI);
 *  - bridge native actions to the renderer (command channel) and renderer
 *    requests back to the shell (facts, workspace picker, external links).
 */

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  shell,
  type MenuItemConstructorOptions,
} from 'electron'
import { createWriteStream, existsSync, mkdirSync, statSync, type WriteStream } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DesktopCommand, DesktopInfo, DesktopRuntimeSnapshot } from './contracts.ts'
import { ensureProfile } from './profile.ts'
import {
  DESKTOP_PROFILE,
  engineNodeBinary,
  resolveEngineCliEntry,
  sharedDshHome,
  SidecarSupervisor,
  type RuntimeExit,
  type SidecarOptions,
} from './runtime.ts'

const PRODUCT_NAME = 'DeepWork'

// Chromium encrypts persisted session data via the macOS Keychain on first
// use; the in-memory keychain keeps the app free of system Keychain prompts
// (browser cookies simply do not survive restarts — DSH state lives in
// $DSH_HOME, not in cookies).
if (process.platform === 'darwin') {
  app.commandLine.appendSwitch('use-mock-keychain')
}

const DEFAULT_UI_ZOOM_FACTOR = 1.12
const currentDir = dirname(fileURLToPath(import.meta.url))
const splashPath = join(currentDir, 'splash.html')
const preloadPath = join(currentDir, 'preload.cjs')

let mainWindow: BrowserWindow | undefined
let runtime: SidecarSupervisor | undefined
let runtimeUrl: URL | undefined
let runtimeOrigin: string | undefined
let logStream: WriteStream | undefined
let quitting = false
let transitioning = false
let queuedPaths: string[] = []
const logTail: string[] = []

function appendLog(stream: 'desktop' | 'stderr' | 'stdout', line: string): void {
  const rendered = new Date().toISOString() + ' [' + stream + '] ' + line
  logStream?.write(rendered + '\n')
  logTail.push(rendered)
  if (logTail.length > 200) logTail.splice(0, logTail.length - 200)
}

function desktopInfo(): DesktopInfo {
  return {
    appDataPath: app.getPath('userData'),
    dshHome: sharedDshHome(),
    platform: process.platform,
    profile: DESKTOP_PROFILE,
    version: app.getVersion(),
  }
}

function desktopRuntimeSnapshot(): DesktopRuntimeSnapshot {
  return {
    logTail: logTail.slice(-100),
    profile: DESKTOP_PROFILE,
    runtimeUrl: runtimeUrl?.href ?? null,
    status: transitioning ? 'restarting' : runtimeUrl === undefined ? 'stopped' : 'ready',
  }
}

function desktopPatchPath(): string {
  return join(currentDir, 'cordis.patch.yml')
}

function runtimeEnvironment(
  overrides: { appDataPath?: string; dshHome?: string } = {},
): NodeJS.ProcessEnv {
  const info = desktopInfo()
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    DEEPWORK: '1',
    DEEPWORK_APP_DATA: overrides.appDataPath ?? info.appDataPath,
    DEEPWORK_PROFILE: info.profile,
    DEEPWORK_VERSION: info.version,
    DSH_HOME: overrides.dshHome ?? info.dshHome,
  }
  return environment
}

function sidecarOptions(
  cwd: string,
  env: NodeJS.ProcessEnv,
): SidecarOptions {
  return {
    args: ['--profile', DESKTOP_PROFILE, '--patch', desktopPatchPath()],
    cliEntry: resolveEngineCliEntry(),
    cwd,
    env,
    nodeBinary: engineNodeBinary(),
    onLog: (stream, line) => { appendLog(stream, line) },
    readyTimeoutMs: 90_000,
  }
}

function engineWorkspaceRoot(): string {
  const workspaceRoot = join(homedir(), 'DSH Workspaces')
  mkdirSync(workspaceRoot, { recursive: true })
  return workspaceRoot
}

function isAllowedRuntimeNavigation(target: string, allowedOrigin: string | undefined): boolean {
  if (target.startsWith('file:')) return true
  if (allowedOrigin === undefined) return false
  try {
    return new URL(target).origin === allowedOrigin
  } catch {
    return false
  }
}

function isAllowedBrowserNavigation(target: string): boolean {
  if (target === 'about:blank') return true
  try {
    const url = new URL(target)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
    return url.origin !== runtimeOrigin
  } catch {
    return false
  }
}

function windowIconPath(): string | undefined {
  const development = join(currentDir, '..', 'assets', 'icons', '512x512.png')
  return existsSync(development) ? development : undefined
}

function createWindow(options: { title?: string } = {}): BrowserWindow {
  const icon = windowIconPath()
  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 620,
    show: false,
    title: options.title ?? PRODUCT_NAME,
    // Standard native title bar: the web UI is the stock DSH UI and owns
    // its own chrome; the shell does not overlay a custom titlebar.
    ...(icon === undefined ? {} : { icon }),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#202020' : '#f7f7f5',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      webviewTag: true,
    },
  })
  window.webContents.setZoomFactor(DEFAULT_UI_ZOOM_FACTOR)
  window.once('ready-to-show', () => { window.show() })
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = undefined
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:') || url.startsWith('http:')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    if (!isAllowedBrowserNavigation(params.src ?? 'about:blank')) {
      event.preventDefault()
      return
    }
    delete webPreferences.preload
    webPreferences.nodeIntegration = false
    webPreferences.nodeIntegrationInSubFrames = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    webPreferences.webSecurity = true
    webPreferences.allowRunningInsecureContent = false
  })
  window.webContents.on('did-attach-webview', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('https:') || url.startsWith('http:')) void shell.openExternal(url)
      return { action: 'deny' }
    })
    contents.on('will-navigate', (event, url) => {
      if (isAllowedBrowserNavigation(url)) return
      event.preventDefault()
    })
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (isAllowedRuntimeNavigation(url, runtimeOrigin)) return
    event.preventDefault()
    if (url.startsWith('https:') || url.startsWith('http:')) void shell.openExternal(url)
  })
  // The DSH UI may ask for clipboard writes (copy from tool output); permit
  // only sanitized writes from the runtime origin.
  window.webContents.session.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    if (permission === 'clipboard-sanitized-write') {
      const origin = (details as { requestingUrl?: string }).requestingUrl
      if (origin !== undefined && runtimeOrigin !== undefined && originOf(origin) === runtimeOrigin) {
        callback(true)
        return
      }
    }
    callback(false)
  })
  return window
}

function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

async function showSplash(options: { detail?: string; error?: boolean; message?: string } = {}): Promise<void> {
  if (mainWindow === undefined || mainWindow.isDestroyed()) mainWindow = createWindow()
  const query: Record<string, string> = {}
  if (options.error === true) query.state = 'error'
  if (options.message !== undefined) query.message = options.message
  if (options.detail !== undefined) query.detail = options.detail.slice(0, 4_000)
  await mainWindow.loadFile(splashPath, { query })
}

function sendCommand(command: DesktopCommand): void {
  if (mainWindow === undefined || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('deepwork:command', command)
}

function normalizeWorkspacePaths(paths: readonly string[]): string[] {
  const normalized: string[] = []
  for (const candidate of paths) {
    if (!existsSync(candidate)) continue
    const absolute = resolve(candidate)
    const target = statSync(absolute).isDirectory() ? absolute : dirname(absolute)
    if (!normalized.includes(target)) normalized.push(target)
  }
  return normalized
}

function flushQueuedPaths(): void {
  const paths = normalizeWorkspacePaths(queuedPaths)
  queuedPaths = []
  if (paths.length > 0) sendCommand({ type: 'open-paths', paths })
}

function handleRuntimeExit(exit: RuntimeExit): void {
  appendLog('desktop', 'engine exited: code=' + String(exit.code) + ' signal=' + String(exit.signal))
  runtimeUrl = undefined
  runtimeOrigin = undefined
  if (quitting || transitioning) return
  void showSplash({
    error: true,
    message: 'DeepWork 已停止。可从“DeepWork”菜单重新启动。',
    detail: logTail.slice(-12).join('\n'),
  })
}

async function startRuntime(): Promise<void> {
  const info = desktopInfo()
  ensureProfile(info.dshHome, (line) => { appendLog('desktop', line) })
  const supervisor = new SidecarSupervisor(sidecarOptions(engineWorkspaceRoot(), runtimeEnvironment()))
  runtime = supervisor
  supervisor.onExit = handleRuntimeExit
  const url = await supervisor.start()
  runtimeUrl = url
  runtimeOrigin = url.origin
  if (mainWindow === undefined || mainWindow.isDestroyed()) mainWindow = createWindow()
  await mainWindow.loadURL(url.href)
  flushQueuedPaths()
}

async function restartRuntime(message = '正在重新启动 DeepWork…'): Promise<void> {
  if (transitioning) return
  transitioning = true
  try {
    await showSplash({ message })
    await runtime?.stop()
    runtime = undefined
    runtimeUrl = undefined
    runtimeOrigin = undefined
    await startRuntime()
  } finally {
    transitioning = false
  }
}

async function stopLiveForMarketplace(): Promise<void> {
  transitioning = true
  await showSplash({ message: '正在应用插件 Profile…' })
  await runtime?.stop()
  runtime = undefined
  runtimeUrl = undefined
  runtimeOrigin = undefined
}

async function startLiveForMarketplace(): Promise<void> {
  try {
    await startRuntime()
  } finally {
    transitioning = false
  }
}

function registerIpc(): void {
  ipcMain.handle('deepwork:get-info', () => desktopInfo())
  ipcMain.handle('deepwork:runtime-snapshot', () => desktopRuntimeSnapshot())
  ipcMain.handle('deepwork:choose-workspace', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'multiSelections'],
      title: '打开工作区',
      buttonLabel: '选择',
    })
    return result.canceled ? [] : normalizeWorkspacePaths(result.filePaths)
  })
  ipcMain.handle('deepwork:open-external', async (_event, url: unknown) => {
    if (typeof url !== 'string') return
    if (url.startsWith('https:') || url.startsWith('http:')) await shell.openExternal(url)
  })
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{
      label: PRODUCT_NAME,
      submenu: [
        { role: 'about' as const },
        { type: 'separator' as const },
        { label: '设置…', accelerator: 'Cmd+,', click: () => { sendCommand({ type: 'show-settings' }) } },
        { type: 'separator' as const },
        { label: '重新启动引擎', accelerator: 'Cmd+Shift+R', click: () => { void restartRuntime() } },
        { type: 'separator' as const },
        { role: 'services' as const },
        { type: 'separator' as const },
        { role: 'hide' as const },
        { role: 'hideOthers' as const },
        { role: 'unhide' as const },
        { type: 'separator' as const },
        { role: 'quit' as const },
      ],
    }] : []),
    {
      label: '文件',
      submenu: [
        { label: '新建会话', accelerator: 'CmdOrCtrl+N', click: () => { sendCommand({ type: 'new-session' }) } },
        { label: '打开工作区…', accelerator: 'CmdOrCtrl+O', click: async () => {
          const result = await dialog.showOpenDialog({
            properties: ['openDirectory', 'multiSelections'],
            title: '打开工作区',
          })
          if (!result.canceled) sendCommand({ type: 'open-paths', paths: normalizeWorkspacePaths(result.filePaths) })
        } },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
        ...(isMac ? [
          { role: 'pasteAndMatchStyle' as const },
          { role: 'delete' as const },
          { role: 'selectAll' as const },
        ] : [
          { role: 'delete' as const },
          { type: 'separator' as const },
          { role: 'selectAll' as const },
        ]),
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '切换侧边栏', accelerator: 'CmdOrCtrl+B', click: () => { sendCommand({ type: 'toggle-sidebar' }) } },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [
          { type: 'separator' as const },
          { role: 'front' as const },
        ] : [
          { role: 'close' as const },
        ]),
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

const hasLock = app.requestSingleInstanceLock()
if (!hasLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    const paths = argv.slice(1).filter(argument => !argument.startsWith('-'))
    if (paths.length > 0) queuedPaths.push(...paths)
    if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
      flushQueuedPaths()
    }
  })

  app.on('open-file', (event, path) => {
    event.preventDefault()
    queuedPaths.push(path)
    flushQueuedPaths()
  })

  app.whenReady().then(async () => {
    registerIpc()
    buildMenu()
    if (process.platform === 'darwin') app.on('activate', () => {
      if (mainWindow !== undefined && !mainWindow.isDestroyed()) mainWindow.show()
    })

    // Desktop-owned state (logs) lives in userData.
    const userData = app.getPath('userData')
    mkdirSync(userData, { recursive: true })
    logStream = createWriteStream(join(userData, 'logs', 'desktop.log'), { flags: 'a' })
    appendLog('desktop', 'DeepWork ' + app.getVersion() + ' starting on ' + process.platform)

    try {
      await showSplash({ message: '正在启动引擎…' })
      await startRuntime()
    } catch (error) {
      appendLog('desktop', 'startup failed: ' + (error instanceof Error ? error.stack ?? error.message : String(error)))
      await showSplash({
        error: true,
        message: 'DeepWork 启动失败',
        detail: logTail.slice(-20).join('\n'),
      }).catch(() => {})
    }
  })

  app.on('before-quit', (event) => {
    if (quitting) return
    quitting = true
    event.preventDefault()
    void (async () => {
      try {
        await runtime?.stop().catch(() => {})
        logStream?.end()
      } finally {
        app.exit(0)
      }
    })()
  })

  app.on('window-all-closed', () => {
    app.quit()
  })
}
