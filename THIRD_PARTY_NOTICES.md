# Third-Party Notices

DeepWork is a community-maintained desktop shell for DeepSeek Harness (DSH).
This file lists the third-party components that are bundled or referenced by
the published application. Each component is used under its own license; full
license texts are available in the upstream projects.

## DeepSeek Harness (DSH)

- Repository: https://github.com/deepseek-ai/deepseek-harness
- Pinned revision: `47f943859bef60e4160492346772ded9b24f765a` (v0.1.0-rc.5)
- License: MIT

The installed application embeds a staged copy of this runtime as its backend
engine (`DSH_SOURCE` may point at a local checkout of the same version).

## Electron

- Repository: https://github.com/electron/electron
- License: MIT

Electron is the desktop shell runtime. It bundles Chromium and Node.js; see
the Electron project for its full dependency notices.

## Node.js

- Repository: https://github.com/nodejs/node
- License: Node.js (MIT-style)

A Node.js runtime is staged into the application to run the DSH engine
sidecar (the harness loader requires a real Node, not Electron's embedded
Node).

## Build tooling (development-time)

- `electron-builder` (MIT), `esbuild` (MIT), `pnpm` (MIT), `typescript`
  (Apache-2.0) — used only during build; not shipped in the installer.

The desktop shell source itself (`src/`, `scripts/`, assets) is original code
licensed under [MIT](./LICENSE).