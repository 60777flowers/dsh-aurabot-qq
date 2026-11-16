// 内置模块：目的引擎（主动搭话的新引擎，P1 起【默认开】，见 docs/SPEAKUP-INTO-PURPOSE-PLAN.md §3）。
// 像人一样定期主动找主人搭话：素材（记忆 + 聊天流水）→ 目标假设（带归属/置信度/风险）
// → 选一个目的 → 生成一句话 → 投递私聊。
//
// 与「主动搭话」（speakup）的关系（P1 迁移期）：speakup 模块仍在跑，但目的引擎开着时
// companion 会自动让位（既有软互斥），主动搭话实际由目的引擎承担；醒着窗口/白名单等
// 共享键仍冻结在 speakUp.*（Q3/Q4 拍板），由目的引擎维护。迁移说明见 docs/PURPOSE_MODULE_API.md。
//
// 薄壳只做注册；引擎在 src/purpose/engine.js（纯函数），接线在 src/purpose/module.js。

import { createPurpose } from '../../purpose/module.js'

export default {
  id: 'purpose',
  name: '目的引擎',
  version: '1.0.0',
  description: '像人一样主动找主人搭话：攒素材 → 记观察 → 立目标假设 → 挑一个候选，到点了才来找你。默认开启（主动搭话已并入目的引擎）；显式关过的不会被默认值洗回。',
  tab: 'speakup',
  files: ['purpose/engine.js', 'purpose/module.js'],
  defaults: {
    // P1/Q1 拍板：新装也默认开启。modules.js 的 defaults 填充只补「缺失键」，
    // 用户显式写过的 enabled:false 不会被这里的 true 洗掉（运行期语义在 purposeConfig 再兜一层：
    // ext.purpose.enabled 缺省视为开、显式 false 尊重）。
    enabled: true,
    minMaterials: 2, // 素材少于这个数（也没有惦记的事/人格卡）就不硬找话
    initialDelayMinutes: 15, // 启动后的第一枪延迟
    maxCandidates: 6,
    promptMaxChars: 16000,
  },
  settings: [
    { key: 'enabled', label: '启用目的引擎', type: 'boolean', hint: '默认开（主动搭话已并入目的引擎）。关掉后她不会再主动找你；开着时旧的「主动搭话」会自动让位，不会两套同时打扰' },
    { key: 'minMaterials', label: '最少素材数', type: 'number', min: 0, max: 20, hint: '低于这个数且没有惦记的事/人格卡时，这轮不硬找话' },
    { key: 'initialDelayMinutes', label: '启动延迟（分钟）', type: 'number', min: 1, max: 720, hint: '插件启动后第一次主动搭话前先等多久' },
    { key: 'maxCandidates', label: '候选方向数', type: 'number', min: 3, max: 10 },
  ],
  setup(api) {
    // ---------- P1 播种（方案 §3.1，只发生一次） ----------
    // 老用户（speakUp.enabled=true、ext.purpose.enabled 从未显式设置）升级瞬间由
    // defaults 填充把 enabled 补成 true；这里负责把「这次是无感迁移」记下来：
    // 写播种标记 seededFromSpeakup + 打一行迁移日志，之后重启不再重复。
    // 显式关过（ext.purpose.enabled === false）的不覆盖、不打标、不再提示。
    const seedCfg = api.config()
    const seedExt = (seedCfg.ext && seedCfg.ext.purpose) || {}
    if (seedCfg.speakUp?.enabled === true && seedExt.enabled !== false && !seedExt.seededFromSpeakup) {
      try {
        api.setConfig({ ext: { purpose: { enabled: true, seededFromSpeakup: true } } })
        api.log.info('主动搭话已并入目的引擎，已为你开启目的引擎（醒着时间/频率/白名单都沿用原设置）')
      } catch (error) {
        api.log.warn('播种目的引擎开关失败（不影响本轮运行）：', error?.message)
      }
    }
    const purpose = createPurpose({
      getConfig: api.config,
      setConfig: api.setConfig,
      hub: api.core.hub,
      log: api.log,
      isMuted: (chatId) => { try { return api.core.mutes.muted(chatId) } catch { return false } },
      mood: () => api.use('mood'),
      memory: () => api.use('memory'),
      // 载体分发用（面板里 carrier=pet 时推桌宠气泡；桌宠没开是 null，按离线回落处理）
      pet: () => api.use('pet'),
      // 素材口：浏览型模块（rss-reader「自主上网」等）的素材按需取用；没装/没开是 null。
      use: (id) => api.use(id),
      personaText: () => { try { return api.core.personas?.current?.() || '' } catch { return '' } },
    })
    api.every(60_000, () => purpose.tick(), '目的引擎')
    api.route('/purpose/fire', async () => {
      if (!api.settings().enabled) return { ok: false, message: '目的引擎没开（主动搭话页可以打开）' }
      const r = await purpose.fire('手动')
      if (!r) return { ok: false, message: '没有结果' }
      if (r.outcome === 'sent') return { ok: true, message: '已经去找你了' }
      if (r.outcome === 'silent') return { ok: true, message: '她这轮想了想，决定不说（不硬发）' }
      if (r.outcome === 'muted') return { ok: false, message: '主人在私聊里让她闭嘴了' }
      if (r.outcome === 'disabled') return { ok: false, message: '目的引擎开关是关的' }
      return { ok: true, message: `这轮结束：${r.outcome}` }
    })
    api.route('/purpose/status', async () => ({ ok: true, status: purpose.status(), state: purpose.state() }))
    api.route('/purpose/preview', async () => ({ ok: true, preview: await purpose.preview() }))
    // 代发决断面：宿主投递器在 broker 档发送前调用（见 purpose/module.js 的 brokerReview）。
    // 模块不直接用它；host.js 的 wirePolicySources 经 use('purpose') 取到。
    // （createPurpose 返回的对象方法都走闭包，无 this 依赖，直接透传即可。）
    // 引擎自发发言的 §5.3 私有凭据注入点：宿主把 purpose 策略源对象交给引擎，
    // 引擎投递时经 deliver 的 enginePolicy 路径 reserve/commit，不再被包装层门闸二次拦。
    // 驱动向量 → 提示层：把「最近比较想要什么」轻描淡写地写进每一轮的上下文（引擎关着时返回空）
    api.rule(() => purpose.drivesRule())
    return purpose
  },
}
