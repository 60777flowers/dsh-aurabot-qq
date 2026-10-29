// 内置模块：生图。她能画图发到聊天里（OpenAI 兼容的生图服务、自定义接口、ChatGPT 订阅，或「本地接口」里的 SD WebUI / ComfyUI）。

import { readFileSync } from 'node:fs'
import { createImageGen, drawResultBlocks, drawToolMessage } from '../../features/imagegen.js'
import { listPaintings, openPaintFolder, paintingPath, removePainting, savePainting } from '../../features/paintings.js'
import { defineTool, str } from '../../tools/tools.js'
import { dataDir } from '../../core/store.js'
import { mimeOf } from '../../chat/inbound.js'

export default {
  id: 'imagegen',
  name: '生图',
  version: '1.0.0',
  description: '画一张图发到聊天里（qq_draw_image）',
  tab: 'imagegen',
  files: ['features/imagegen.js', 'features/paintings.js', 'features/codex-auth.js'],
  setup(api) {
    const { hub, local } = api.core
    const memory = api.lazy('memory')
    const gen = createImageGen({ getConfig: api.config, log: api.log, local, dsh: api.dsh })
    const auth = gen.codexAuth

    // ChatGPT 订阅登录（OAuth）：发起 → 轮询状态 → 手动粘贴 → 退出
    api.route('/image/codex/status', async () => ({ ok: true, ...auth.status(), login: auth.loginStatus() }))
    api.route('/image/codex/login', async () => {
      try {
        const r = await auth.startLogin({})
        return { ok: true, ...r, ...auth.loginStatus() }
      } catch (error) {
        return { ok: false, message: error.message }
      }
    })
    api.route('/image/codex/login/status', async () => ({ ok: true, ...auth.loginStatus(), ...auth.status() }))
    api.route('/image/codex/complete', async (req) => {
      const b = await api.core.http.body(req).catch(() => ({}))
      try {
        const c = await auth.completeLogin(String((b && b.input) || ''))
        return { ok: true, email: c.email || '', accountId: c.accountId || '' }
      } catch (error) {
        return { ok: false, message: error.message }
      }
    })
    api.route('/image/codex/cancel', async () => ({ ok: true, ...auth.cancelLogin('已取消') }))
    api.route('/image/codex/logout', async () => ({ ok: true, ...auth.logout() }))

    // 她的画作：面板底下那个图库（直接读存图目录，不单独维护索引）
    api.route('/image/gallery', async (req) => {
      const q = api.core.http.query(req)
      const limit = q && q.limit ? Number(q.limit) : api.config().imageGen.galleryShown
      return { ok: true, ...listPaintings({ limit }), dir: dataDir('imagegen') }
    })
    api.route('/image/gallery/image', async (req, res) => {
      const p = paintingPath(api.core.http.query(req).file)
      if (!p) return api.core.http.send(res, 404, '')
      const buf = readFileSync(p)
      api.core.http.send(res, 200, buf, String(mimeOf(buf) || 'image/png'))
    })
    api.route('/image/gallery/delete', async (req) => {
      const b = await api.core.http.body(req).catch(() => ({}))
      return removePainting(String((b && b.file) || ''))
    })
    api.route('/image/open-folder', async () => openPaintFolder())

    api.tool(({ chat, sessionId }) => (gen.enabled() && chat.kind !== 'system' ? defineTool({
      name: 'qq_draw_image',
      description: '画一张图并发到当前 QQ 聊天里。prompt 用中文或英文详细描述画面（主体、动作、场景、风格）。shape 用来定画面比例：画立绘/壁纸用竖图，画风景/长卷用宽幅，表情/头像用方图；拿不准就不填，按内容自己定。画好会直接发出去；你自己能看图时会把原图一并给你，不能看图时给你一段画面描述。回复里简单说一两句就行。',
      properties: {
        prompt: str('画面描述'),
        shape: {
          type: 'string',
          enum: ['square', 'portrait', 'landscape', 'wide'],
          description: '画面比例：square 方图 / portrait 竖图 / landscape 横图 / wide 宽幅。不填就按内容自己定',
        },
      },
      required: ['prompt'],
      // 允许看图时工具结果里带原图（附件块），她当轮就能看见自己画了什么
      render: drawResultBlocks,
      execute: async ({ prompt, shape }) => {
        if (api.config().imageGen.ownerOnly && !hub.turnSendersAllOwner(sessionId)) return { ok: false, message: '画图只给主人画哦' }
        const startedAt = Date.now()
        const buf = await gen.generate(String(prompt || ''), { shape: String(shape || '') })
        const sent = await hub.sendSegments(chat.chatId, [{ type: 'image', data: { file: 'base64://' + buf.toString('base64') } }], `[生图] ${String(prompt).slice(0, 30)}`)
        if (!sent) return { ok: false, message: '画好了，但没有发到 QQ（请检查试运行和网关）' }
        const saved = savePainting(buf, String(prompt || ''))
        if (saved) api.log.debug(`生图已存盘：${saved}`)
        try {
          memory.addEvent?.({ text: `按提示词画了一张图（不一定等于实际画面）：${String(prompt).slice(0, 120)}`, about: chat.kind === 'private' ? chat.userId : '', tags: ['画画'], importance: 0.4 })
        } catch (error) {
          api.log.warn('生图已发送，但经历没记下来：', error.message)
        }

        // 「画完自己看一眼」是总开关：关掉就当没视觉能力处理 —— 不给图、不调模型看图、也不给路径。
        // 能看图时才把图缩好登记成附件块；图没登记成（缩图失败 / 没附件服务）同样按「没给看」算。
        const visual = (await hub.canSeeImages(chat)) === true
        const seeOwn = api.config().imageGen.seeOwn !== false
        const allowLook = visual && seeOwn
        const seen = allowLook ? await gen.look(buf, String(prompt || '')) : ''
        let img = null
        if (allowLook) {
          img = await gen.toolImage(buf)
          if (!img) api.log.debug('这次生图没把图交给模型（缩图/登记失败），只给文字')
        }

        let message
        if (!visual) message = drawToolMessage({ visual: false })
        else if (!seeOwn) message = drawToolMessage({ visual: true, seeOwn: false })
        else if (!img) message = drawToolMessage({ visual: false })
        else message = drawToolMessage({ seen, visual: true, seeOwn: true })

        const out = {
          ok: true,
          message,
          prompt: String(prompt || ''),
          bytes: buf.length,
          elapsedMs: Date.now() - startedAt,
          ...(saved ? { path: saved } : {}),
        }
        if (img) out.image = img
        // 只有**图真的交给模型了**才把本地路径告诉她（#59）：收录表情包 / 存素材 / qq_add_sticker 用；
        // 看不了图或开关关着时不给路径，免得她知道路径就去读图，绕开「不给看」的判断。
        if (img && saved) out.message += `\n已保存到本机：${saved}（要收录表情包、存素材时可以用这个路径）`
        return out
      },
    }) : []))
    return gen
  },
}
