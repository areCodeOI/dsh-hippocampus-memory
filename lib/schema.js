/**
 * Optional @deepseek-ai/schemastery loader.
 *
 * Why this exists: DSH installs a local checkout with a `link:` dependency.
 * pnpm then symlinks the package into the profile, but Node resolves ESM bare
 * specifiers from the *realpath* of the importing file (unless
 * --preserve-symlinks is set). A git checkout normally has no node_modules, so
 * `import '@deepseek-ai/schemastery'` fails and the whole plugin fails to
 * activate — even though the host has the package in its profile.
 *
 * Resolution order:
 *   1. the normal bare import (published install / checkout with node_modules)
 *   2. the DSH profile node_modules (same copy the host itself loaded)
 *   3. Electron's bundled app.asar (asar-aware require)
 *   4. give up: return null so index.js exports no Config schema. Cordis passes
 *      the raw config through when a plugin has no Config, so the plugin still
 *      activates instead of dying on a missing schema builder.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const PACKAGE = '@deepseek-ai/schemastery'

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/** node_modules directories that may contain the host's copy of the package. */
function candidateModulesDirs() {
  const dirs = new Set()
  const cwd = process.cwd()
  if (cwd) dirs.add(path.join(cwd, 'node_modules'))

  // Every DSH profile keeps bundle dependencies hoisted here. The desktop
  // profile is the common case; scanning keeps this independent of profile name.
  const profilesDir = path.join(dshHome(), 'profiles')
  try {
    for (const entry of fs.readdirSync(profilesDir, { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.add(path.join(profilesDir, entry.name, 'node_modules'))
    }
  } catch {
    // no profiles directory (MCP/CLI usage outside DSH)
  }
  dirs.add(path.join(dshHome(), 'node_modules'))

  // Electron bundles its own node_modules inside app.asar. process.resourcesPath
  // is only defined in Electron processes; plain Node will just skip it.
  const resources = process.resourcesPath
  if (resources) {
    dirs.add(path.join(resources, 'app.asar', 'node_modules'))
    dirs.add(path.join(resources, 'app.asar.unpacked', 'node_modules'))
  }
  return [...dirs]
}

async function importFromModuleDir(modulesDir) {
  const require = createRequire(path.join(modulesDir, 'noop.js'))
  const resolved = require.resolve(PACKAGE)
  try {
    const mod = await import(pathToFileURL(resolved).href)
    return mod?.default ?? mod
  } catch {
    // app.asar is not a real directory for the default ESM loader; Electron's
    // patched CommonJS require can still read it.
    const mod = require(resolved)
    return mod?.default ?? mod
  }
}

let cached

/** Load schemastery, or null when only the fallback (no Config) is possible. */
export async function loadSchema() {
  if (cached !== undefined) return cached
  let firstError = null
  try {
    const mod = await import(PACKAGE)
    cached = mod?.default ?? mod
    return cached
  } catch (error) {
    firstError = error
  }
  for (const modulesDir of candidateModulesDirs()) {
    try {
      const schema = await importFromModuleDir(modulesDir)
      if (typeof schema === 'function') {
        cached = schema
        return cached
      }
    } catch {
      // try the next location
    }
  }
  cached = null
  const reason = firstError instanceof Error ? firstError.message : String(firstError)
  console.warn(
    '[hippocampus] @deepseek-ai/schemastery not resolvable from the plugin checkout ' +
      '(link install without node_modules). Continuing without a Config schema; ' +
      `defaults from cordis.patch.yml still apply. (${reason})`,
  )
  return null
}
