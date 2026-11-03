import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const artifacts = path.join(root, '.artifacts')
const artifact = path.join(artifacts, 'api')
const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'))
const writeJson = (file, value) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
const api = await readJson(path.join(root, 'apps/api/package.json'))
const workspace = await readJson(path.join(root, 'package.json'))
const lock = await readJson(path.join(root, 'package-lock.json'))
const runtimeWorkspaces = ['apps/api', 'packages/engine', 'packages/shared']

async function assertNoLinks(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    assert(!entry.isSymbolicLink(), `Artifact must not contain links: ${entry.name}`)
    if (entry.isDirectory()) await assertNoLinks(path.join(directory, entry.name))
  }
}

await mkdir(artifacts, { recursive: true })
const work = await mkdtemp(path.join(tmpdir(), 'accessiweb-api-'))
const install = path.join(work, 'install')
const smoke = path.join(work, 'smoke')

try {
  await rm(artifact, { recursive: true, force: true })
  await mkdir(install)
  const dependencies = {}
  for (const workspacePath of runtimeWorkspaces) {
    const manifest = await readJson(path.join(root, workspacePath, 'package.json'))
    for (const name of Object.keys(manifest.dependencies)) {
      const dependency = lock.packages[`${workspacePath}/node_modules/${name}`]
        ?? lock.packages[`node_modules/${name}`]
      assert(dependency?.version && !dependency.link, `Missing locked runtime dependency: ${name}`)
      assert(!dependencies[name] || dependencies[name] === dependency.version, `Conflicting runtime dependency: ${name}`)
      dependencies[name] = dependency.version
    }
  }
  const manifest = {
    name: api.name,
    version: api.version,
    private: true,
    type: api.type,
    main: api.main,
    dependencies,
    overrides: workspace.overrides,
  }
  // Project the committed lock into a standalone package without resolving new versions.
  const packages = { '': manifest }
  for (const [location, dependency] of Object.entries(lock.packages)) {
    if (location.startsWith('node_modules/') && !dependency.link) packages[location] = dependency
  }
  for (const workspacePath of runtimeWorkspaces) {
    const prefix = `${workspacePath}/`
    for (const [location, dependency] of Object.entries(lock.packages)) {
      if (!location.startsWith(`${prefix}node_modules/`)) continue
      const standalonePath = location.slice(prefix.length)
      packages[standalonePath] = dependency
    }
  }
  await writeJson(path.join(install, 'package.json'), manifest)
  await writeJson(path.join(install, 'package-lock.json'), { ...lock, packages })
  execFileSync('npm', [
    'install', '--package-lock-only', '--offline', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund',
  ], { cwd: install, stdio: 'inherit' })
  const standaloneLock = await readJson(path.join(install, 'package-lock.json'))
  const pinnedPackages = new Set(Object.values(lock.packages).map((dependency) =>
    JSON.stringify([dependency.version, dependency.resolved, dependency.integrity])))
  for (const [location, dependency] of Object.entries(standaloneLock.packages)) {
    if (!location) continue
    assert(location.startsWith('node_modules/') && !dependency.link, `Workspace path leaked: ${location}`)
    assert(pinnedPackages.has(JSON.stringify([dependency.version, dependency.resolved, dependency.integrity])),
      `Dependency changed from committed lock: ${location}`)
  }
  execFileSync('npm', [
    'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund',
    '--bin-links=false',
  ], { cwd: install, stdio: 'inherit' })

  await mkdir(artifact, { recursive: true })
  await cp(path.join(install, 'node_modules'), path.join(artifact, 'node_modules'), { recursive: true })
  await cp(path.join(root, 'apps/api/dist'), path.join(artifact, 'dist'), { recursive: true })
  await cp(path.join(root, 'apps/api/host.json'), path.join(artifact, 'host.json'))
  await cp(path.join(install, 'package.json'), path.join(artifact, 'package.json'))
  await cp(path.join(install, 'package-lock.json'), path.join(artifact, 'package-lock.json'))
  await assertNoLinks(artifact)
  await cp(artifact, smoke, { recursive: true })
  execFileSync('npm', ['ls', '--omit=dev', '--all', '--workspaces=false'], {
    cwd: smoke,
    stdio: ['ignore', 'ignore', 'inherit'],
  })

  // Reject both ESM and CommonJS fallback to the checkout's node_modules.
  const smokeSource = `
    import assert from 'node:assert/strict';
    import Module, { isBuiltin, register } from 'node:module';
    import { readFile } from 'node:fs/promises';
    import { pathToFileURL } from 'node:url';
    const base = process.cwd() + '/';
    const originalResolve = Module._resolveFilename;
    Module._resolveFilename = function (...args) {
      const resolved = originalResolve.apply(this, args);
      assert(isBuiltin(resolved) || resolved.startsWith(base), 'CommonJS dependency escaped artifact: ' + resolved);
      return resolved;
    };
    const baseUrl = pathToFileURL(base).href;
    const loader = 'export async function resolve(specifier, context, next) {'
      + 'const result = await next(specifier, context);'
      + 'if (result.url.startsWith("file:") && !result.url.startsWith(' + JSON.stringify(baseUrl) + '))'
      + 'throw new Error("ESM dependency escaped artifact: " + result.url);'
      + 'return result; }';
    register('data:text/javascript,' + encodeURIComponent(loader), import.meta.url);
    await import('zod');
    await import('typescript');
    await import('./dist/packages/shared/src/schemas.js');
    await import('./dist/packages/engine/src/metaClient.js');
    const manifest = JSON.parse(await readFile('package.json', 'utf8'));
    await import('./' + manifest.main);
    console.log('Standalone API smoke passed: shared, engine, runtime dependencies, Functions entry.');
  `
  execFileSync(process.execPath, ['--input-type=module', '--eval', smokeSource], {
    cwd: smoke,
    env: { PATH: process.env.PATH },
    stdio: 'inherit',
  })
} finally {
  await rm(work, { recursive: true, force: true })
}
