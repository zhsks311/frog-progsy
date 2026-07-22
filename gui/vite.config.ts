import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const guiRoot = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

// Bake the parent package version into the bundle as a fallback for moments when the runtime
// `/healthz` version is not reachable yet.
const version = pkg.version as string

function collectBuildInputFiles(path: string, out: string[] = []): string[] {
  if (!existsSync(path)) return out
  const info = statSync(path)
  if (info.isFile()) {
    out.push(path)
    return out
  }
  for (const entry of readdirSync(path).sort()) {
    if (entry === 'dist' || entry === 'node_modules' || entry.startsWith('.')) continue
    collectBuildInputFiles(join(path, entry), out)
  }
  return out
}

export function listGuiBuildInputFiles(guiDir = guiRoot, rootDir = repoRoot): string[] {
  const files = collectBuildInputFiles(guiDir)
  const rootPackage = join(rootDir, 'package.json')
  if (existsSync(rootPackage)) files.push(rootPackage)
  return [...new Set(files)].sort()
}

export function computeGuiSourceHash(guiDir = guiRoot, rootDir = repoRoot): string {
  const hash = createHash('sha256')
  const files = listGuiBuildInputFiles(guiDir, rootDir)
  for (const file of files) {
    if (!existsSync(file)) continue
    hash.update(relative(rootDir, file))
    hash.update('\0')
    hash.update(readFileSync(file))
    hash.update('\0')
  }
  return hash.digest('hex')
}

const guiSourceHash = computeGuiSourceHash()
const appBuildId = `${version}-${guiSourceHash.slice(0, 12)}`

function writeBuildMetaPlugin() {
  return {
    name: 'frogprogsy-build-meta',
    closeBundle() {
      const distDir = join(guiRoot, 'dist')
      mkdirSync(distDir, { recursive: true })
      writeFileSync(join(distDir, 'build-meta.json'), JSON.stringify({
        schemaVersion: 1,
        appBuildId,
        version,
        generatedAt: new Date().toISOString(),
        sourceHash: guiSourceHash,
      }, null, 2) + '\n')
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), writeBuildMetaPlugin()],
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __APP_BUILD_ID__: JSON.stringify(appBuildId),
  },
})
