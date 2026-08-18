import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureProfile, profileFingerprint } from '../src/profile.ts'

test('ensureProfile provisions manifest, patch, and workspace', () => {
  const home = mkdtempSync(join(tmpdir(), 'deepwork-home-'))
  const result = ensureProfile(home, () => {})
  const profileDir = join(home, 'profiles', 'deepwork')
  assert.equal(result.profileDir, profileDir)
  const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
  assert.equal(typeof manifest.dependencies['@deepwork/desktop'], 'string')
  assert.ok(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8').includes('[]'))
  assert.ok(readFileSync(join(profileDir, 'pnpm-workspace.yaml'), 'utf8').includes('nodeLinker: hoisted'))
})

test('profile fingerprint is stable and sensitive to manifest changes', () => {
  const home = mkdtempSync(join(tmpdir(), 'deepwork-home-'))
  ensureProfile(home, () => {})
  const profileDir = join(home, 'profiles', 'deepwork')
  const first = profileFingerprint(profileDir)
  assert.equal(first, profileFingerprint(profileDir))
  const manifestPath = join(profileDir, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.dependencies['example-plugin'] = 'file:/tmp/example'
  writeFileSync(manifestPath, JSON.stringify(manifest, undefined, 2) + '\n')
  assert.notEqual(first, profileFingerprint(profileDir))
})
