// Only send speech to the free endpoint selected here. Never redirect credentials.
export async function fishSpeech(text, key, request = fetch, referenceId = '', signal = AbortSignal.timeout(90000)) {
  if (!key?.trim()) throw new Error('请在「语音 → 扩展服务 → Fish Audio」填写 API Key')
  if (referenceId && !/^[a-f\d]{32}$/i.test(referenceId)) throw new Error('Fish 音色 ID 应为 32 位十六进制字符')
  const response = await request('https://api.fish.audio/v1/tts', {
    method: 'POST', redirect: 'error', signal,
    headers: { Authorization: `Bearer ${key.trim()}`, 'content-type': 'application/json', model: 's2.1-pro-free' },
    body: JSON.stringify({ text, format: 'mp3', ...(referenceId && { reference_id: referenceId }) }),
  })
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw Object.assign(new Error(response.status === 401 || response.status === 403 ? `Fish 拒绝访问（HTTP ${response.status}），请检查 API Key 和音色权限` : `Fish Free 合成失败（HTTP ${response.status}）`), { status: response.status, retryAfter: response.headers.get('retry-after') })
  }
  const audio = Buffer.from(await response.arrayBuffer())
  if (audio.length < 4 || !(audio.subarray(0, 3).toString() === 'ID3' || (audio[0] === 255 && (audio[1] & 224) === 224))) throw new Error('Fish Free 未返回 MP3 音频')
  return audio
}
