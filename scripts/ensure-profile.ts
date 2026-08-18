/** CLI helper: provision the DeepWork profile under the shared home. */
import { ensureProfile } from '../src/profile.ts'
import { sharedDshHome } from '../src/runtime.ts'

const result = ensureProfile(sharedDshHome(), (line) => process.stdout.write(line))
console.log('profile: ' + result.profileDir + ' installed=' + String(result.installed))
