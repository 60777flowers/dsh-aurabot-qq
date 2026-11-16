// 内置模块：主动搭话。主人一阵子没找她时，她会在私聊里主动找主人聊几句（群里不会）。
// P2b（speakup → purpose 迁移，Q2 拍板）：小闹钟已整体迁进目的引擎（purpose 模块）——
// 工具/上下文/触发都由 purpose 承担，数据兼容读旧 speakup-reminders.json；
// 这里的 /speakup/reminder/close 只做转发（面板 P2-client 改指 /purpose/reminder/close 后随 P4 移除）。

import { createSpeakUp } from '../../features/companion.js'

export default {
  id: 'speakup',
  name: '主动搭话',
  version: '1.0.0',
  description: '主人一阵子没理她时，在私聊里主动找主人说话',
  tab: 'speakup',
  files: ['features/companion.js'],
  setup(api) {
    const { hub, mutes } = api.core
    const speakUp = createSpeakUp({ getConfig: api.config, hub, log: api.log, isMuted: (chatId) => mutes.muted(chatId), memory: () => api.use('memory') })
    api.every(60_000, () => (api.core.onebot?.state && api.core.onebot.state !== 'connected' ? undefined : speakUp.tick()), '主动搭话')
    api.route('/speakup/fire', async () => {
      if (!api.config().enabled) return { ok: false, message: '先打开总开关' }
      await speakUp.fire('手动')
      return { ok: true, message: '叫她去找你了' }
    })
    // P2b：小闹钟迁 purpose 后的兼容转发（跨模块只走 api.use，不 import 内部函数）
    api.route('/speakup/reminder/close', async (req) => {
      const body = await api.core.http.body(req).catch(() => ({}))
      const pu = api.use('purpose')
      if (pu && typeof pu.closeReminder === 'function') return pu.closeReminder(body?.id)
      return { ok: false, message: '目的引擎没在跑，小闹钟暂不可用' }
    })
    return speakUp
  },
}
