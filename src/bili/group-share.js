// 刷 B 站刷到想发到群里的视频：不直接发，先攒成待批，私聊问主人「发几号」。
// 形状抄两处现成的：security/approval.js 的「私聊问一句 + handleReply 截流」、
// autotelic 的 say-pending.json 的数组落盘。不同点是这里要带内容、带编号、能批量、能过期。

import { dataDir, readJson, writeJson } from '../core/store.js'

const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
export const linkOf = (bvid) => (bvid ? `https://www.bilibili.com/video/${bvid}` : '')
const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n)

// 只认「发 / 发送」开头：批准、同意、允许、拒绝、取消这些词 DSH 的工具授权中继也在用
// （src/security/approval.js 的 APPROVE_RE / REJECT_RE，在消息进到模块之前就被它消费），
// 这里再用同一批词会抢词、让主人搞不清自己刚批准了哪件事。
const SEND_ONE = /^(?:发|发送)#?(\d{1,2})$/
const SEND_ALL = /^(?:发|发送)(?:全部|所有|都发|全发)$/
const SEND_BARE = /^(?:发|发送)$/
const SKIP_ONE = /^(?:不发|别发)#?(\d{1,2})$/
const SKIP_ALL = /^(?:不发|别发)(?:全部|所有|都|全)?$/

/**
 * 解析主人对「群分享待批」的回复。只认短命令，别的都返回 null（交给聊天，别把正常聊天吞了）。
 * 返回 { action: 'send' | 'skip', index: number, all?: true }，index 从 1 开始；
 * index 为 0 表示没带编号（all 为真才是「全部」，否则只是裸「发」）。
 */
export function parseDecision(raw) {
  const text = String(raw || '').replace(/\s+/g, '').trim()
  if (!text || text.length > 12) return null
  let m
  if ((m = text.match(SEND_ONE))) { const i = Number(m[1]); return i > 0 ? { action: 'send', index: i } : null }
  if (SEND_ALL.test(text)) return { action: 'send', index: 0, all: true }
  if ((m = text.match(SKIP_ONE))) { const i = Number(m[1]); return i > 0 ? { action: 'skip', index: i } : null }
  if (SKIP_ALL.test(text)) return { action: 'skip', index: 0, all: true }
  if (SEND_BARE.test(text)) return { action: 'send', index: 0 }
  return null
}

export function createGroupShare({ getConfig, hub, log = console } = {}) {
  const file = () => dataDir('bili-group-share.json')
  const load = () => {
    const s = readJson(file(), () => ({ day: '', sentToday: 0, nextId: 1, items: [] }))
    if (!s || typeof s !== 'object') return { day: dayKey(), sentToday: 0, nextId: 1, items: [] }
    if (!Array.isArray(s.items)) s.items = []
    if (!Number.isFinite(Number(s.nextId))) s.nextId = 1
    if (s.day !== dayKey()) { s.day = dayKey(); s.sentToday = 0 }
    return s
  }
  const save = (s) => writeJson(file(), s)
  const cfg = () => getConfig().bili?.groupShare || {}
  const pendingOf = (s) => s.items.filter((x) => x.state === 'pending')
  // 所有「处理待批」的动作排一条链：decide 会 await 发群，期间再来一条命令（主人连发两次「发 1」）
  // 若各自拿一份内存状态副本，就会双发群、sentToday 互相覆盖。串行 + 每步重新 load 才稳。
  let chain = Promise.resolve()
  const enqueue = (task) => {
    chain = chain.then(task).catch((error) => log.warn('处理群分享出错：', error.message))
    return chain
  }
  const ownerChat = () => `private:${getConfig().ownerQQ}`

  /** 一次问清楚：编号 = 当前待批列表的顺序（最老的第一条是 1）。 */
  async function ask(s) {
    const list = pendingOf(s)
    if (!list.length) return true
    const hours = Number(cfg().pendingTtlHours) || 24
    const lines = [`【群分享待批】想把这几条发到群里（${list[0].groupId}）：`]
    list.forEach((it, i) => lines.push(`${i + 1}.《${clip(it.title, 40)}》 ${clip(it.text, 80)}`))
    lines.push(`回复「发 1」发第 1 条，「不发 1」丢掉；也可以「发全部」/「不发全部」。${hours} 小时内没回就当不发。`)
    // 编号 → 条目 id 的快照：之后有过期或已处理，编号也不会错位到别的条目。
    // 必须在这里落盘：submit 是先 save 再 ask 的，不存的话主人回复时就只剩「当前顺序」。
    s.lastAsked = { at: Date.now(), ids: list.map((x) => x.id) }
    save(s)
    try {
      const r = await hub.sendText(ownerChat(), lines.join('\n'))
      const shown = Boolean(r) && r.message_id !== undefined && !String(r.message_id).startsWith('sim-')
      if (!shown) log.warn('群分享的审批消息没发出去，这批先作废')
      return shown
    } catch (error) {
      log.warn('群分享的审批消息没发出去，这批先作废：', error.message)
      return false
    }
  }

  /**
   * 把她想发到群的几条攒进待批，并问主人一次。items: [{ bvid, title, text }]
   * 试运行 / 总开关关着 / 没配群号时一律不攒（审批消息本身也发不出去，攒了只会烂在文件里）。
   */
  async function submit(items = []) {
    const g = getConfig()
    const c = cfg()
    if (!c.enabled || !c.groupId) return { ok: false, why: '群分享没开' }
    if (!g.enabled) return { ok: false, why: '总开关关着' }
    if (g.dryRun) return { ok: false, why: '试运行，不攒待批' }
    if (!g.ownerQQ) return { ok: false, why: '没配主人的 QQ' }
    const s = load()
    if (s.sentToday >= Number(c.dailyLimit)) return { ok: false, why: `今天已经发够 ${c.dailyLimit} 条了` }
    const have = pendingOf(s)
    if (have.some((x) => String(x.groupId) !== String(c.groupId))) return { ok: false, why: '还有别的群的待批没回，先处理完' }
    const room = Math.max(0, Number(c.queueLimit) - have.length)
    if (!room) return { ok: false, why: '待批的还没回，先不攒新的' }
    const fresh = []
    for (const it of (Array.isArray(items) ? items : []).slice(0, room)) {
      const bvid = String(it.bvid || '').trim()
      const text = String(it.text || '').trim()
      if (!bvid || !text) continue
      // 同一条视频：待批里有了就不重复问，今天已经发过也不再问
      if (have.some((x) => x.bvid === bvid)) continue
      if (fresh.some((x) => x.bvid === bvid)) continue
      if (s.items.some((x) => x.bvid === bvid && x.state === 'sent')) continue
      const item = { id: s.nextId++, at: Date.now(), bvid, title: clip(it.title, 80), text: clip(text, 300), groupId: String(c.groupId), state: 'pending', decidedAt: 0 }
      s.items.push(item)
      fresh.push(item)
    }
    s.items = s.items.slice(-50)
    if (!fresh.length) { save(s); return { ok: false, why: '没有能攒的新条目' } }
    save(s)
    if (!(await ask(s))) {
      // 问不出去就等于没有待批：留着只会 24 小时后静默过期
      const at = Date.now()
      for (const it of fresh) { it.state = 'failed'; it.decidedAt = at }
      save(s)
      return { ok: false, why: '审批消息没发出去' }
    }
    log.info(`B 站群分享：攒了 ${fresh.length} 条待批，已问主人`)
    return { ok: true, n: fresh.length }
  }

  async function decide(ids, action) {
    // 每次进链都重新读文件：排队期间上一条命令可能已经处理过同一批
    const s = load()
    const touched = []
    let sent = 0
    let dropped = 0
    let failed = 0
    for (const id of ids) {
      const it = s.items.find((x) => x.id === id)
      if (!it || it.state !== 'pending') continue // 已经处理过 / 过期了，跳过，绝不再发一次
      const c = cfg()
      if (action === 'skip') { it.state = 'rejected'; it.decidedAt = Date.now(); save(s); dropped++; touched.push(it); continue }
      if (s.sentToday >= Number(c.dailyLimit)) continue // 额度用尽的留在 pending，等明天或主人处理
      if (getConfig().dryRun) { it.state = 'dry'; it.decidedAt = Date.now(); save(s); dropped++; touched.push(it); continue }
      try {
        const r = await hub.sendText(`group:${it.groupId}`, `${it.text}\n${linkOf(it.bvid)}`)
        // 只有网关真给了 message_id 才算发出去：模拟返回（sim-*）和「排队补发」都不占额度
        const delivered = Boolean(r) && r.message_id !== undefined && !String(r.message_id).startsWith('sim-')
        it.state = delivered ? 'sent' : 'failed'
        it.decidedAt = Date.now()
        if (delivered) { s.sentToday++; sent++ } else failed++
      } catch (error) {
        it.state = 'failed'
        it.decidedAt = Date.now()
        failed++
        log.warn('群分享没发出去：', error.message)
      }
      save(s) // 每处理一条就落盘：中途崩了也不会重复发
      touched.push(it)
    }
    const left = ids.filter((id) => {
      const it = s.items.find((x) => x.id === id)
      return it && it.state === 'pending'
    }).length
    const groupId = touched[0]?.groupId
    const limit = Number(cfg().dailyLimit)
    const lines = []
    if (sent) lines.push(`发到群 ${groupId} 了（${sent} 条）`)
    if (dropped) lines.push(`按你说的没发 ${dropped} 条`)
    if (left) lines.push(`还有 ${left} 条没发：今天的群分享额度用完了（${limit}）`)
    if (failed) lines.push(`${failed} 条没确认发出去（可能排在补发队里），看看群还在不在、网关通不通`)
    if (lines.length) {
      try { await hub.sendText(ownerChat(), lines.join('；')) } catch (error) { log.warn('群分享回执没发出去：', error.message) }
    }
    return { sent, dropped, failed, left }
  }

  /** 主人的私聊回复。认出来就返回 true（不再交给她），认不出返回 false。 */
  function handleReply(chatId, userId, text) {
    const g = getConfig()
    if (!g.ownerQQ || chatId !== ownerChat() || String(userId) !== String(g.ownerQQ)) return false
    const s = load()
    if (expireIn(s)) save(s) // 网关断线时 tick 可能很久没跑，回话前先清一次，别把过期的发出去
    const list = pendingOf(s)
    if (!list.length) return false
    const d = parseDecision(text)
    if (!d) return false
    if (d.all) {
      const ids = list.map((x) => x.id)
      enqueue(() => decide(ids, d.action))
      return true
    }
    if (d.index === 0) {
      if (list.length === 1) {
        const ids = [list[0].id]
        enqueue(() => decide(ids, d.action))
      }
      else {
        const tip = `现在有 ${list.length} 条待批，回复「发 1」「发 2」挑一条，或者「发全部」。`
        Promise.resolve().then(() => hub.sendText(ownerChat(), tip)).catch((error) => log.warn('群分享提示没发出去：', error.message))
      }
      return true
    }
    // 按问话时的编号表解析；没有快照（老数据）才退回当前顺序
    const askedIds = Array.isArray(s.lastAsked?.ids) ? s.lastAsked.ids : null
    const id = askedIds ? askedIds[d.index - 1] : list[d.index - 1]?.id
    if (id === undefined) {
      Promise.resolve().then(() => hub.sendText(ownerChat(), `没有第 ${d.index} 条，现在只有 ${list.length} 条待批。`)).catch(() => {})
      return true
    }
    const one = list.find((x) => x.id === id)
    if (!one) {
      // 问过的那条已经过期或被处理掉了：宁可说清楚，也不拿同编号的新条目顶上去
      Promise.resolve().then(() => hub.sendText(ownerChat(), `第 ${d.index} 条已经不在了（过期或已经处理过），现在有 ${list.length} 条待批。`)).catch(() => {})
      return true
    }
    const ids = [one.id]
    enqueue(() => decide(ids, d.action))
    return true
  }

  /** 在已载入的状态上扫一遍过期：过了 pendingTtlHours 的待批标 expired（不发、不吵主人）。 */
  function expireIn(s) {
    const ttl = Math.max(1, Number(cfg().pendingTtlHours) || 24) * 3600_000
    let n = 0
    for (const it of s.items) {
      if (it.state !== 'pending') continue
      if (Date.now() - Number(it.at || 0) <= ttl) continue
      it.state = 'expired'
      it.decidedAt = Date.now()
      n++
    }
    return n
  }

  /** 每分钟顺手调（tick 里）；主人回话时 handleReply 也会先扫一遍，免得网关断线期间 tick 没跑。 */
  function expire() {
    const s = load()
    const n = expireIn(s)
    if (n) { save(s); log.info(`有 ${n} 条群分享待批过期了，没发`) }
    return n
  }

  return { submit, handleReply, expire, pending: () => pendingOf(load()), linkOf }
}
