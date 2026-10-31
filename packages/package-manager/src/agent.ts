import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Env, run, which } from './process.ts'
import { InstallState, planNpmChanges, planPnpmChanges, planYarnBerryChanges, readNpmState, readPnpmState, readYarnBerryState } from './state.ts'

export type AgentName = 'npm' | 'pnpm' | 'yarn'

export interface AgentInfo {
  name: AgentName
  spec: string
  version: string
  executable: string
}

export interface Adapter {
  resolveArgs: string[]
  installArgs: string[]
  recoverArgs: string[]
  /**
   * The lockfiles of the project root, one of which must exist. They are
   * restored after a failed installation, as is `package.json`.
   */
  lockfiles: string[]
  /** the other files, relative to the project root, that are restored after a failed installation */
  restoredFiles: string[]
  /**
   * The records of the agent below `node_modules` that are removed before a
   * recovery from a failed installation, so that the agent reads the
   * packages from the disk.
   */
  resetFiles: string[]
  checkLayout(info: AgentInfo, root: string, env: Env): Promise<void>
  readState(root: string): Promise<InstallState>
  /**
   * The locations that the installation from the resolved lockfile may
   * change, given the state and the text of the lockfile before the
   * resolution.
   */
  planChanges(root: string, before: InstallState, lockfile: string | undefined): Promise<Set<string>>
}

async function getConfig(info: AgentInfo, root: string, env: Env, key: string) {
  const { stdout } = await run(info.executable, ['config', 'get', key], { cwd: root, env, timeout: 60000 })
  return stdout.trim().split(/\r?\n/).pop()?.trim()
}

function assertLayout(info: AgentInfo, key: string, value: string | undefined, expected: string) {
  if (value === expected) return
  throw new Error(`${info.spec} is configured with ${key} "${value}", only "${expected}" is supported`)
}

export const adapters: Record<AgentName, Adapter> = {
  'npm': {
    resolveArgs: ['install', '--package-lock-only', '--no-audit', '--no-fund'],
    installArgs: ['install', '--no-audit', '--no-fund'],
    // `npm ci` would remove `node_modules` first
    recoverArgs: ['install', '--no-audit', '--no-fund', '--prefer-offline'],
    lockfiles: ['package-lock.json', 'npm-shrinkwrap.json'],
    // the resolution writes the hidden lockfile, from which the state is read
    restoredFiles: ['.npmrc', 'node_modules/.package-lock.json'],
    // npm takes the hidden lockfile for the installed packages if it is newer than them
    resetFiles: ['node_modules/.package-lock.json'],
    async checkLayout(info, root, env) {
      assertLayout(info, 'install-strategy', await getConfig(info, root, env, 'install-strategy'), 'hoisted')
    },
    readState: readNpmState,
    planChanges: planNpmChanges,
  },
  'pnpm': {
    // In CI, pnpm defaults to a frozen lockfile, and it asks before purging
    // a modules directory created with other settings.
    resolveArgs: ['install', '--lockfile-only', '--no-frozen-lockfile'],
    installArgs: ['install', '--frozen-lockfile', '--config.confirmModulesPurge=false'],
    recoverArgs: ['install', '--frozen-lockfile', '--prefer-offline', '--config.confirmModulesPurge=false'],
    lockfiles: ['pnpm-lock.yaml'],
    restoredFiles: ['pnpm-workspace.yaml', '.npmrc'],
    resetFiles: [],
    async checkLayout(info, root, env) {
      assertLayout(info, 'node-linker', await getConfig(info, root, env, 'node-linker'), 'hoisted')
    },
    readState: readPnpmState,
    planChanges: planPnpmChanges,
  },
  'yarn': {
    // In CI, yarn defaults to immutable installations. The resolution also
    // fetches the new packages into the cache.
    resolveArgs: ['install', '--mode=update-lockfile', '--no-immutable'],
    installArgs: ['install', '--immutable'],
    recoverArgs: ['install', '--immutable'],
    lockfiles: ['yarn.lock'],
    restoredFiles: ['.yarnrc.yml', '.yarn/install-state.gz'],
    resetFiles: [],
    async checkLayout(info, root, env) {
      assertLayout(info, 'nodeLinker', await getConfig(info, root, env, 'nodeLinker'), 'node-modules')
    },
    readState: readYarnBerryState,
    planChanges: planYarnBerryChanges,
  },
}

export async function detectAgent(root: string, env: Env): Promise<AgentInfo> {
  const manifestPath = resolve(root, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const spec = manifest.packageManager
  if (typeof spec !== 'string') {
    throw new Error(`${manifestPath} has no "packageManager" field`)
  }
  const capture = /^(npm|pnpm|yarn)@(\d+)\.\d+\.\d+(?:[-+].*)?$/.exec(spec)
  if (!capture) {
    throw new Error(`unsupported "packageManager" field "${spec}", expected npm, pnpm or yarn with an exact version`)
  }
  const name = capture[1] as AgentName
  const major = +capture[2]
  if (name === 'yarn' && major === 1) {
    // it cannot resolve the dependencies without installing them
    throw new Error(`unsupported "packageManager" field "${spec}", yarn classic is not supported`)
  }

  const executable = which(name, env)
  if (!executable) throw new Error(`${name} is not found in PATH`)
  const { stdout } = await run(executable, ['--version'], { cwd: root, env, timeout: 60000 })
  const version = stdout.trim().split(/\r?\n/).pop()!.trim()
  if (+version.split('.')[0] !== major) {
    throw new Error(`${executable} reports version ${version}, which does not match "${spec}"`)
  }

  const info: AgentInfo = { name, spec, version, executable }
  await adapters[name].checkLayout(info, root, env)
  return info
}
