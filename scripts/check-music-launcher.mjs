import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { supportedNode, dependenciesReady, buildFingerprint, probeMusicService, choosePort, launchMusic, prepareBuild, sameLegacyProcess, SERVICE_ID } from './launch-music.mjs'
import { canonicalPath, samePath } from './platform.mjs'
import { createMusicServer } from './music-server.mjs'

const PROJECT_DIR = canonicalPath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'))
async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'music-launch-'))
  const root = path.join(base, '中文 与 空格 $() 工程')
  await fs.mkdir(root)
  t.after(() => fs.rm(base, { recursive: true, force: true }))
  return fs.realpath(root)
}
const refusal = () => { throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) }
// Windows environment names are case-insensitive: drop the original 'Path' before adding 'PATH'.
const envWith = (overrides) => {
  const wanted = new Set(Object.keys(overrides).map((key) => key.toLowerCase()))
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !wanted.has(key.toLowerCase()))), ...overrides }
}
const free = async (port) => ({ port, kind: 'free' })

test('Node engine matches the installed Vite requirement', () => {
  for (const version of ['20.19.0', '22.12.0', '24.0.0', '26.3.0']) assert.equal(supportedNode(version), true)
  for (const version of ['18.20.0', '20.18.0', '21.7.0', '22.11.0']) assert.equal(supportedNode(version), false)
})

test('health identity distinguishes our project, another project, HTML, and free ports', async () => {
  const probe = (body, status = 200) => probeMusicService(5175, '/project', { request: async () => ({ status, body }), legacy: () => false })
  assert.equal((await probe({ service: SERVICE_ID, projectDir: '/project', pid: 123 })).kind, 'ours')
  assert.equal((await probe({ service: SERVICE_ID, projectDir: '/another', pid: 123 })).kind, 'occupied')
  assert.equal((await probe(undefined)).kind, 'occupied')
  assert.equal((await probeMusicService(5175, '/project', { request: refusal, legacy: () => false })).kind, 'free')
})

test('old service requires both exact local process identity and music APIs', async () => {
  const request = async (_port, route) => route === '/api/health' ? { status: 404 } : route === '/api/config' ? { status: 200, body: { roots: [] } } : { status: 200, body: { version: 1, albums: [], genres: [] } }
  assert.equal((await probeMusicService(5175, '/project', { request, legacy: () => true })).kind, 'ours')
  assert.equal((await probeMusicService(5175, '/project', { request, legacy: () => false })).kind, 'occupied')
  assert.equal((await probeMusicService(5175, '/project', { request: async () => ({ status: 500 }), legacy: () => true })).kind, 'starting')
})

test('legacy process identity supports Chinese spaced cwd and rejects another script', { skip: process.platform !== 'darwin' }, () => {
  const root = '/Users/example/中文 与 空格 工程'
  const runner = (command, args) => ({ stdout: command === '/bin/ps' ? `/opt/homebrew/bin/node ${root}/scripts/music-server.mjs --port 5175\n` : args.includes('cwd') ? `p123\nn${root}\n` : '123\n' })
  assert.equal(sameLegacyProcess(5175, root, runner), true)
  assert.equal(sameLegacyProcess(5175, `${root}/another`, runner), false)
  assert.equal(sameLegacyProcess(5175, root, (command, args) => command === '/bin/ps' ? { stdout: '/opt/homebrew/bin/node another-server.mjs scripts/music-server.mjs' } : runner(command, args)), false)
})

test('reuse wins over free default; occupied default selects next free port', async () => {
  assert.deepEqual(await choosePort('/project', async (port) => ({ port, kind: port === 5178 ? 'ours' : 'free' })), { kind: 'ours', port: 5178 })
  assert.deepEqual(await choosePort('/project', async (port) => ({ port, kind: port === 5175 ? 'occupied' : 'free' })), { kind: 'free', port: 5176 })
  assert.deepEqual(await choosePort('/project', async (port) => ({ port, kind: port === 5173 ? 'ours' : 'free' })), { kind: 'ours', port: 5173 })
  await assert.rejects(choosePort('/project', async (port) => ({ port, kind: 'occupied' })), /均被其他程序占用/)
  await assert.rejects(choosePort('/project', async (port) => ({ port, kind: port === 5175 ? 'starting' : 'free' })), /暂时没有响应/)
})

test('existing service is opened without installing, building, starting, or writing data', async (t) => {
  const projectDir = await fixture(t)
  const dataDir = path.join(projectDir, 'untouched-data')
  const opened = []
  const forbid = () => assert.fail('reuse must not prepare or start')
  const result = await launchMusic({ projectDir, dataDir, probe: async (port) => ({ port, kind: port === 5175 ? 'ours' : 'free' }), prepare: forbid, start: forbid, open: (url) => opened.push(url) })
  assert.equal(result.reused, true)
  assert.deepEqual(opened, ['http://127.0.0.1:5175/'])
  await assert.rejects(fs.access(dataDir), { code: 'ENOENT' })
})

test('cold launch preserves spaced paths and releases lock; build failure never starts or opens', async (t) => {
  const projectDir = await fixture(t)
  const dataDir = path.join(projectDir, '音乐 数据')
  const calls = []
  await launchMusic({ projectDir, dataDir, probe: free, prepare: async (root) => calls.push(['prepare', root]), start: async (...args) => calls.push(['start', ...args]), open: (url) => calls.push(['open', url]) })
  assert.deepEqual(calls, [['prepare', projectDir], ['start', projectDir, dataDir, 5175], ['open', 'http://127.0.0.1:5175/']])
  await assert.rejects(fs.access(path.join(dataDir, 'launcher.lock')), { code: 'ENOENT' })
  await assert.rejects(launchMusic({ projectDir, dataDir, probe: free, prepare: async () => { throw new Error('offline install failed') }, start: () => assert.fail('must not start'), open: () => assert.fail('must not open') }), /offline install failed/)
  await assert.rejects(fs.access(path.join(dataDir, 'launcher.lock')), { code: 'ENOENT' })
})

test('concurrent double click cannot prepare two copies', async (t) => {
  const projectDir = await fixture(t)
  const dataDir = path.join(projectDir, 'data')
  let proceed, entered
  const ready = new Promise((resolve) => { entered = resolve })
  const gate = new Promise((resolve) => { proceed = resolve })
  const first = launchMusic({ projectDir, dataDir, probe: free, prepare: async () => { entered(); await gate }, start: async () => {}, open: () => {} })
  await ready
  await assert.rejects(launchMusic({ projectDir, dataDir, probe: free, prepare: () => assert.fail('duplicate prepare'), open: () => {} }), /另一个启动器/)
  proceed()
  await first
})

test('two launches do not race to delete a crashed launchers stale lock', async (t) => {
  const projectDir = await fixture(t)
  const dataDir = path.join(projectDir, 'data')
  await fs.mkdir(dataDir)
  const file = path.join(dataDir, 'launcher.lock')
  const original = JSON.stringify({ pid: 2147483647, token: 'previous-launch' })
  await fs.writeFile(file, original)
  const options = { projectDir, dataDir, probe: free, prepare: () => assert.fail('must not prepare'), start: () => assert.fail('must not start'), open: () => assert.fail('must not open') }
  await Promise.all([assert.rejects(launchMusic(options), /未正常退出/), assert.rejects(launchMusic(options), /未正常退出/)])
  assert.equal(await fs.readFile(file, 'utf8'), original)
})

test('content hash sees same-mtime edits and removals without rebuilding for README', async (t) => {
  const root = await fixture(t)
  await fs.mkdir(path.join(root, 'src'))
  const file = path.join(root, 'src/app.ts')
  await fs.writeFile(file, 'first')
  const before = await buildFingerprint(root)
  const stat = await fs.stat(file)
  await fs.writeFile(file, 'other')
  await fs.utimes(file, stat.atime, stat.mtime)
  const after = await buildFingerprint(root)
  assert.notEqual(before, after)
  await fs.writeFile(path.join(root, 'README.md'), 'documentation only')
  assert.equal(after, await buildFingerprint(root))
  await fs.unlink(file)
  assert.notEqual(after, await buildFingerprint(root))
})

test('installed ESM-only and type-only dependencies are ready without require entrypoints', async () => {
  assert.equal(await dependenciesReady(PROJECT_DIR), true)
})

test('Finder command changes cwd safely from another directory', { skip: process.platform === 'win32' }, async (t) => {
  const projectDir = await fixture(t)
  await fs.mkdir(path.join(projectDir, 'scripts'))
  const command = path.join(projectDir, '启动音乐播放器.command')
  await fs.copyFile(path.join(PROJECT_DIR, '启动音乐播放器.command'), command)
  await fs.writeFile(path.join(projectDir, 'scripts/launch-music.mjs'), 'console.log(JSON.stringify({cwd:process.cwd()}))')
  const result = spawnSync('/bin/bash', [command], { cwd: os.tmpdir(), encoding: 'utf8', env: { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).cwd, projectDir)
  assert.ok((await fs.stat(path.join(PROJECT_DIR, '启动音乐播放器.command'))).mode & 0o100)
})

test('Windows batch launcher changes cwd safely, prefers the bundled node and propagates failure', { skip: process.platform !== 'win32' }, async (t) => {
  const projectDir = await fixture(t)
  await fs.mkdir(path.join(projectDir, 'scripts'))
  const bat = path.join(projectDir, '启动音乐播放器.bat')
  await fs.copyFile(path.join(PROJECT_DIR, '启动音乐播放器.bat'), bat)
  assert.ok(!/(?<!\r)\n/.test(await fs.readFile(bat, 'utf8')), 'batch files need CRLF line endings')
  const stub = path.join(projectDir, 'scripts/launch-music.mjs')
  await fs.writeFile(stub, 'console.log(JSON.stringify({ cwd: process.cwd(), node: process.execPath }))')
  const system32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
  const run = (PATH) => spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `""${bat}""`], { cwd: os.tmpdir(), encoding: 'utf8', input: '\r\n', windowsVerbatimArguments: true, env: envWith({ PATH }) })
  const fromPath = run(`${path.dirname(process.execPath)};${system32}`)
  assert.equal(fromPath.status, 0, fromPath.stdout + fromPath.stderr)
  const first = JSON.parse(fromPath.stdout.trim().split(/\r?\n/).at(-1))
  assert.ok(samePath(first.cwd, projectDir), first.cwd)
  assert.ok(samePath(first.node, process.execPath), first.node)
  await fs.mkdir(path.join(projectDir, 'runtime'))
  await fs.copyFile(process.execPath, path.join(projectDir, 'runtime/node.exe'))
  const bundled = run(system32)
  assert.equal(bundled.status, 0, bundled.stdout + bundled.stderr)
  assert.ok(samePath(JSON.parse(bundled.stdout.trim().split(/\r?\n/).at(-1)).node, path.join(projectDir, 'runtime/node.exe')))
  await fs.writeFile(stub, 'console.error("boom"); process.exitCode = 3')
  const failed = run(system32)
  assert.equal(failed.status, 3, failed.stdout + failed.stderr)
  assert.match(failed.stdout + failed.stderr, /boom/)
})

test('batch launcher without any Node.js explains how to install it', { skip: process.platform !== 'win32' }, async (t) => {
  const projectDir = await fixture(t)
  const bat = path.join(projectDir, 'start.bat')
  await fs.copyFile(path.join(PROJECT_DIR, '启动音乐播放器.bat'), bat)
  // 64-bit Windows derives %ProgramFiles% from ProgramW6432, so both must point away from a real install.
  const env = envWith({ PATH: path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'), ProgramFiles: projectDir, ProgramW6432: projectDir, LocalAppData: projectDir })
  const result = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `""${bat}""`], { cwd: os.tmpdir(), encoding: 'utf8', input: '\r\n', windowsVerbatimArguments: true, env })
  assert.equal(result.status, 1)
  assert.match(result.stdout, /nodejs\.org/)
})

test('prebuilt package skips npm when runtime dependencies and dist are intact, and refuses a damaged one', async (t) => {
  const root = await fixture(t)
  const write = async (file, value) => {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true })
    await fs.writeFile(path.join(root, file), typeof value === 'string' ? value : JSON.stringify(value))
  }
  await write('package.json', { dependencies: { foo: '1.0.0' }, devDependencies: { bar: '1.0.0' } })
  await write('package-lock.json', { packages: { '': { dependencies: { foo: '1.0.0' }, devDependencies: { bar: '1.0.0' } }, 'node_modules/foo': { version: '1.0.0' }, 'node_modules/bar': { version: '1.0.0', dev: true } } })
  await write('node_modules/.package-lock.json', { packages: { 'node_modules/foo': { version: '1.0.0' } } })
  await write('node_modules/foo/package.json', { version: '1.0.0' })
  assert.equal(await dependenciesReady(root, { production: true }), true)
  assert.equal(await dependenciesReady(root), false)
  await write('dist/index.html', '<script src="/assets/app.js"></script>')
  await write('dist/assets/app.js', '1')
  await write('dist/.music-build.json', { prebuilt: true })
  await prepareBuild(root)
  await fs.rm(path.join(root, 'dist/assets/app.js'))
  await assert.rejects(prepareBuild(root), /预编译包文件不完整/)
})

test('fingerprint is identical for LF and CRLF checkouts of the same sources', async (t) => {
  const [lf, crlf] = [await fixture(t), await fixture(t)]
  for (const [root, text] of [[lf, 'const a = 1\nconst b = 2\n'], [crlf, 'const a = 1\r\nconst b = 2\r\n']]) {
    await fs.mkdir(path.join(root, 'src/nested'), { recursive: true })
    await fs.writeFile(path.join(root, 'src/nested/app.ts'), text)
    await fs.writeFile(path.join(root, 'package.json'), '{\n}\n')
  }
  assert.equal(await buildFingerprint(lf), await buildFingerprint(crlf))
})

test('health endpoint is read-only and retains Host and Origin restrictions', async () => {
  const { server } = await createMusicServer({ store: {}, autoScan: false })
  const request = (headers) => new Promise((resolve) => {
    let status
    server.emit('request', { method: 'GET', url: '/api/health', headers }, { setHeader() {}, writeHead(value) { status = value }, end(body) { resolve({ status, body: JSON.parse(body) }) } })
  })
  const valid = await request({ host: '127.0.0.1:5175' })
  assert.equal(valid.status, 200)
  assert.deepEqual(valid.body, { service: SERVICE_ID, projectDir: PROJECT_DIR, pid: process.pid })
  assert.equal((await request({ host: 'example.com' })).status, 403)
  assert.equal((await request({ host: '127.0.0.1:5175', origin: 'https://example.com' })).status, 403)
})
