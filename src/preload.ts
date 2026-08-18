/**
 * Isolated preload for the DeepWork web surface.
 *
 * Exposes a minimal, immutable bridge to the renderer via contextBridge.
 */

import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopBridge, DesktopCommand, DesktopInfo, DesktopRuntimeSnapshot } from './contracts.ts'

const bridge: DesktopBridge = {
  chooseWorkspace: (): Promise<string[]> => ipcRenderer.invoke('deepwork:choose-workspace'),
  getInfo: (): Promise<DesktopInfo> => ipcRenderer.invoke('deepwork:get-info'),
  getRuntimeSnapshot: (): Promise<DesktopRuntimeSnapshot> => ipcRenderer.invoke('deepwork:runtime-snapshot'),
  onCommand: (listener: (command: DesktopCommand) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, command: DesktopCommand): void => { listener(command) }
    ipcRenderer.on('deepwork:command', handler)
    return () => { ipcRenderer.removeListener('deepwork:command', handler) }
  },
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('deepwork:open-external', url),
}

contextBridge.exposeInMainWorld('dshDesktop', bridge)
