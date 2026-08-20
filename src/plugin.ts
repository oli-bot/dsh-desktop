/**
 * Host face of the DeepWork desktop plugin.
 *
 * Publishes desktop surface facts into the sidecar engine's Host graph: the
 * model is told which surface it is on, other plugins can read the desktop
 * capability, and the same facts are exposed to tool subprocesses through the
 * bash environment.
 */

interface PromptSection {
  name: string
  order: number
  text: () => string
}

interface PromptRegistry {
  section(entry: PromptSection): unknown
}

interface EnvironmentVariables {
  [name: string]: { description: string }
}

interface EnvironmentRegistry {
  register(entry: {
    name: string
    variables: EnvironmentVariables
    resolve: () => Record<string, string>
  }): unknown
}

interface HostServices {
  systemPrompt: PromptRegistry
  bashEnv: EnvironmentRegistry
}

interface HostContext {
  inject(names: string[], callback: (ctx: HostContext & HostServices) => void): void
  provide(name: string, value: unknown): void
}

/** Stable Cordis plugin name. */
export const name = 'deepwork-desktop'

/** Facts about the running desktop surface, published for other Host plugins. */
export interface DesktopHostCapability {
  appDataPath: string
  kind: 'electron'
  platform: NodeJS.Platform
  profile: string
  version: string
}

function readCapability(): DesktopHostCapability {
  return Object.freeze({
    appDataPath: process.env.DEEPWORK_APP_DATA ?? '',
    kind: 'electron',
    platform: process.platform,
    profile: process.env.DEEPWORK_PROFILE ?? 'web',
    version: process.env.DEEPWORK_VERSION ?? '0.0.0',
  })
}

function surfaceDescription(capability: DesktopHostCapability): string {
  const parts = [
    'You are interacting with the user through DeepWork ' + capability.version + ' on ' + capability.platform + '.',
    'DeepWork is an Electron desktop application around DeepSeek Harness:',
    'an Electron shell supervises a sidecar dsh engine, and Chromium hosts the DSH web UI.',
    'The desktop shares the same $DSH_HOME as the CLI and the browser GUI.',
    'When the user says "this app" without naming another target, they mean DeepWork.',
  ]
  return parts.join(' ')
}

/** Mount the desktop capability and surface facts in the DSH graph. */
export function apply(ctx: HostContext): void {
  const capability = readCapability()
  ctx.provide('desktop', capability)

  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.systemPrompt.section({
      name: 'app:deepwork-desktop-surface',
      order: -98,
      text: () => surfaceDescription(capability),
    })
  })

  ctx.inject(['bashEnv'], (runtimeCtx) => {
    runtimeCtx.bashEnv.register({
      name: 'deepwork-desktop-runtime',
      variables: {
        DEEPWORK: { description: 'Set to 1 inside the DeepWork distribution.' },
        DEEPWORK_APP_DATA: { description: 'Writable application-data root owned by DeepWork.' },
        DEEPWORK_PROFILE: { description: 'DSH profile mounted by DeepWork.' },
        DEEPWORK_VERSION: { description: 'Installed DeepWork version.' },
      },
      resolve: () => ({
        DEEPWORK: '1',
        DEEPWORK_APP_DATA: capability.appDataPath,
        DEEPWORK_PROFILE: capability.profile,
        DEEPWORK_VERSION: capability.version,
      }),
    })
  })
}
