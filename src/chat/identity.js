import { parseMessageEvent } from './inbound.js'

/** QQ 号才是身份，群名片和旧昵称不能用来认领另一个人的发言。 */
export function identityNote(selfId) {
  const id = String(selfId || '')
  return `【发言身份】你的 QQ 号是 ${id || '未确认'}。记录中其他 QQ 号都是其他人，即使昵称与你一样；补读记录中只有标为“机器人本人”的消息才是你发的。@ 和引用的接收对象按 QQ 号判断，不能把别人被问到的作品、经历或发言认成自己的。“某某：……”也可能是群友转述，不代表你说过。没有标明账号的旧记录不能用来确认身份。旧回复和记忆只说明过去聊过什么，不能覆盖当前人设，也不能证明你做过某事。`
}

/** 启动补读保留发送者账号、@ 对象与机器人标记，不再退化成只有昵称的记录。 */
export function flatHistory(list, selfId, { clockLabel } = {}) {
  return (Array.isArray(list) ? list : []).flatMap(m => {
    let message = m?.message ?? m?.raw_message ?? ''
    let mentioned = false
    if (typeof message === 'string') {
      // 历史接口也可能返回 CQ 字符串。保留原文字和引用码，只展开有明确账号的 @；
      // 不走实时入站的纯文字兼容分支（它会移除 CQ 码）。
      const text = message.replace(/\[CQ:at,([^\]]*)\]/g, (raw, fields) => {
        const qq = fields.split(',').find(field => field.startsWith('qq='))?.slice(3)
        if (qq === 'all') return '@全体成员 '
        if (!/^\d+$/.test(qq || '')) return raw
        if (selfId && qq === String(selfId)) mentioned = true
        return `@${qq} `
      })
      message = [{ type: 'text', data: { text } }]
    } else if (Array.isArray(message)) {
      // 昵称不能替代账号，尤其群友和机器人恰好同名时。
      message = message.map(seg => seg?.type === 'at' && seg.data?.name && seg.data?.qq
        ? { ...seg, data: { ...seg.data, name: `${seg.data.name}(${seg.data.qq})` } } : seg)
    }
    const parsed = parseMessageEvent({ ...m, message, sender: { ...m?.sender, nickname: m?.sender?.nickname || m?.nickname } }, selfId)
    const uid = parsed.userId
    const who = parsed.nickname || String(m?.nickname || '')
    const text = parsed.text.replace(/\s+/g, ' ').trim().slice(0, 120)
    if (!who && !text) return []
    const self = uid && selfId && uid === String(selfId)
    const at = Number(m?.time) > 0 ? Number(m.time) * 1000 : 0
    const stamp = at && clockLabel ? `${clockLabel(at)} ` : ''
    return [`${stamp}${self ? '机器人本人·' : '群友·'}${who}(${uid || '账号未知'})${mentioned || parsed.mentioned ? '@了机器人' : ''}：${text}`]
  })
}
