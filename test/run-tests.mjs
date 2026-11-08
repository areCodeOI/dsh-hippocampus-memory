// `--test-isolation=none` exists on Node 24+ but is a "bad option" on Node 22
// (CI uses 22.23.4). Android/Termux needs isolation=none because the default
// child-process isolation breaks on the linker path; Linux/macOS/Windows CI
// works either way. Probe once and fall back for Node 22.
import { spawnSync } from 'node:child_process'

const probe = spawnSync(process.execPath, ['--test-isolation=none', '--version'], { stdio: 'ignore' })
const args = ['--test', 'test/all.test.mjs']
if (probe.status === 0) args.splice(1, 0, '--test-isolation=none')
const child = spawnSync(process.execPath, args, { stdio: 'inherit' })
process.exit(child.status ?? 1)
