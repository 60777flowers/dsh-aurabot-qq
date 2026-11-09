// 群分享待批：认编号、攒待批、主人回「发 1/发全部/不发」才真发、每日上限、过期、去重。
// 全程假 hub：sendText 只记账，不碰真网关。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let share
let store
let normalize
let duty

before(async () => {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-group-share-'))
  share = await import('../src/bili/group-share.js')
  store = await import('../src/core/store.js')
  ;({ normalize } = await import('../src/core/config.js'))
  duty = await import('../src/bili/duty.js')
})

const file = () => store.dataDir('bili-group-share.json')
const fresh = () => rmSync(file(), { force: true })
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))
const GROUP = '20000002'
const OWNER = '10000001'

function setup({ over = {}, top = {}, sendResult = { message_id: 1 } } = {}) {
  const sent = []
  const cfg = normalize({
    enabled: true, dryRun: false, ownerQQ: OWNER,
    bili: { enabled: true, cookie: 'SESSDATA=x; bili_jct=y', groupShare: { enabled: true, groupId: GROUP, ...over } },
    ...top,
  })
  const hub = { sendText: async (chatId, text) => { sent.push({ chatId, text }); return typeof sendResult === 'function' ? sendResult(chatId) : sendResult } }
  const log = { info() {}, warn() {}, debug() {} }
  const gs = share.createGroupShare({ getConfig: () => cfg, hub, log })
  return { gs, cfg, sent, hub, log }
}

test('回复解析：只认短命令，正常聊天和超长句不碰', () => {
  assert.deepEqual(share.parseDecision('发1'), { action: 'send', index: 1 })
  assert.deepEqual(share.parseDecision('发 #2'), { action: 'send', index: 2 })
  assert.deepEqual(share.parseDecision('发送 12'), { action: 'send', index: 12 })
  assert.deepEqual(share.parseDecision('发全部'), { action: 'send', index: 0, all: true })
  assert.deepEqual(share.parseDecision('不发1'), { action: 'skip', index: 1 })
  assert.deepEqual(share.parseDecision('别发 2'), { action: 'skip', index: 2 })
  assert.deepEqual(share.parseDecision('不发全部'), { action: 'skip', index: 0, all: true })
  assert.deepEqual(share.parseDecision('不发'), { action: 'skip', index: 0, all: true })
  assert.deepEqual(share.parseDecision('发'), { action: 'send', index: 0 })
  assert.equal(share.parseDecision('发0'), null, '编号从 1 开始')
  // 这些词 DSH 工具授权中继在用（approval.js），群分享别抢
  for (const w of ['批准', '同意', '允许', '拒绝', '取消', '批准 1']) assert.equal(share.parseDecision(w), null, w)
  assert.equal(share.parseDecision('今天吃什么'), null)
  assert.equal(share.parseDecision('这个视频真好笑我笑了半天哈哈哈哈'), null, '超 12 字当正常聊天')
  assert.equal(share.parseDecision(''), null)
})

test('攒待批：问主人一次，编号从 1 开始；同一条视频不重复问', async () => {
  fresh()
  const { gs, sent } = setup()
  const r = await gs.submit([{ bvid: 'BV1aaaaaaa1', title: '米饭大赛', text: '群友快看这个' }])
  assert.deepEqual(r, { ok: true, n: 1 })
  assert.equal(sent.length, 1)
  assert.equal(sent[0].chatId, `private:${OWNER}`)
  assert.match(sent[0].text, /【群分享待批】/)
  assert.match(sent[0].text, new RegExp(`想把这几条发到群里（${GROUP}）`))
  assert.match(sent[0].text, /1\.《米饭大赛》 群友快看这个/)
  assert.match(sent[0].text, /回复「发 1」发第 1 条/)
  assert.match(sent[0].text, /24 小时内没回就当不发/)
  assert.equal(gs.pending().length, 1)
  assert.equal(sent.filter((x) => x.chatId === `group:${GROUP}`).length, 0, '攒的时候一条都不发群')

  const again = await gs.submit([{ bvid: 'BV1aaaaaaa1', title: '米饭大赛', text: '再说一次' }])
  assert.equal(again.ok, false)
  assert.match(again.why, /没有能攒的新条目/)
  assert.equal(sent.length, 1, '重复的不再问一遍')
  assert.equal(gs.pending().length, 1)
})

test('试运行 / 没开关 / 没群号 / 总开关关着 / 额度用完：一律不攒', async () => {
  fresh()
  const dry = setup({ top: { dryRun: true } })
  assert.match((await dry.gs.submit([{ bvid: 'BV1a', title: 'A', text: 'a' }])).why, /试运行/)
  const off = setup({ over: { enabled: false } })
  assert.match((await off.gs.submit([{ bvid: 'BV1a', title: 'A', text: 'a' }])).why, /群分享没开/)
  const noGroup = setup({ over: { groupId: '' } })
  assert.match((await noGroup.gs.submit([{ bvid: 'BV1a', title: 'A', text: 'a' }])).why, /群分享没开/)
  const allOff = setup({ top: { enabled: false } })
  assert.match((await allOff.gs.submit([{ bvid: 'BV1a', title: 'A', text: 'a' }])).why, /总开关关着/)
  const quota = setup({ over: { dailyLimit: 0 } })
  assert.match((await quota.gs.submit([{ bvid: 'BV1a', title: 'A', text: 'a' }])).why, /今天已经发够 0 条/)
  for (const s of [dry, off, noGroup, allOff, quota]) {
    assert.equal(s.sent.length, 0, '不攒就不问主人')
    assert.equal(s.gs.pending().length, 0)
  }
})

test('回「发 2」：只发那一条、带链接、给主人回执、当天计数 +1', async () => {
  fresh()
  const { gs, sent } = setup()
  await gs.submit([
    { bvid: 'BV1aaaaaaa1', title: '米饭大赛', text: '群友快看' },
    { bvid: 'BV1bbbbbbb2', title: '猫猫做饭', text: '猫猫好会' },
  ])
  assert.equal(gs.pending().length, 2)
  sent.length = 0
  assert.equal(gs.handleReply(`private:${OWNER}`, OWNER, '发 2'), true)
  await tick()
  const toGroup = sent.filter((x) => x.chatId === `group:${GROUP}`)
  assert.equal(toGroup.length, 1)
  assert.equal(toGroup[0].text, '猫猫好会\nhttps://www.bilibili.com/video/BV1bbbbbbb2')
  assert.equal(gs.pending().length, 1, '发掉的那条不再是待批')
  const receipt = sent.at(-1)
  assert.equal(receipt.chatId, `private:${OWNER}`)
  assert.match(receipt.text, new RegExp(`发到群 ${GROUP} 了（1 条）`))
  // 编号越界：不重发，只提醒现在只剩几条
  sent.length = 0
  assert.equal(gs.handleReply(`private:${OWNER}`, OWNER, '发 2'), true)
  await tick()
  assert.equal(sent.filter((x) => x.chatId === `group:${GROUP}`).length, 0)
  assert.match(sent.at(-1).text, /第 2 条(已经不在了|没有)/)
})

test('「不发 1」丢掉那一条，一条也不发群', async () => {
  fresh()
  const { gs, sent } = setup()
  await gs.submit([{ bvid: 'BV1aaaaaaa1', title: '米饭大赛', text: '群友快看' }])
  sent.length = 0
  assert.equal(gs.handleReply(`private:${OWNER}`, OWNER, '不发 1'), true)
  await tick()
  assert.equal(sent.filter((x) => x.chatId === `group:${GROUP}`).length, 0)
  assert.equal(gs.pending().length, 0)
  assert.match(sent.at(-1).text, /没发 1 条/)
})

test('「发全部」碰到每日上限就停，剩下的还留着待批', async () => {
  fresh()
  const { gs, sent } = setup({ over: { dailyLimit: 1 } })
  await gs.submit([
    { bvid: 'BV1aaaaaaa1', title: 'A', text: 'a' },
    { bvid: 'BV1bbbbbbb2', title: 'B', text: 'b' },
  ])
  sent.length = 0
  assert.equal(gs.handleReply(`private:${OWNER}`, OWNER, '发全部'), true)
  await tick()
  assert.equal(sent.filter((x) => x.chatId === `group:${GROUP}`).length, 1, '只发一条')
  assert.equal(gs.pending().length, 1, '剩下的明天再说')
  assert.match(sent.at(-1).text, /还有 1 条没发：今天的群分享额度用完了（1）/)
})

test('裸「发」：只有一条就直接发，多条只让主人挑编号', async () => {
  fresh()
  const one = setup()
  await one.gs.submit([{ bvid: 'BV1aaaaaaa1', title: 'A', text: 'a' }])
  one.sent.length = 0
  assert.equal(one.gs.handleReply(`private:${OWNER}`, OWNER, '发'), true)
  await tick()
  assert.equal(one.sent.filter((x) => x.chatId === `group:${GROUP}`).length, 1)

  fresh()
  const two = setup()
  await two.gs.submit([
    { bvid: 'BV1aaaaaaa1', title: 'A', text: 'a' },
    { bvid: 'BV1bbbbbbb2', title: 'B', text: 'b' },
  ])
  two.sent.length = 0
  assert.equal(two.gs.handleReply(`private:${OWNER}`, OWNER, '发'), true)
  await tick()
  assert.equal(two.sent.filter((x) => x.chatId === `group:${GROUP}`).length, 0)
  assert.match(two.sent.at(-1).text, /现在有 2 条待批，回复「发 1」/)
})

test('只认主人私聊：别人、群里、长句、没待批时都不截流', async () => {
  fresh()
  const { gs, sent } = setup()
  assert.equal(gs.handleReply(`private:${OWNER}`, OWNER, '发 1'), false, '没待批就不管')
  await gs.submit([{ bvid: 'BV1aaaaaaa1', title: 'A', text: 'a' }])
  sent.length = 0
  assert.equal(gs.handleReply('private:99999999', '99999999', '发 1'), false, '别人说发 1 不算')
  assert.equal(gs.handleReply(`group:${GROUP}`, OWNER, '发 1'), false, '群里说发 1 不算数')
  assert.equal(gs.handleReply(`private:${OWNER}`, OWNER, '这个视频真好笑我笑了一下午'), false)
  assert.equal(sent.length, 0)
  assert.equal(gs.handleReply(`private:${OWNER}`, OWNER, '发 1'), true)
  await tick()
  assert.equal(sent.filter((x) => x.chatId === `group:${GROUP}`).length, 1)
})

test('过期待批自动作废：不发、不吵主人', async () => {
  fresh()
  const { gs, sent } = setup({ over: { pendingTtlHours: 1 } })
  await gs.submit([{ bvid: 'BV1aaaaaaa1', title: 'A', text: 'a' }])
  sent.length = 0
  const s = store.readJson(file(), null)
  s.items[0].at = Date.now() - 2 * 3600_000
  store.writeJson(file(), s)
  assert.equal(gs.expire(), 1)
  assert.equal(gs.pending().length, 0)
  assert.equal(sent.length, 0, '过期不发也不提醒')
  assert.equal(gs.handleReply(`private:${OWNER}`, OWNER, '发 1'), false, '过期后再回也没用了')
  assert.equal(gs.expire(), 0, '不重复计数')
})

test('发群失败（hub 返回空）记 failed，不占当天额度', async () => {
  fresh()
  const { gs, sent } = setup({ sendResult: (chatId) => (chatId.startsWith('group:') ? null : { message_id: 1 }) })
  await gs.submit([{ bvid: 'BV1aaaaaaa1', title: 'A', text: 'a' }])
  sent.length = 0
  assert.equal(gs.handleReply(`private:${OWNER}`, OWNER, '发 1'), true)
  await tick()
  assert.equal(gs.pending().length, 0)
  const s = store.readJson(file(), null)
  assert.equal(s.items.find((x) => x.bvid === 'BV1aaaaaaa1').state, 'failed')
  assert.equal(s.sentToday, 0, '没真发出去就不算额度')
  assert.match(sent.at(-1).text, /1 条没确认发出去/)
})

test('刷一轮：模型给了 shareGroup 就攒成待批，现场不往群里发', async () => {
  fresh()
  rmSync(store.dataDir('bili.json'), { force: true })
  const sent = []
  const posted = []
  const fakeApi = {
    nav: async () => ({ isLogin: true }),
    search: async (kw) => [
      { bvid: 'BV1aaaaaaa1', aid: 1, title: kw + ' 视频一', play: 20000, pubdate: Date.now() },
      { bvid: 'BV1bbbbbbb2', aid: 2, title: kw + ' 视频二', play: 30000, pubdate: Date.now() },
    ],
    popular: async () => [],
    view: async ({ bvid }) => ({ bvid, aid: bvid === 'BV1bbbbbbb2' ? 2 : 1, cid: 9, title: bvid === 'BV1bbbbbbb2' ? '猫猫做饭' : '米饭大赛', author: 'UP主', play: 20000, desc: '简介' }),
    subtitle: async () => '',
    comments: async () => [],
    postComment: async (aid, message) => { posted.push({ aid, message }); return { rpid: 1, missed: [] } },
    likeVideo: async () => {},
  }
  const hub = {
    runSystemTurn: async (name, title, prompt) => {
      if (prompt.includes('挑 3 个')) return '["米饭","猫咪"]'
      if (prompt.includes('看完说说你的想法')) {
        assert.match(prompt, /"shareGroup"/, '群分享开着时提示词里才有这个字段')
        return JSON.stringify([
          { i: 1, feeling: '米饭好香', comment: '', share: '', shareGroup: '群友快看这个米饭大赛', remember: '' },
          { i: 2, feeling: '猫好可爱', comment: '', share: '', shareGroup: '', remember: '' },
        ])
      }
      return ''
    },
    sendText: async (chatId, text) => { sent.push({ chatId, text }); return { message_id: 1 } },
    logChat: () => {},
  }
  const memory = { list: () => [], recentEvents: () => [], addEvent: () => {}, add: () => {} }
  const cfg = normalize({
    enabled: true, dryRun: false, ownerQQ: OWNER,
    bili: { enabled: true, cookie: 'SESSDATA=x; bili_jct=y', perRun: 2, groupShare: { enabled: true, groupId: GROUP } },
  })
  const log = { info() {}, warn() {}, debug() {} }
  const gs = share.createGroupShare({ getConfig: () => cfg, hub, log })
  const b = duty.createBili({ getConfig: () => cfg, hub, memory, log, api: fakeApi, groupShare: gs })
  const r = await b.run({ force: true })
  assert.equal(r.ok, true, r.message)
  assert.equal(r.awaitingGroup, 1)
  assert.match(r.message, /1 条等你批准发群/)
  assert.equal(sent.filter((x) => x.chatId === `group:${GROUP}`).length, 0, '刷的时候不直接发群')
  const ask = sent.find((x) => x.chatId === `private:${OWNER}` && /【群分享待批】/.test(x.text))
  assert.ok(ask, '攒完要问主人一次')
  assert.match(ask.text, /1\.《米饭大赛》 群友快看这个米饭大赛/)
  assert.equal(gs.pending().length, 1)

  // 主人回「发 1」才真发
  sent.length = 0
  assert.equal(gs.handleReply(`private:${OWNER}`, OWNER, '发 1'), true)
  await tick()
  const toGroup = sent.filter((x) => x.chatId === `group:${GROUP}`)
  assert.equal(toGroup.length, 1)
  assert.match(toGroup[0].text, /群友快看这个米饭大赛\nhttps:\/\/www\.bilibili\.com\/video\/BV1aaaaaaa1/)
})

test('群分享关着时提示词里不塞 shareGroup，也不攒', async () => {
  fresh()
  rmSync(store.dataDir('bili.json'), { force: true })
  const sent = []
  const fakeApi = {
    nav: async () => ({ isLogin: true }),
    search: async (kw) => [{ bvid: 'BV1aaaaaaa1', aid: 1, title: kw + ' 视频', play: 20000, pubdate: Date.now() }],
    popular: async () => [],
    view: async ({ bvid }) => ({ bvid, aid: 1, cid: 9, title: '米饭大赛', author: 'UP主', play: 20000, desc: '简介' }),
    subtitle: async () => '',
    comments: async () => [],
    postComment: async () => ({ rpid: 1, missed: [] }),
    likeVideo: async () => {},
  }
  const hub = {
    runSystemTurn: async (name, title, prompt) => {
      if (prompt.includes('挑 3 个')) return '["米饭"]'
      if (prompt.includes('看完说说你的想法')) {
        assert.doesNotMatch(prompt, /"shareGroup"/)
        return JSON.stringify([{ i: 1, feeling: '好香', comment: '', share: '', shareGroup: '不该被用到', remember: '' }])
      }
      return ''
    },
    sendText: async (chatId, text) => { sent.push({ chatId, text }); return { message_id: 1 } },
    logChat: () => {},
  }
  const memory = { list: () => [], recentEvents: () => [], addEvent: () => {}, add: () => {} }
  const cfg = normalize({
    enabled: true, dryRun: false, ownerQQ: OWNER,
    bili: { enabled: true, cookie: 'SESSDATA=x; bili_jct=y', perRun: 1, groupShare: { enabled: false, groupId: GROUP } },
  })
  const log = { info() {}, warn() {}, debug() {} }
  const gs = share.createGroupShare({ getConfig: () => cfg, hub, log })
  const b = duty.createBili({ getConfig: () => cfg, hub, memory, log, api: fakeApi, groupShare: gs })
  const r = await b.run({ force: true })
  assert.equal(r.ok, true, r.message)
  assert.equal(r.awaitingGroup, 0)
  assert.equal(gs.pending().length, 0)
  assert.equal(sent.filter((x) => /【群分享待批】/.test(x.text)).length, 0)
})

test('模拟返回（sim-*）和排队补发都不算发出去：不占额度、回执说没确认', async () => {
  for (const sendResult of [{ message_id: 'sim-3' }, { queued: true, queuedId: 'q1' }]) {
    fresh()
    const { gs, sent } = setup({ sendResult: (chatId) => (chatId.startsWith('group:') ? sendResult : { message_id: 1 }) })
    await gs.submit([{ bvid: 'BV1aaaaaaa1', title: 'A', text: 'a' }])
    sent.length = 0
    assert.equal(gs.handleReply(`private:${OWNER}`, OWNER, '发 1'), true)
    await tick()
    const s = store.readJson(file(), null)
    assert.equal(s.items.find((x) => x.bvid === 'BV1aaaaaaa1').state, 'failed')
    assert.equal(s.sentToday, 0, '没真发出去就不算额度')
    assert.match(sent.at(-1).text, /没确认发出去/)
  }
})

test('过期兜底：tick 没跑过，主人回「发 1」也不可能发过期的那条', async () => {
  fresh()
  const { gs, sent } = setup({ over: { pendingTtlHours: 1 } })
  await gs.submit([{ bvid: 'BV1aaaaaaa1', title: 'A', text: 'a' }])
  const s = store.readJson(file(), null)
  s.items[0].at = Date.now() - 2 * 3600_000
  store.writeJson(file(), s)
  sent.length = 0
  assert.equal(gs.handleReply(`private:${OWNER}`, OWNER, '发 1'), false, '过期的不接命令')
  await tick()
  assert.equal(sent.length, 0, '一条都不发、也不回执')
  assert.equal(gs.pending().length, 0)
  assert.equal(store.readJson(file(), null).items[0].state, 'expired')
})

test('已有别的群的待批时不攒新的，避免一句话里混两个群号', async () => {
  fresh()
  const a = setup()
  await a.gs.submit([{ bvid: 'BV1aaaaaaa1', title: 'A', text: 'a' }])
  // 同一个数据文件换群号再攒
  const b = setup({ over: { groupId: '30000003' } })
  const r = await b.gs.submit([{ bvid: 'BV1bbbbbbb2', title: 'B', text: 'b' }])
  assert.equal(r.ok, false)
  assert.match(r.why, /别的群/)
  assert.equal(b.gs.pending().length, 1)
})

test('审批消息发不出去（网关断线 / 试运行模拟）：这批直接作废，不留没人知道的待批', async () => {
  for (const sendResult of [null, { message_id: 'sim-1' }]) {
    fresh()
    const { gs } = setup({ sendResult })
    const r = await gs.submit([{ bvid: 'BV1aaaaaaa1', title: 'A', text: 'a' }])
    assert.equal(r.ok, false)
    assert.match(r.why, /审批消息没发出去/)
    assert.equal(gs.pending().length, 0, '不能留 pending')
    assert.equal(store.readJson(file(), null).items[0].state, 'failed')
  }
})

test('问完之后有条目过期：编号跟着当时的快照走，不会拿新条目顶上去', async () => {
  fresh()
  const { gs, sent } = setup({ over: { pendingTtlHours: 1 } })
  await gs.submit([
    { bvid: 'BV1aaaaaaa1', title: 'A', text: 'a' },
    { bvid: 'BV1bbbbbbb2', title: 'B', text: 'b' },
  ])
  const s = store.readJson(file(), null)
  s.items.find((x) => x.title === 'A').at = Date.now() - 2 * 3600_000
  store.writeJson(file(), s)
  sent.length = 0
  // 第 1 条已过期：回「发 1」不能把（现在排在首位的）B 发出去
  assert.equal(gs.handleReply(`private:${OWNER}`, OWNER, '发 1'), true)
  await tick()
  assert.equal(sent.filter((x) => x.chatId.startsWith('group:')).length, 0)
  assert.match(sent.at(-1).text, /第 1 条已经不在了/)
  // 第 2 条还在：照发 B
  assert.equal(gs.handleReply(`private:${OWNER}`, OWNER, '发 2'), true)
  await tick()
  const toGroup = sent.filter((x) => x.chatId.startsWith('group:'))
  assert.equal(toGroup.length, 1)
  assert.match(toGroup[0].text, /BV1bbbbbbb2/)
})

test('主人连发两次「发 1」：只发一条，额度只扣一次', async () => {
  fresh()
  const { gs, sent } = setup()
  await gs.submit([
    { bvid: 'BV1aaaaaaa1', title: 'A', text: 'a' },
    { bvid: 'BV1bbbbbbb2', title: 'B', text: 'b' },
  ])
  sent.length = 0
  assert.equal(gs.handleReply(`private:${OWNER}`, OWNER, '发 1'), true)
  assert.equal(gs.handleReply(`private:${OWNER}`, OWNER, '发 1'), true, '第二条命令也认，但会被链吃掉')
  await tick()
  assert.equal(sent.filter((x) => x.chatId.startsWith('group:')).length, 1)
  assert.equal(store.readJson(file(), null).sentToday, 1)
  assert.equal(gs.pending().length, 1, '另一条还在等')
})

test('发全部碰到额度：回执说清楚还剩几条（不是只说 1 条）', async () => {
  fresh()
  const { gs, sent } = setup({ over: { dailyLimit: 1 } })
  await gs.submit([
    { bvid: 'BV1aaaaaaa1', title: 'A', text: 'a' },
    { bvid: 'BV1bbbbbbb2', title: 'B', text: 'b' },
    { bvid: 'BV1ccccccc3', title: 'C', text: 'c' },
  ])
  sent.length = 0
  gs.handleReply(`private:${OWNER}`, OWNER, '发全部')
  await tick()
  assert.equal(sent.filter((x) => x.chatId.startsWith('group:')).length, 1)
  assert.match(sent.at(-1).text, /还有 2 条没发/)
  assert.equal(gs.pending().length, 2, '没发出去的还在待批里')
})

test('同一批里同一条视频只攒一次', async () => {
  fresh()
  const { gs } = setup()
  const r = await gs.submit([
    { bvid: 'BV1aaaaaaa1', title: 'A', text: 'a' },
    { bvid: 'BV1aaaaaaa1', title: 'A2', text: 'a2' },
  ])
  assert.equal(r.n, 1)
  assert.equal(gs.pending().length, 1)
})
