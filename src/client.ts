/**
 * Browser face of the DeepWork desktop shell.
 *
 * A thin command bridge only: native menu actions arrive through the preload
 * bridge and are forwarded to stock DSH client services. The web UI itself is
 * the unmodified DSH UI served by the sidecar engine.
 */

import type { DesktopBridge, DesktopCommand } from './contracts.ts'

interface ObservableSnapshot<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

interface SessionSummary {
  cwd?: string
}

interface SessionListState {
  current?: string
  byId: Record<string, SessionSummary>
}

interface SessionsService {
  list: ObservableSnapshot<SessionListState>
}

interface WorkspaceView {
  workspaceId: string
}

interface WorkspacesService {
  create(input: { path: string }): Promise<WorkspaceView>
  startSession(workspaceId?: string): void
}

interface LayoutService {
  toggleSidebar(): void
}

interface ClientContext {
  effect(effect: () => (() => void) | void, label?: string): void
  get(name: string): unknown
  reflect: { provide(name: string, value: unknown, options?: unknown): (() => Promise<void> | void) | void }
}

declare global {
  interface Window {
    dshDesktop?: DesktopBridge
  }
}

/** Wait for the DSH services used by native menu commands. */
export const inject = ['sessions', 'workspaces', 'layout']

function focusComposer(): void {
  document.querySelector<HTMLTextAreaElement>('textarea')?.focus()
}

function findSettingsButton(): HTMLButtonElement | undefined {
  const slotted = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find(button => button.querySelector('[data-slot="settings.trigger"]') !== null
      && button.closest('[data-slot="sidebar"]') !== null)
  if (slotted !== undefined) return slotted
  const labeled = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find(button => /settings|设置/i.test([
      button.textContent,
      button.getAttribute('aria-label'),
      button.getAttribute('title'),
    ].filter(Boolean).join(' ')))
  return labeled
}

function openWorkspaces(workspaces: WorkspacesService, paths: readonly string[]): void {
  for (const path of paths) {
    void workspaces.create({ path }).then((workspace) => {
      workspaces.startSession(workspace.workspaceId)
    }).catch((error: unknown) => {
      console.error('deepwork-desktop: failed to open workspace', error)
    })
  }
}

function handle(command: DesktopCommand, services: {
  layout: LayoutService
  sessions: SessionsService
  workspaces: WorkspacesService
}): void {
  switch (command.type) {
    case 'focus-composer':
      focusComposer()
      return
    case 'new-session':
      services.workspaces.startSession()
      return
    case 'open-paths':
      openWorkspaces(services.workspaces, command.paths)
      return
    case 'show-settings':
      findSettingsButton()?.click()
      return
    case 'toggle-sidebar':
      services.layout.toggleSidebar()
      return
    default:
      command satisfies never
  }
}

/** Enroll the isolated Electron bridge and forward native actions to DSH services. */
export function apply(ctx: ClientContext): void {
  const bridge = window.dshDesktop
  if (bridge === undefined) {
    throw new Error('deepwork-desktop: preload bridge is unavailable outside DeepWork')
  }
  const services = {
    layout: ctx.get('layout') as LayoutService,
    sessions: ctx.get('sessions') as SessionsService,
    workspaces: ctx.get('workspaces') as WorkspacesService,
  }
  ctx.reflect.provide('desktopShell', bridge, undefined)
  ctx.effect(() => {
    const unsubscribe = bridge.onCommand((command) => {
      handle(command, services)
    })
    return () => { unsubscribe() }
  }, 'deepwork-desktop: native command bridge')
}
