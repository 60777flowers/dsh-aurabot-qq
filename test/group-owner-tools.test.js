// 群聊「主人本机工具」：档位判定、配置归一化、人格文案与接线契约。
// 这一档不叫 full —— 插件自己的工具还要按 social 语义挂，真正的开关由 hub 按发言人做，
// 所以这里把「纯函数算出什么档」和「接线还在不在」都钉住。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { groupOwnerTools, levelFor, presetFor } from '../src/chat/access.js'
import { normalize, DEFAULTS } from '../src/core/config.js'
import { rulesText } from '../src/persona/personas.js'

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
const GROUP = { kind: 'group', chatId: 'group:100200300', groupId: '100200300', userId: '100200300' }
const OTHER_GROUP = { kind: 'group', chatId: 'group:200300400', groupId: '200300400' }
const cfgWith = (group) => normalize({ ownerQQ: '10001', allow: { groups: ['100200300', '200300400'] }, group })

test('groupOwnerTools：默认关，群聊才有效，私聊一律 off', () => {
  assert.equal(groupOwnerTools(normalize({}), GROUP), 'off')
  assert.equal(groupOwnerTools(cfgWith({ ownerTools: 'owner' }), GROUP), 'owner')
  assert.equal(groupOwnerTools(cfgWith({ ownerTools: 'all' }), GROUP), 'off', 'all 模式已移除，写 all 一律按 off')
  assert.equal(groupOwnerTools(cfgWith({ ownerTools: 'owner' }), { kind: 'private', userId: '10001' }), 'off')
  assert.equal(groupOwnerTools(cfgWith({ ownerTools: 'owner' }), { kind: 'system', system: 'autotelic' }), 'off')
})

test('groupOwnerTools：ownerToolsGroups 非空时只对列出的群生效', () => {
  const cfg = cfgWith({ ownerTools: 'owner', ownerToolsGroups: ['100200300'] })
  assert.equal(groupOwnerTools(cfg, GROUP), 'owner')
  assert.equal(groupOwnerTools(cfg, OTHER_GROUP), 'off')
  const all = cfgWith({ ownerTools: 'all', ownerToolsGroups: [] })
  assert.equal(groupOwnerTools(all, OTHER_GROUP), 'off', 'all 模式已移除')
})

test('levelFor：开了本机工具的群给 group-full，其余群仍旧 social', () => {
  assert.equal(levelFor(cfgWith({ ownerTools: 'owner' }), GROUP), 'group-full')
  assert.equal(levelFor(cfgWith({ ownerTools: 'all' }), GROUP), 'social', 'all 不再抬档')
  assert.equal(levelFor(normalize({ ownerQQ: '10001' }), GROUP), 'social')
  assert.equal(levelFor(normalize({ ownerQQ: '10001', ownerLevel: 'full' }), { kind: 'private', userId: '10001' }), 'full')
  assert.equal(levelFor(normalize({ ownerQQ: '10001', ownerLevel: 'full' }), { kind: 'private', userId: '20002' }), 'social')
})

test('presetFor：group-full 走专用 preset，不能落到 private', () => {
  assert.equal(presetFor('group-full', normalize({})), 'aurabot-group-owner')
  assert.equal(presetFor('social', normalize({})), 'aurabot-social')
  assert.equal(presetFor('full', normalize({ longTasks: false })), 'aurabot-private')
  assert.equal(presetFor('full', normalize({ longTasks: true })), 'aurabot-private-long')
})

test('配置归一化：默认 off，非法值回落 off，群号列表收成数组', () => {
  assert.equal(DEFAULTS.group.ownerTools, 'off')
  assert.deepEqual(DEFAULTS.group.ownerToolsGroups, [])
  assert.equal(normalize({}).group.ownerTools, 'off')
  assert.equal(normalize({ group: { ownerTools: 'owner' } }).group.ownerTools, 'owner')
  assert.equal(normalize({ group: { ownerTools: 'yes' } }).group.ownerTools, 'off')
  assert.equal(normalize({ group: { ownerTools: true } }).group.ownerTools, 'off')
  assert.equal(normalize({ group: { ownerTools: 'all' } }).group.ownerTools, 'off', 'all 模式必须归一到 off')
  assert.deepEqual(normalize({ group: { ownerToolsGroups: '100200300, 200300400' } }).group.ownerToolsGroups, ['100200300', '200300400'])
})

test('人格：group-owner 承认手里有工具，social 仍然明说没有', () => {
  const base = normalize({ ownerQQ: '10001', ownerName: '主人' })
  const groupOwner = rulesText('group-owner', base)
  assert.ok(groupOwner.includes('确实有命令和文件工具'), 'group-owner 应当承认有工具')
  assert.ok(groupOwner.includes('工具会被收走'), 'group-owner 要说明没让动手时工具会消失')
  assert.ok(groupOwner.includes('别把命令输出'), 'group-owner 要有群可见的收敛提示')
  assert.ok(!groupOwner.includes('你不能跑命令'), 'group-owner 不能再说自己没有工具')
  const social = rulesText('social', base)
  assert.ok(social.includes('你不能跑命令'), 'social 仍要明说没有工具')
})

test('接线契约：preset、人格变量、闸门、面板开关都在', () => {
  const yml = read('cordis.patch.yml')
  assert.ok(yml.includes('id: preset-aurabot-group-owner'), '缺 preset-aurabot-group-owner')
  assert.ok(yml.includes('id: aurabot-group-owner'), 'preset 的 id 要叫 aurabot-group-owner')
  assert.ok(yml.includes('{{aurabot_rules_group_owner}}'), 'preset 要挂 group-owner 的人格变量')
  assert.ok(/order: 62/.test(yml), 'order 62 与 social(61)/autotelic(63) 不能撞')

  const host = read('src/host.js')
  assert.ok(host.includes("variable('aurabot_rules_group_owner'"), 'host 没定义 aurabot_rules_group_owner')
  assert.ok(host.includes("rulesText('group-owner'"), 'host 没把 group-owner 传给 rulesText')

  const hub = read('src/chat/hub.js')
  assert.ok(hub.includes('const GROUP_TOOL_DENY'), 'hub 缺 GROUP_TOOL_DENY')
  assert.ok(/GROUP_TOOL_DENY = \[[^\]]*'bash'[^\]]*'write'/.test(hub), 'deny 里要有 bash / write')
  assert.ok(hub.includes('applyGroupGate(key, turnSendersAllOwner(sessionId))'), 'pushToSession 没按发言人开合')
  assert.ok(hub.includes("level === 'group-full'"), 'mount 没给 group-full 登记闸门')
  assert.ok(hub.includes('tools.restrict({ deny: g.deny })'), '闸门要用 tools.restrict 收工具')

  const client = read('client/client.js')
  assert.ok(client.includes("f.choices('group.ownerTools'"), '面板缺 group.ownerTools 选择')
  assert.ok(!/group\.ownerTools'[^)]*value: 'all'/.test(client), '面板不得再提供 all 档')
  assert.ok(client.includes("f.list('group.ownerToolsGroups'"), '面板缺 ownerToolsGroups 列表')
})

test('闸门：群里非主人说话时本机工具被收走', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  process.env.AURABOT_WORKSPACE = mkdtempSync(join(tmpdir(), 'aurabot-group-gate-'))
  const { createFakeDsh } = await import('./helpers/fake-dsh.js')
  const { createHub } = await import('../src/chat/hub.js')

  const OWNER = '10001'
  const OTHER = '20002'
  const G = '100200300'
  const cfg = normalize({ ownerQQ: OWNER, allow: { groups: [G] }, longTasks: false, group: { ownerTools: 'owner' } })
  const fake = createFakeDsh({ brain: () => '好' })
  const log = { info () {}, warn () {}, debug () {}, error () {} }
  const hub = createHub({ dsh: fake.ctx, getConfig: () => cfg, log, onebot: { call: async () => ({}) }, buildTools: () => [] })
  const chat = { kind: 'group', chatId: `group:${G}`, groupId: G, userId: OTHER, nickname: '别人' }

  // 真实消息管线：别人的消息进来，装上去的本机工具必须被 restrict 收走
  await hub.pushToSession(chat, [{ type: 'text', text: '跑个 pwd' }], OTHER, { queryText: '跑个 pwd' })
  const agent = fake.agents.get([...fake.agents.keys()].pop())
  assert.ok(agent, '群会话没建起来')
  assert.ok(agent.denied.has('bash'), '非主人那一轮必须把 bash 收走')
  assert.ok(agent.denied.has('write'), '非主人那一轮必须把 write 收走')
  assert.ok(agent.denied.has('web_fetch'), '非主人那一轮必须把 web_fetch 收走')

  // 开合规则：说话的全是主人才放开，掺一个人就收紧
  const sid = [...fake.agents.keys()].pop()
  hub.simulateTurn(sid, [OWNER])
  assert.equal(hub.turnSendersAllOwner(sid), true, '全是主人时应当放开')
  hub.simulateTurn(sid, [OWNER, OTHER])
  assert.equal(hub.turnSendersAllOwner(sid), false, '掺了别人就要收紧')
  hub.simulateTurn(sid, [OTHER])
  assert.equal(hub.turnSendersAllOwner(sid), false, '只有别人时收紧')
})
