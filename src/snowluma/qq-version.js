// QQ 版本软判断：只用来给提示，不拦注入。
//
// SnowLuma 只能注入 QQ NT 内核（9.9 及以上）；老 QQ 9.7 / TIM 3.x 注入不了。
// 版本号读不到时退回路径判断：QQNT 目录 = NT，QQ\Bin 目录 = 老版。
// 判定结果只有 nt=true / false / null（未知），调用方决定怎么提示。

/** @param {string} version @param {string} exePath */
export function classifyQqVersion(version, exePath = '') {
  const v = String(version || '').trim()
  const p = String(exePath || '')
  const m = v.match(/^(\d+)\.(\d+)/)
  if (m) {
    const major = Number(m[1])
    const minor = Number(m[2])
    if (major > 9) return { nt: true, label: 'NT' }
    if (major === 9 && minor >= 9) return { nt: true, label: 'NT' }
    return { nt: false, label: '老版（非 NT）' }
  }
  if (/QQ[ _-]?NT/i.test(p)) return { nt: true, label: 'NT（按安装目录判断）' }
  if (/[\\/]QQ[\\/]Bin[\\/]/i.test(p)) return { nt: false, label: '老版（按安装目录判断）' }
  return { nt: null, label: '版本未知' }
}
