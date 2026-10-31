import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { diffState, InstallState, PackageState, readNpmState, readYarnBerryState } from '../src/state.ts'

const temp = join(tmpdir(), `cordis-package-manager-state-${process.pid}`)
let counter = 0

function createProject(files: Record<string, unknown>) {
  const dir = join(temp, `project-${++counter}`)
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true })
    writeFileSync(join(dir, name), typeof content === 'string' ? content : JSON.stringify(content))
  }
  return dir
}

afterAll(() => {
  rmSync(temp, { recursive: true, force: true })
})

describe('npm', () => {
  function bundle(integrity: string, version: string) {
    return {
      'node_modules/.package-lock.json': {
        packages: {
          'node_modules/parent': { version, resolved: `https://registry.example/parent-${version}.tgz`, integrity },
          'node_modules/parent/node_modules/child': { version: '1.0.0', inBundle: true },
          'node_modules/parent/node_modules/child/node_modules/grandchild': { version: '1.0.0', inBundle: true },
        },
      },
    }
  }

  it('updates the packages bundled in an updated package', async () => {
    const before = await readNpmState(createProject(bundle('sha512-a', '1.0.0')))
    const after = await readNpmState(createProject(bundle('sha512-b', '2.0.0')))
    const diff = diffState('/', before, after)
    expect(diff.updated.map(change => change.name).sort()).to.deep.equal(['child', 'grandchild', 'parent'])
  })

  it.skipIf(process.platform === 'win32')('reports the real directory below a linked node_modules', async () => {
    const dir = createProject({
      'shared/.package-lock.json': {
        packages: { 'node_modules/alpha': { version: '1.0.0', resolved: 'https://registry.example/alpha-1.0.0.tgz', integrity: 'sha512-a' } },
      },
      'shared/alpha/package.json': { name: 'alpha', version: '1.0.0' },
      'project/package.json': { name: 'project' },
    })
    symlinkSync('../shared', join(dir, 'project/node_modules'), 'dir')
    const state = await readNpmState(join(dir, 'project'))
    expect(state.get('node_modules/alpha')?.realPath).to.equal(realpathSync(join(dir, 'shared/alpha')))
  })
})

describe('yarn berry', () => {
  it('treats a virtual workspace as local', async () => {
    const dir = createProject({
      'packages/foo/package.json': { name: 'foo', version: '1.0.0' },
      'node_modules/.yarn-state.yml': [
        '__metadata:',
        '  version: 1',
        '"foo@virtual:0123abcd#workspace:packages/foo":',
        '  locations:',
        '    - "node_modules/foo"',
        '"bar@virtual:0123abcd#npm:1.2.3":',
        '  locations:',
        '    - "node_modules/bar"',
        '',
      ].join('\n'),
    })
    const state = await readYarnBerryState(dir)
    expect(state.get('node_modules/foo')).to.include({ name: 'foo', local: true })
    expect(state.get('node_modules/bar')).to.include({ name: 'bar', version: '1.2.3', local: false })
    expect(diffState(dir, state, state).updated.map(change => change.name)).to.deep.equal(['foo'])
  })
})

describe('diffState', () => {
  it('updates a package whose real directory changed', () => {
    const state = (realPath: string): PackageState => ({ name: 'alpha', version: '1.0.0', resolution: 'sha512-a', local: false, realPath })
    const before: InstallState = new Map([['node_modules/alpha', state('/shared/alpha')]])
    const after: InstallState = new Map([['node_modules/alpha', state('/project/node_modules/alpha')]])
    expect(diffState('/project', before, after).updated.map(change => change.name)).to.deep.equal(['alpha'])
  })
})
