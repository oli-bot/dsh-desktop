# Security

DeepWork is a **desktop application**, not an ordinary in-host dsh plugin. It
runs on the user's own machine with the same trust boundary as running the
`dsh` CLI by hand, and it may therefore legitimately spawn processes and read
the environment. This document explains the threat model so a static scan's
"Critical: child_process" and "Info: process.env" findings can be judged in
context.

## Runtime trust model

- The app boots on the user's machine under the user's own account/authority.
- Everything the shell does is what the user could equivalently do by running
  `dsh` themselves; nothing runs with elevated privileges and no code is
  downloaded and executed from a remote source at runtime.
- The application is a lean Electron shell + the stock `dsh web` UI. There is
  no plugin marketplace, no preview-installer, and no remote patch updater in
  this codebase.

## Processes the shell spawns

| Where | What | Why | Notes |
| --- | --- | --- | --- |
| `src/runtime.ts` | the sidecar `dsh` engine (`<node> <dsh CLI> --profile web --patch <cordis.patch.yml>`) | this **is** the application | `spawn` with an argument array, `shell: false`; args are fixed/derived locally, no user input reaches the command line |
| `src/profile.ts` | `pnpm install` in the profile dir | link/install `@deepwork/desktop` into the shared profile | `spawnSync('pnpm', [...])`, argument array, no shell |
| `scripts/*.mjs` / `scripts/after-pack.cjs` | `pnpm`, `curl`, `tar`, `electron-builder` | **build-time only** packaging/staging tooling | never shipped, never executed on an end-user's machine |

All process spawns use argument arrays with `shell: false`. There is no shell
string interpolation, so there is no command-injection surface.

## Environment reads (flagged "Info")

`process.env` reads are configuration knobs only and are never mutated back
into the environment:

- `DSH_HOME`, `DSH_SOURCE`, `DEEPWORK_ENGINE`, `DEEPWORK_NODE`,
  `DEEPWORK_NODE_PLATFORM/ARCH/VERSION`, `DEEPWORK_MAC_ARCH`, `DEEPWORK_WIN_ARCH`,
  `DEEPWORK_APP_DATA/PROFILE/VERSION`, `ELECTRON_BUILDER_CACHE`,
  `DEEPWORK_SIGN_IDENTITY`.
- No secrets are read from the environment. API credentials are handled by the
  DSH credentials storage in the shared `$DSH_HOME`, not by this shell.

## Network

- The engine Web runtime binds only `127.0.0.1` on an OS-assigned random port;
  no port is opened externally.
- The shell makes **no outbound network requests at runtime**. Downloads happen
  only at **build time** and are pinned and verified:
  - the DSH source checkout is pinned to commit
    `47f943859bef60e4160492346772ded9b24f765a` (`v0.1.0-rc.5`);
  - the Node.js runtime archive is downloaded from `nodejs.org` and verified
    against the `SHASUMS256` file before extraction.
- The only loopback string in tests (`http://127.0.0.1:41023`) is a unit-test
  fixture for the sidecar's readiness-line parser; the test makes no HTTP
  request at all.

## Data

- No telemetry, analytics, or crash reporting. Logs are written under the
  Electron userData directory and never leave the machine.
- Sessions, credentials, settings and attachments live in the shared
  `$DSH_HOME` and are handled by DSH itself.

## Reporting

If you find an actual vulnerability (anything beyond the expected use of
`child_process`/`process.env` described above), open a private advisory or an
issue in this repository (do not contact DeepSeek official support — this is a
community project). See also `THIRD_PARTY_NOTICES.md` for upstream components
and their licenses.
