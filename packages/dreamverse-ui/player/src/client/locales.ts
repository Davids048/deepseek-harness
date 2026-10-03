/** Locale-owned copy of the DreamVerse video player. */
export const zh = {
  connecting: '正在连接…',
  'gpu.waiting': '正在等待 GPU…',
  generating: '正在生成视频…',
  placeholder: '你的视频将显示在这里',
  'playback.error': '播放错误',
  'queue.title': '排队中',
  'queue.busy': '所有 GPU 当前都在忙碌。',
  'queue.position': '排队位置：',
  share: '分享视频',
  download: '下载视频',
} satisfies Record<string, string>

/** Video player dictionary key union. */
export type DreamversePlayerKey = keyof typeof zh

/** English dictionary with the same keys. */
export const en = {
  connecting: 'Connecting…',
  'gpu.waiting': 'Waiting for GPU…',
  generating: 'Generating video…',
  placeholder: 'Your video will appear here',
  'playback.error': 'Playback Error',
  'queue.title': 'In Queue',
  'queue.busy': 'All GPUs are currently busy.',
  'queue.position': 'Position: ',
  share: 'Share video',
  download: 'Download video',
} satisfies Record<DreamversePlayerKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** DreamVerse video player status, queue, and playback copy. */
    'dreamverse.player': DreamversePlayerKey
  }
}
