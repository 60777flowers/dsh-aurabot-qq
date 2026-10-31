// 内置模块：B 站。别人发来链接时她能「看」视频（标题、简介、字幕、热评）；定时自己去刷、评论、回评论，看到好玩的分享给主人。

import { readFileSync } from 'node:fs'
import { createBili } from '../../bili/duty.js'
import { defineTool, str } from '../../tools/tools.js'
import { profileToolVisible, profilePermits } from '../../chat/access.js'
import { avatarSource } from '../profile/index.js'
import { resolvePainting } from '../../features/paintings.js'
import { segmentBytes } from '../../core/net.js'

export default {
  id: 'bili',
  name: 'B站',
  version: '1.1.0',
  description: '看别人发的 B 站视频；定时自己刷、评论、回评论；抽帧看画面、发截图；按权限改自己的头像 / 签名（bili_watch / bili_comment / qq_send_shot / bili_set_avatar / bili_set_sign）',
  tab: 'bili',
  files: ['bili/duty.js', 'bili/api.js', 'bili/vision.js', 'bili/shots.js'],
  setup(api) {
    const { hub } = api.core
    const lastImage = new Map() // chatId → 最近一张图的网址（给 bili_set_avatar 的 last 用）
    api.on('message', (msg) => {
      const url = (msg.images || []).slice(-1)[0]?.data?.url
      if (url && /^https?:\/\//i.test(url)) lastImage.set(msg.chatId, url)
      return false
    })
    const bili = createBili({ getConfig: api.config, hub, memory: api.lazy('memory'), log: api.log, dsh: api.dsh })
    api.every(60_000, () => bili.tick(), '刷B站')

    // 看视频谁发的链接都能看，评论要主人开口
    api.tool(({ chat, sessionId }) => {
      if (!api.config().bili.enabled || chat.kind === 'system') return []
      return [
        defineTool({
          name: 'bili_watch',
          description: '打开一个 B 站视频看看：读标题、简介、字幕和热评，看完再跟大家聊。别人发来 B 站链接、BV 号或分享卡片时用。link 填链接或 BV 号。',
          properties: { link: str('B 站链接、b23.tv 短链或 BV 号') },
          required: ['link'],
          execute: async ({ link }) => bili.watch(String(link || '')),
        }),
        defineTool({
          name: 'bili_comment',
          description: '在一个 B 站视频下发评论（只有主人让你发的时候才用）。link 填链接或 BV 号，text 是评论内容。',
          properties: { link: str('B 站链接或 BV 号'), text: str('评论内容') },
          required: ['link', 'text'],
          execute: async ({ link, text }) => {
            if (!hub.turnSendersAllOwner(sessionId)) return { ok: false, message: '只有主人能让我去发评论' }
            return bili.comment(String(link || ''), String(text || ''))
          },
        }),
        // 截图：刷 B 站看画面时截下来的那些帧，存在本机，随时能挑一张发出来
        defineTool({
          name: 'qq_send_shot',
          description: '把你在 B 站视频里截到的画面发到当前聊天。主人说「发张截图」「给我看看你刷到的」「刚才那个视频长啥样」这类话时用。query 填视频标题里的词或想看的内容，不填就挑最近的一张。',
          properties: { query: str('可选：视频标题关键词，或想看的内容') },
          required: [],
          execute: async ({ query }) => {
            if (!hub.turnSendersAllOwner(sessionId)) return { ok: false, message: '截图只给主人看' }
            return bili.sendShot({ chatId: chat.chatId, query: String(query || '') })
          },
        }),
        defineTool({
          name: 'qq_list_shots',
          description: '看看你手上还有哪些 B 站截图（来自哪个视频、第几秒）。挑截图之前可以先看一眼。',
          properties: { query: str('可选，按视频标题筛选') },
          required: [],
          execute: async ({ query }) => {
            if (!hub.turnSendersAllOwner(sessionId)) return { ok: false, message: '截图只给主人看' }
            return bili.listShots(String(query || ''))
          },
        }),
      ]
    })

    // 改 B 站头像 / 签名：权限在面板「权限」页（关 / 仅主人私聊 / 所有人），默认仅主人私聊
    api.tool(({ chat, sessionId }) => {
      const cfg = api.config()
      if (!cfg.bili.enabled) return []
      const tools = []
      if (profileToolVisible(cfg, 'biliAvatar', chat)) tools.push(defineTool({
        name: 'bili_set_avatar',
        description: '换你自己 B 站账号的头像。image 填图片网址；填 last 就用这个聊天里刚才别人发的那张图；填「画作 #1」就用你自己刚画的那张（画完时会告诉你编号）。图超过 2MB 会自动缩小。',
        properties: { image: str('图片网址（http/https）／last（刚才那张图）／画作编号（如 #1）') },
        required: ['image'],
        execute: async ({ image }) => {
          const c = api.config()
          if (!c.bili.enabled) return { ok: false, message: 'B 站没打开' }
          const p = profilePermits(c, 'biliAvatar', chat, hub.turnSendersAllOwner(sessionId))
          if (!p.ok) return p
          const chatId = hub.chatOfSession?.(sessionId) || chat.chatId
          const raw = String(image || '').trim()
          // ① 自己画的图：按编号取文件（不让她接触路径）
          const looksLikePath = /^https?:\/\//i.test(raw) || /^[a-zA-Z]:[\\/]|^\/(?!\/)|^file:|^base64:/i.test(raw)
          const pref = /^画作/i.test(raw) ? (raw.replace(/^画作\s*[:：#]?\s*/i, '').trim() || '画作') : raw
          const isPainting = !looksLikePath && (/^#?\d{1,2}$/.test(pref) || /^画作$/i.test(pref) || /\.(png|jpe?g|webp|gif)$/i.test(pref))
          if (isPainting) {
            const painting = resolvePainting(chatId, pref)
            if (!painting) return { ok: false, message: `找不到画作 ${raw}（编号可能过期了，先让我画一张？）` }
            let buf
            try {
              buf = readFileSync(painting.path)
            } catch (error) {
              return { ok: false, message: '这张画的文件读不到了：' + error.message }
            }
            return bili.setAvatar(buf)
          }
          // ② 刚才那张图：优先取图片字节（QQ 图片经常没有可用网址），拿不到再退回记下的网址
          if (!raw || /^(last|刚才|上一张|最近)/i.test(raw)) {
            const media = hub.recentMedia?.(chatId) || []
            const pick = media.filter((x) => !x.sticker).at(-1) || media.at(-1)
            if (pick) {
              try {
                const buf = await segmentBytes(pick.seg, api.core.onebot, { maxBytes: 10 * 1024 * 1024 })
                if (buf && buf.length) return bili.setAvatar(buf)
              } catch (error) { /* 退回网址 */ }
            }
            const previous = lastImage.get(chatId)
            if (!previous) return { ok: false, message: '最近半小时这个聊天里没人发过图片，先把图发过来' }
            return bili.setAvatar(previous)
          }
          // ③ 显式网址
          const src = avatarSource(raw)
          if (!src.ok) return src
          return bili.setAvatar(src.file)
        },
      }))
      if (!profileToolVisible(cfg, 'biliSign', chat)) return tools
      return [...tools, defineTool({
        name: 'bili_set_sign',
        description: '改你自己 B 站账号的个性签名（最多 70 字）。有人让你改 B 站签名时用。',
        properties: { text: str('新的签名') },
        required: ['text'],
        execute: async ({ text }) => {
          const c = api.config()
          if (!c.bili.enabled) return { ok: false, message: 'B 站没打开' }
          const p = profilePermits(c, 'biliSign', chat, hub.turnSendersAllOwner(sessionId))
          if (!p.ok) return p
          return bili.setSign(text)
        },
      })]
    })

    api.route('/bili/state', async () => ({ ok: true, ...bili.state(), account: await bili.account() }))
    api.route('/bili/account', async () => bili.account(true))
    api.route('/bili/run', async () => bili.run({ force: true }))
    api.route('/bili/replies', async () => bili.checkReplies())
    // 截图库（面板里看全部、手动删）
    api.route('/bili/shots', async () => ({ ...bili.libraryShots(), limit: api.config().bili.shotLibrary }))
    api.route('/bili/shot/image', async (req, res) => {
      const p = bili.shotFileOf(api.core.http.query(req).file)
      if (!p) return api.core.http.send(res, 404, '')
      return api.core.http.send(res, 200, readFileSync(p), 'image/jpeg')
    })
    api.route('/bili/shot/delete', async (req) => bili.deleteShot(String((await api.core.http.body(req)).file || '')))
    return bili
  },
}
