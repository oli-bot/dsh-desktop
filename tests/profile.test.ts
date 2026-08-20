import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureProfile, profileFingerprint } from '../src/profile.ts'

test('ensureProfile provisions manifest, patch, and workspace', () => {
  const home = mkdtempSync(join(tmpdir(), 'deepwork-home-'))
  const result = ensureProfile(home, () => {})
  const profileDir = join(home, 'profiles', 'web')
  assert.equal(result.profileDir, profileDir)
  const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
  assert.equal(typeof manifest.dependencies['@deepwork/desktop'], 'string')
  assert.ok(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8').includes('[]'))
  assert.ok(readFileSync(join(profileDir, 'pnpm-workspace.yaml'), 'utf8').includes('nodeLinker: hoisted'))
})

test('ensureProfile preserves the shared web profile bundles and dependencies', () => {
  const home = mkdtempSync(join(tmpdir(), 'deepwork-home-'))
  const injector = join(home, 'injector')
  const existingPlugin = join(home, 'existing-plugin')
  mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
  mkdirSync(injector, { recursive: true })
  mkdirSync(existingPlugin, { recursive: true })
  writeFileSync(join(injector, 'package.json'), JSON.stringify({
    name: '@dsh-external/dsh-super-injector',
    version: '0.0.0-test',
  }))
  writeFileSync(join(home, 'profiles', 'web', 'package.json'), JSON.stringify({
    name: 'existing-web-profile',
    private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@dsh-external/dsh-super-injector'] } },
    dependencies: {
      '@dsh-external/dsh-super-injector': `link:${injector}`,
      'existing-plugin': `link:${existingPlugin}`,
    },
  }))

  ensureProfile(home, () => {})
  const manifest = JSON.parse(readFileSync(join(home, 'profiles', 'web', 'package.json'), 'utf8'))
  assert.equal(manifest.name, 'existing-web-profile')
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@dsh-external/dsh-super-injector'])
  assert.equal(manifest.dependencies['@dsh-external/dsh-super-injector'], `link:${injector}`)
  assert.equal(manifest.dependencies['existing-plugin'], `link:${existingPlugin}`)
  assert.match(manifest.dependencies['@deepwork/desktop'], /^link:/)
})

test('profile fingerprint is stable and sensitive to manifest changes', () => {
  const home = mkdtempSync(join(tmpdir(), 'deepwork-home-'))
  ensureProfile(home, () => {})
  const profileDir = join(home, 'profiles', 'web')
  const first = profileFingerprint(profileDir)
  assert.equal(first, profileFingerprint(profileDir))
  const manifestPath = join(profileDir, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.dependencies['example-plugin'] = 'file:/tmp/example'
  writeFileSync(manifestPath, JSON.stringify(manifest, undefined, 2) + '\n')
  assert.notEqual(first, profileFingerprint(profileDir))
})
