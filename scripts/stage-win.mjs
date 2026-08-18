/**
 * Stage the DSH runtime plus the WINDOWS x64 Node.js runtime.
 *
 * stage-dsh.mjs defaults the bundled Node to the host platform; Windows
 * installers must embed node.exe instead of a POSIX bin/node, so this thin
 * wrapper pins the target before the stage runs (cross-platform: works from
 * macOS or Windows hosts).
 */
process.env.DEEPWORK_NODE_PLATFORM = 'win'
process.env.DEEPWORK_NODE_ARCH = 'x64'

await import('./stage-dsh.mjs')
