// 回归 #33：这台机器没有拍照硬件，模型会在正文里写「（图片发出）」「（拍了一张新的）」
// 这类假动作描写。它们不是真正的图片消息段，不能当正文发到 QQ；清洗要只剥这类短动作短语，
// 普通括号动作、颜文字、占位符和代码示例都不能误伤。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseReply, cleanOutboundText, cleanOutboundSegments } from '../src/chat/reply.js'

const texts = (r) => r.items.filter((i) => i.kind === 'text').map((i) => i.value)
const text = (value) => ({ type: 'text', data: { text: value } })

const FAKE_ACTIONS = [
  '（图片发出）',
  '（图片已发出）',
  '（图片发出去了）',
  '（图片发送成功）',
  '（照片发你了）',
  '（图片给你发过去了）',
  '（图发你了）',
  '（拍了一张新的）',
  '（拍了张新照片）',
  '（刚刚拍了一张新的照片）',
  '（照片拍好了）',
]

test('整条只有假媒体动作：按沉默处理，一个字都不发', () => {
  for (const value of FAKE_ACTIONS) {
    assert.deepEqual(parseReply(value), { silent: true, items: [] }, value)
  }
})

test('假媒体动作混在正文里：只剥动作短语，前后的话保留', () => {
  assert.deepEqual(texts(parseReply('好呀（图片已发出）你看看')), ['好呀你看看'])
  assert.deepEqual(texts(parseReply('给你看看（图片发出）')), ['给你看看'])
  assert.deepEqual(texts(parseReply('（拍了一张新的）这张好看吗')), ['这张好看吗'])
  assert.deepEqual(texts(parseReply('（图片发出）|||这张好看')), ['这张好看'])
})

test('一条里多个假动作一起出现也全部剥掉', () => {
  assert.deepEqual(parseReply('（图片发出）（拍了一张新的）'), { silent: true, items: [] })
  assert.deepEqual(texts(parseReply('（图片发出）好看（照片发你了）')), ['好看'])
})

test('cleanOutboundText 是共用出口：非 parseReply 路径也要剥', () => {
  assert.equal(cleanOutboundText('（图片发出）'), '')
  assert.equal(cleanOutboundText('看（图片已发出）'), '看')
  assert.equal(cleanOutboundText('（照片发你了）这张'), '这张')
})

test('cleanOutboundSegments 跨文字段也按原文坐标剥干净，图片段保留', () => {
  const image = { type: 'image', data: { file: 'https://example.com/a.png' } }
  assert.deepEqual(cleanOutboundSegments([text('看图'), text('（图片发出）'), image]), [text('看图'), image])
  assert.deepEqual(cleanOutboundSegments([text('（图片'), text('发出）'), image]), [image])
})

test('普通括号动作、颜文字和 [图片] 占位不误伤', () => {
  for (const value of ['（笑）', '（凑近看了看）', '（揉了揉眼睛）', '（￣▽￣）', '(๑•̀ㅂ•́)و✧', '（图片）', '（拍照）']) {
    assert.deepEqual(texts(parseReply(value)), [value], value)
  }
  assert.deepEqual(texts(parseReply('[图片] 这张好看')), ['[图片] 这张好看'])
})

test('代码示例里的假动作写法保留（行内代码与围栏都算）', () => {
  const inline = '例如 `（图片发出）` 这种写法'
  assert.equal(cleanOutboundText(inline), inline)
  const fence = '```text\n（图片发出）\n```'
  assert.equal(cleanOutboundText(fence), fence)
})

test('带上下文的普通叙述不整段误删', () => {
  const value = '（她拍了一张新的照片放在桌上）'
  assert.deepEqual(texts(parseReply(value)), [value])
  assert.equal(cleanOutboundText(value), value)
})
