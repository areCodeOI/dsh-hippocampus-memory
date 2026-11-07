/**
 * Resolve the Node.js executable to spawn.
 *
 * On Android/Termux `process.execPath` points at the dynamic linker
 * (/apex/.../linker64), so spawning it with a script argument fails with
 * "bad ELF magic". `process.argv0` is the real node launcher there.
 */

import fs from 'node:fs'

export function nodeExecutable() {
  const argv0 = process.argv0
  if (argv0 && argv0 !== 'node' && argv0 !== 'nodejs') {
    try {
      fs.accessSync(argv0, fs.constants.X_OK)
      return argv0
    } catch {
      // fall through
    }
  }
  return process.execPath
}
