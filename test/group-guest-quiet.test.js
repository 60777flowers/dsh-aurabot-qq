// 对外静默窗口：这段内只有主人叫得醒她。
// 与 quietHours 正交——那个管她别插话（对主人），这个管别人别叫醒她。
import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_GROUP_POLICY, decideGroupReply, policyFor } from '../src/chat/group-policy.js'

const NOW = 1_800_000_000_000

function ask(over = {}) {
  return decideGroupReply({
    policy: { ...DEFAULT_GROUP_POLICY, ...(over.policy || {}) },
    mentioned: false,
    repliedToBot: false,
    fromOwner: false,
    lastIsBot: false,
    atOthersAny: false,
    text: '随便聊聊',
    now: NOW,
    hour: 12,
    recentTimes: [],
    interjectTimes: [],
    botReplyTimes: [],
    mustTimes: [],
    ...over,
  })
}

test('没配窗口时不影响任何人', () => {
  assert.equal(DEFAULT_GROUP_POLICY.guestQuietHours, null)
  const out = ask({ mentioned: true, hour: 3 })
  assert.equal(out.reply, true)
  assert.equal(out.mode, 'must')
})

test('窗口内客人被 @ 也不起轮次', () => {
  const out = ask({ policy: { guestQuietHours: [1, 8] }, mentioned: true, hour: 3 })
  assert.equal(out.reply, false)
  assert.match(out.reason, /对外静默/)
})

test('窗口内主人被 @ 照常叫得动', () => {
  const out = ask({ policy: { guestQuietHours: [1, 8] }, mentioned: true, fromOwner: true, hour: 3 })
  assert.equal(out.reply, true)
  assert.equal(out.mode, 'must')
})

test('窗口内叫名字、引用她的消息同样挡住', () => {
  const byName = ask({ policy: { guestQuietHours: [1, 8], wakeWords: ['大肥鱼'] }, text: '大肥鱼在吗', hour: 3 })
  assert.equal(byName.reply, false)
  const byQuote = ask({ policy: { guestQuietHours: [1, 8] }, repliedToBot: true, hour: 3 })
  assert.equal(byQuote.reply, false)
})

test('窗口外不受影响', () => {
  const out = ask({ policy: { guestQuietHours: [1, 8] }, mentioned: true, hour: 12 })
  assert.equal(out.reply, true)
  assert.equal(out.mode, 'must')
})

test('跨夜窗口两头都算窗口内', () => {
  const policy = { guestQuietHours: [23, 8] }
  assert.equal(ask({ policy, mentioned: true, hour: 2 }).reply, false)
  assert.equal(ask({ policy, mentioned: true, hour: 23 }).reply, false)
  assert.equal(ask({ policy, mentioned: true, hour: 12 }).reply, true)
})

test('单群覆盖能单独开关', () => {
  const global = { ...DEFAULT_GROUP_POLICY, guestQuietHours: null }
  const overrides = { 12345: { guestQuietHours: [1, 8] } }
  const quiet = policyFor(global, overrides, 12345)
  assert.deepEqual(quiet.guestQuietHours, [1, 8])
  assert.equal(ask({ policy: quiet, mentioned: true, hour: 3 }).reply, false)
  const other = policyFor(global, overrides, 99999)
  assert.equal(other.guestQuietHours, null)
  assert.equal(ask({ policy: other, mentioned: true, hour: 3 }).reply, true)
})
