// 社区模块：zip 安全、校验、安装 / 更新 / 卸载、老用户自动迁移。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateRawSync } from 'node:zlib'

let root, createCommunity, readZip, userDir
const zip = (files) => { // 和 mods 仓库 makeZip 同格式
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text)
    const path = Buffer.from(name)
    const body = deflateRawSync(data)
    const head = Buffer.alloc(30)
    head.writeUInt32LE(0x04034b50, 0)
    head.writeUInt16LE(20, 4)
    head.writeUInt16LE(0x0800, 6)
    head.writeUInt16LE(8, 8)
    head.writeUInt32LE(crc32(data), 14)
    head.writeUInt32LE(body.length, 18)
    head.writeUInt32LE(data.length, 22)
    head.writeUInt16LE(path.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    head.copy(central, 6, 4, 30)
    central.writeUInt32LE(offset, 42)
    locals.push(head, path, body)
    centrals.push(central, path)
    offset += head.length + path.length + body.length
  }
  const dir = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  const n = Object.keys(files).length
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(n, 8)
  end.writeUInt16LE(n, 10)
  end.writeUInt32LE(dir.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, dir, end])
}
const pack = (id, version, extra = {}) => {
  const buf = zip({ 'module.json': JSON.stringify({ id, version }), 'index.mjs': 'export default {}', ...extra })
  return { buf, entry: { id, name: id, version, api: 1, minPluginVersion: '1.0.0', requires: [], capabilities: [], path: `${id}/${id}.zip`, sha256: createHash('sha256').update(buf).digest('hex') } }
}
function setup(packs, { cfg = {}, revoked = [], status = [] } = {}) {
  let config = cfg
  const fetcher = async (url) => {
    if (url.endsWith('index.json')) return { ok: true, json: async () => ({ schema: 1, assetsBase: 'https://x/', modules: packs.map((p) => p.entry), revoked }) }
    const p = packs.find((x) => url.endsWith(x.entry.path))
    return { ok: true, arrayBuffer: async () => p.buf }
  }
  const mods = { status: () => status, sync: async () => {}, stop: () => true }
  const log = { info() {}, warn() {} }
  const c = createCommunity({ mods, getConfig: () => config, setConfig: (n) => { config = n }, log, version: '1.2.0', registryUrl: 'https://x/index.json', fetcher })
  return { c, cfg: () => config }
}

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'aurabot-community-'))
  process.env.AURABOT_DATA_DIR = root
  ;({ createCommunity, readZip } = await import('../src/core/community.js'))
  ;({ userDir } = await import('../src/core/modules.js'))
  mkdirSync(userDir(), { recursive: true })
})
after(() => rmSync(root, { recursive: true, force: true }))

test('readZip 拒绝路径穿越、绝对路径和反斜杠', () => {
  for (const name of ['../evil.js', 'a/../../evil.js', '/etc/x', 'C:/x', 'a\\b.js']) assert.throws(() => readZip(zip({ [name]: 'x' })), /不安全/, name)
  assert.equal(readZip(zip({ 'a/b.js': 'hi' })).get('a/b.js').toString(), 'hi')
})

test('安装写来源文件，sha256 不对就丢弃', async () => {
  const { c } = setup([pack('demo-a', '1.0.0')])
  assert.equal((await c.install('demo-a')).ok, true)
  assert.equal(JSON.parse(readFileSync(join(userDir(), 'demo-a', '.aurabot-source.json'), 'utf8')).version, '1.0.0')
  assert.equal(existsSync(join(userDir(), '.demo-a.installing')), false)
  const bad = pack('demo-b', '1.0.0')
  bad.entry.sha256 = '0'.repeat(64)
  assert.match((await setup([bad]).c.install('demo-b')).message, /校验不通过/)
  assert.equal(existsSync(join(userDir(), 'demo-b')), false)
})

test('用户自己写的同名文件夹绝不覆盖', async () => {
  const dir = join(userDir(), 'demo-c')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'index.mjs'), 'mine')
  const r = await setup([pack('demo-c', '1.0.0')]).c.install('demo-c')
  assert.equal(r.ok, false)
  assert.equal(readFileSync(join(dir, 'index.mjs'), 'utf8'), 'mine')
})

test('版本、撤回、依赖不满足不让装；更新替换旧文件', async () => {
  const high = pack('demo-d', '1.0.0')
  high.entry.minPluginVersion = '9.0.0'
  assert.match((await setup([high]).c.install('demo-d')).message, /先更新插件/)
  assert.match((await setup([pack('demo-e', '1.0.0')], { revoked: [{ id: 'demo-e', versions: ['1.0.0'], reason: '有问题' }] }).c.install('demo-e')).message, /已撤回/)
  const dep = pack('demo-f', '1.0.0')
  dep.entry.requires = ['nope']
  assert.match((await setup([dep]).c.install('demo-f')).message, /要先装/)
  await setup([pack('demo-g', '1.0.0', { 'old.txt': '1' })]).c.install('demo-g')
  const { c } = setup([pack('demo-g', '1.1.0')])
  assert.equal((await c.list()).list[0].update, true)
  assert.equal((await c.install('demo-g')).ok, true)
  assert.equal(existsSync(join(userDir(), 'demo-g', 'old.txt')), false)
})

test('替换内置要确认；卸载默认保留设置，purge 才清', async () => {
  const p = pack('demo-h', '1.0.0')
  p.entry.replacesBuiltin = true
  const s = setup([p], { cfg: { ext: { 'demo-h': { a: 1 } } } })
  assert.equal((await s.c.install('demo-h')).needConfirm, true)
  assert.equal((await s.c.install('demo-h', { confirmReplace: true })).ok, true)
  await s.c.remove('demo-h')
  assert.equal(existsSync(join(userDir(), 'demo-h')), false)
  assert.equal(s.cfg().ext['demo-h'].a, 1)
  await s.c.install('demo-h', { confirmReplace: true })
  await s.c.remove('demo-h', { purge: true })
  assert.equal(s.cfg().ext['demo-h'], undefined)
})

test('迁移：只装在用的，只装一次，卸载后不再装；失败下次重试', async () => {
  const packs = [pack('douyin', '2.0.0'), pack('heybox', '1.0.0'), pack('group-admin', '1.0.0'), pack('pet', '1.0.0')]
  const s = setup(packs, { cfg: { setupDone: true, douyin: { enabled: true }, heybox: { enabled: false }, modules: { 'group-admin': { enabled: false } } } })
  assert.deepEqual((await s.c.migrate()).map((x) => x.id), ['douyin'])
  assert.deepEqual(s.cfg().communityMigrated, { pet: 'skipped', douyin: 'installed', heybox: 'skipped', 'group-admin': 'skipped' })
  await s.c.remove('douyin')
  assert.deepEqual(await s.c.migrate(), [])
  assert.equal(existsSync(join(userDir(), 'douyin')), false)
  const fail = setup([], { cfg: { setupDone: true, douyin: { enabled: true } } })
  await fail.c.migrate()
  assert.equal(fail.cfg().communityMigrated.douyin, undefined)
})

test('迁移：插件卸载后旧实例不再安装、不写配置', async () => {
  let alive = true
  let config = { setupDone: true, douyin: { enabled: true } }
  let writes = 0
  const c = createCommunity({ mods: { status: () => [], sync: async () => {}, stop: () => true }, getConfig: () => config, setConfig: (n) => { writes++; config = n }, log: { info() {}, warn() {} }, version: '1.2.0', alive: () => alive, registryUrl: 'https://x/index.json', fetcher: async () => { alive = false; return { ok: false, status: 500 } } })
  await c.migrate()
  assert.equal(writes, 0)
})

test('测试版：版本比较、更新通道、市场最低版本', async () => {
  const u = await import('../src/core/update.js')
  const { compareVersions } = await import('../src/core/community.js')
  assert.ok(u.compareVersions('1.2.0-beta.1', '1.1.24') > 0)
  assert.ok(u.compareVersions('1.2.0-beta.2', '1.2.0-beta.1') > 0)
  assert.ok(u.compareVersions('1.2.0', '1.2.0-beta.2') > 0)
  assert.ok(u.compareVersions('1.2.0-beta.2', '1.2.0') < 0)
  assert.equal(u.compareVersions('1.1.24', '1.1.24'), 0)
  assert.equal(compareVersions('1.2.0', '1.2.0-beta.1'), 0)
  const urls = []
  const check = u.createUpdateChecker({ pkg: { version: '1.2.0-beta.1', repository: 'https://github.com/a/b' }, fetchImpl: async (url) => { urls.push(url); return { ok: true, json: async () => ({ version: '1.2.0-beta.2' }) } } })
  const r = await check({ force: true })
  assert.match(urls[0], /\/beta\/package\.json$/)
  assert.equal(r.newer, true)
  assert.match(r.command, /github:a\/b#beta$/)
  assert.equal(u.channelOf('1.2.0'), 'main')
})
