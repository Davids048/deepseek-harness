/** Locale-owned copy of the DreamVerse asset library dialog. */
export const zh = {
  'dialog.label': '素材库',
  title: '素材',
  'close.label': '关闭素材库',
  close: '关闭',
  description: '保存图片、视频和音频，以便在各个项目中复用。选择图片来引导生成。',
  'upload.label': '上传素材',
  uploading: '正在上传…',
  upload: '上传',
  'upload.failed': '上传失败。',
  'delete.failed': '删除失败。',
  empty: '没有已保存的素材。',
  'use.label': '使用 {name}',
  use: '用作参考',
  'delete.label': '删除 {name}',
  delete: '删除',
  'preview.unsupported': '浏览器无法预览 {name}。请尝试其他受支持的格式。',
  'assetRequest.status': '素材请求失败（{status}）。',
  'assetRequest.listInvalid': '素材列表响应无效。',
  'assetRequest.listEntryInvalid': '素材列表响应包含无效的素材记录。',
  'assetRequest.uploadInvalid': '素材上传响应不是素材记录。',
} satisfies Record<string, string>

/** Asset library dictionary key union. */
export type DreamverseAssetsKey = keyof typeof zh

/** English dictionary with the same keys. */
export const en = {
  'dialog.label': 'Asset library',
  title: 'Assets',
  'close.label': 'Close asset library',
  close: 'Close',
  description: 'Save images, video, and audio for reuse across projects. Select images to guide generation.',
  'upload.label': 'Upload assets',
  uploading: 'Uploading…',
  upload: 'Upload',
  'upload.failed': 'Upload failed.',
  'delete.failed': 'Delete failed.',
  empty: 'No saved assets.',
  'use.label': 'Use {name}',
  use: 'Use as reference',
  'delete.label': 'Delete {name}',
  delete: 'Delete',
  'preview.unsupported': 'Your browser cannot preview {name}. Try another supported format.',
  'assetRequest.status': 'Asset request failed ({status}).',
  'assetRequest.listInvalid': 'The asset list response is invalid.',
  'assetRequest.listEntryInvalid': 'The asset list response contains an invalid asset record.',
  'assetRequest.uploadInvalid': 'The asset upload response is not an asset record.',
} satisfies Record<DreamverseAssetsKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** DreamVerse asset library labels, actions, and failures. */
    'dreamverse.assets': DreamverseAssetsKey
  }
}
