import { Dirent, realpath as realpathCallback } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { basename, dirname, join, posix, resolve } from 'node:path'
import { promisify } from 'node:util'
import { parse } from 'yaml'

/**
 * The real path as Node resolves modules. Node's module resolution uses the
 * implementation of `fs.realpath` that resolves the links along the path one
 * by one and keeps the rest of the path as given. `fs.promises.realpath` uses
 * the libuv implementation, which on Windows also expands 8.3 short names and
 * normalizes the case, so that its result can differ from module URLs.
 */
export const realpath: (path: string) => Promise<string> = promisify(realpathCallback)

/** A package installed at a location. */
export interface PackageState {
  /** the name in the installed manifest, which differs from the directory name for an alias */
  name: string
  version?: string
  /** An identifier of the content. Two states with equal resolutions have equal contents. */
  resolution: string
  /**
   * Whether the install state does not record the content, as for a `file:`,
   * `link:`, `portal:` or workspace dependency and a package bundled in one.
   */
  local: boolean
  /**
   * The real directory of the location when the state was read, as Node
   * resolves modules. It differs from the location for a link at the location
   * or at an ancestor, and a removed link keeps its last target.
   */
  realPath: string
}

export type InstallState = Map<string, PackageState>

async function readText(path: string) {
  try {
    return await readFile(path, 'utf8')
  } catch (error: any) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return
    throw error
  }
}

async function readName(dir: string): Promise<string | undefined> {
  const text = await readText(resolve(dir, 'package.json'))
  if (!text) return
  try {
    const { name } = JSON.parse(text)
    return typeof name === 'string' ? name : undefined
  } catch {}
}

async function createLocator(root: string) {
  const realRoot = await realpath(root).catch(() => resolve(root))
  const parents = new Map<string, Promise<string>>()
  return async (location: string, local: boolean) => {
    const path = resolve(root, location)
    const fallback = resolve(realRoot, location)
    if (local) return realpath(path).catch(() => fallback)
    const parent = dirname(path)
    let real = parents.get(parent)
    if (!real) parents.set(parent, real = realpath(parent).catch(() => dirname(fallback)))
    return join(await real, basename(path))
  }
}

export function splitName(spec: string): [string, string] {
  const index = spec.indexOf('@', spec.startsWith('@') ? 1 : 0)
  if (index <= 0) return [spec, '']
  return [spec.slice(0, index), spec.slice(index + 1)]
}

export function nameOf(location: string) {
  const index = location.lastIndexOf('node_modules/')
  return index < 0 ? location : location.slice(index + 'node_modules/'.length)
}

function identifyNpm(packages: Record<string, any>) {
  // A bundled entry records only its version, since its content is that of
  // the tarball of its bundler, i.e. the nearest enclosing package that is
  // not bundled itself.
  const identify = (location: string): Pick<PackageState, 'resolution' | 'local'> => {
    const entry = packages[location]
    if (entry.link) return { resolution: `link:${entry.resolved}`, local: true }
    const own = entry.integrity ?? entry.resolved ?? `${entry.name ?? nameOf(location)}@${entry.version}`
    const local = !entry.integrity && !!entry.resolved?.startsWith('file:')
    const index = location.lastIndexOf('/node_modules/')
    if (!entry.inBundle || index < 0) return { resolution: own, local }
    const bundler = location.slice(0, index)
    // a workspace or the target of a link
    if (!bundler.includes('node_modules/') || !packages[bundler]) return { resolution: own, local: true }
    const outer = identify(bundler)
    return { resolution: `${own} ${outer.resolution}`, local: local || outer.local }
  }
  return identify
}

export async function readNpmState(root: string): Promise<InstallState> {
  const state: InstallState = new Map()
  const text = await readText(resolve(root, 'node_modules/.package-lock.json'))
  if (!text) return state
  const packages: Record<string, any> = JSON.parse(text).packages ?? {}
  const locate = await createLocator(root)
  const identify = identifyNpm(packages)

  for (const [location, entry] of Object.entries(packages)) {
    if (!location.includes('node_modules/')) continue
    if (entry.link) {
      // the name is recorded by the target entry, if it differs from the directory name
      const name = packages[entry.resolved]?.name ?? await readName(resolve(root, entry.resolved)) ?? nameOf(location)
      state.set(location, { name, ...identify(location), realPath: await locate(location, true) })
      continue
    }
    const identity = identify(location)
    const realPath = await locate(location, identity.local)
    state.set(location, { name: entry.name ?? nameOf(location), version: entry.version, ...identity, realPath })
  }
  return state
}

export async function readPnpmState(root: string): Promise<InstallState> {
  const state: InstallState = new Map()
  const [modulesText, lockText] = await Promise.all([
    readText(resolve(root, 'node_modules/.modules.yaml')),
    readText(resolve(root, 'node_modules/.pnpm/lock.yaml')),
  ])
  if (!modulesText) return state
  const modules = parse(modulesText) ?? {}
  const lock = lockText ? parse(lockText) ?? {} : {}
  const packages: Record<string, any> = lock.packages ?? {}
  const locate = await createLocator(root)

  for (const [depPath, locations] of Object.entries<string[]>(modules.hoistedLocations ?? {})) {
    // a peer suffix, e.g. `react-dom@18.0.0(react@18.0.0)`, is not part of the package key
    const key = depPath.replace(/\(.*$/, '')
    const [name, version] = splitName(key)
    const resolution = packages[key]?.resolution
    const local = resolution?.type === 'directory' || /^(file|link):/.test(version)
    for (const location of locations) {
      state.set(location, {
        name,
        version: version.includes(':') ? undefined : version,
        resolution: `${depPath} ${JSON.stringify(resolution ?? null)}`,
        local,
        realPath: await locate(location, local),
      })
    }
  }

  for (const [importer, data] of Object.entries<any>(lock.importers ?? {})) {
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const [name, dep] of Object.entries<any>(data?.[field] ?? {})) {
        const version: string | undefined = dep?.version
        if (!version?.startsWith('link:')) continue
        const location = posix.join(importer, 'node_modules', name)
        const target = resolve(root, importer, version.slice(5))
        const realPath = await locate(location, true)
        state.set(location, { name: await readName(target) ?? name, resolution: version, local: true, realPath })
      }
    }
  }
  return state
}

export async function readYarnBerryState(root: string): Promise<InstallState> {
  const state: InstallState = new Map()
  const text = await readText(resolve(root, 'node_modules/.yarn-state.yml'))
  if (!text) return state
  const data: Record<string, any> = parse(text) ?? {}
  const locate = await createLocator(root)
  for (const [locator, entry] of Object.entries(data)) {
    if (locator === '__metadata') continue
    const [ident, raw] = splitName(locator)
    // a package with peer dependencies, e.g. `virtual:<hash>#workspace:packages/foo`
    const reference = raw.replace(/^virtual:[^#]*#/, '')
    const local = /^(workspace|file|link|portal):/.test(reference)
    const version = reference.startsWith('npm:') ? reference.slice(4).split('::')[0] : undefined
    for (const location of entry?.locations ?? []) {
      // the root workspace
      if (!location) continue
      // the ident of a local package is that of its dependency, which may be an alias
      const name = local ? await readName(resolve(root, location)) ?? ident : ident
      state.set(location, { name, version, resolution: locator, local, realPath: await locate(location, local) })
    }
  }
  return state
}

function planByNames(before: InstallState, names: Set<string>) {
  const locations = new Set<string>()
  for (const [location, state] of before) {
    if (state.local || names.has(state.name)) locations.add(location)
  }
  return locations
}

function changedNames(previous: Iterable<string>, current: Iterable<string>) {
  const a = new Set(previous), b = new Set(current)
  const names = new Set<string>()
  for (const key of a) if (!b.has(key)) names.add(splitName(key)[0])
  for (const key of b) if (!a.has(key)) names.add(splitName(key)[0])
  return names
}

export async function planNpmChanges(root: string, before: InstallState): Promise<Set<string>> {
  // npm prefers the shrinkwrap if both exist
  const text = await readText(resolve(root, 'npm-shrinkwrap.json')) ?? await readText(resolve(root, 'package-lock.json'))
  const packages: Record<string, any> = text ? JSON.parse(text).packages ?? {} : {}
  const identify = identifyNpm(packages)
  const locations = new Set<string>()
  for (const [location, state] of before) {
    if (state.local || !packages[location] || identify(location).resolution !== state.resolution) locations.add(location)
  }
  for (const location of Object.keys(packages)) {
    if (location.includes('node_modules/') && !before.has(location)) locations.add(location)
  }
  return locations
}

export async function planPnpmChanges(root: string, before: InstallState, lockfile: string | undefined): Promise<Set<string>> {
  // a peer suffix, e.g. `react-dom@18.0.0(react@18.0.0)`, is not part of the package key
  const keys = (text: string | undefined) => Object.keys((text && parse(text))?.packages ?? {}).map(key => key.replace(/\(.*$/, ''))
  const current = await readText(resolve(root, 'pnpm-lock.yaml'))
  return planByNames(before, changedNames(keys(lockfile), keys(current)))
}

export async function planYarnBerryChanges(root: string, before: InstallState, lockfile: string | undefined): Promise<Set<string>> {
  const resolutions = (text: string | undefined) => {
    const data: Record<string, any> = (text && parse(text)) ?? {}
    return Object.entries(data).flatMap(([key, entry]) => key === '__metadata' || !entry?.resolution ? [] : [entry.resolution as string])
  }
  const current = await readText(resolve(root, 'yarn.lock'))
  return planByNames(before, changedNames(resolutions(lockfile), resolutions(current)))
}

export async function findAddedLocations(root: string, before: InstallState, excluded: Set<string>) {
  const isExcluded = (location: string) => {
    while (true) {
      if (excluded.has(location)) return true
      const index = location.lastIndexOf('/node_modules/')
      if (index < 0) return false
      location = location.slice(0, index)
    }
  }
  const folders = ['node_modules', ...[...before.keys()].filter(location => !isExcluded(location)).map(location => `${location}/node_modules`)]
  const added: string[] = []
  const list = (folder: string) => readdir(resolve(root, folder), { withFileTypes: true }).catch(() => [] as Dirent[])
  await Promise.all(folders.map(async (folder) => {
    for (const dirent of await list(folder)) {
      // the records of the agent, `.bin` and `.cache`
      if (dirent.name.startsWith('.')) continue
      const names = dirent.name.startsWith('@')
        ? (await list(posix.join(folder, dirent.name))).map(scoped => `${dirent.name}/${scoped.name}`)
        : [dirent.name]
      for (const name of names) {
        const location = posix.join(folder, name)
        if (!before.has(location)) added.push(location)
      }
    }
  }))
  return added
}

/** A package added, removed or updated at a location. */
export interface PackageChange {
  /** the dependency name, i.e. the directory name under `node_modules` */
  name: string
  /**
   * The location below the real project root. Node resolves dependencies
   * from the real paths of modules, so a dependency name is resolved through
   * this path. A link at the location itself is not resolved.
   */
  path: string
  before?: PackageState
  after?: PackageState
}

export interface StateDiff {
  added: PackageChange[]
  removed: PackageChange[]
  updated: PackageChange[]
}

export function diffState(root: string, before: InstallState, after: InstallState): StateDiff {
  const diff: StateDiff = { added: [], removed: [], updated: [] }
  const locations = [...new Set([...before.keys(), ...after.keys()])].sort()
  for (const location of locations) {
    const change: PackageChange = {
      name: nameOf(location),
      path: resolve(root, location),
      before: before.get(location),
      after: after.get(location),
    }
    if (!change.before) {
      diff.added.push(change)
    } else if (!change.after) {
      diff.removed.push(change)
    } else if (change.after.local || change.before.resolution !== change.after.resolution) {
      diff.updated.push(change)
    } else if (change.before.realPath !== change.after.realPath) {
      // the same content at another real directory, e.g. below a replaced link
      diff.updated.push(change)
    }
  }
  return diff
}
