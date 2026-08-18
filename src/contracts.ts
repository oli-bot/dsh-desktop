/**
 * Contracts for the DeepWork desktop bridge.
 *
 * The shell exposes only native facts (home, version, platform), a command
 * channel, and simple native actions. All UI behavior lives in the DSH web
 * UI loaded from the sidecar engine.
 */

/** Commands sent from Electron's native chrome to the DSH client plugin. */
export type DesktopCommand =
  | { type: 'focus-composer' }
  | { type: 'new-session' }
  | { type: 'open-paths'; paths: string[] }
  | { type: 'show-settings' }
  | { type: 'toggle-sidebar' }

/** Public facts exposed by the isolated Electron preload. */
export interface DesktopInfo {
  appDataPath: string
  dshHome: string
  platform: NodeJS.Platform
  profile: string
  version: string
}

/** Runtime diagnostics shown by the shell. */
export interface DesktopRuntimeSnapshot {
  logTail: string[]
  profile: string
  runtimeUrl: string | null
  status: 'ready' | 'restarting' | 'stopped'
}

/** Browser-safe desktop bridge made available through contextBridge. */
export interface DesktopBridge {
  chooseWorkspace(): Promise<string[]>
  getInfo(): Promise<DesktopInfo>
  getRuntimeSnapshot(): Promise<DesktopRuntimeSnapshot>
  onCommand(listener: (command: DesktopCommand) => void): () => void
  openExternal(url: string): Promise<void>
}
