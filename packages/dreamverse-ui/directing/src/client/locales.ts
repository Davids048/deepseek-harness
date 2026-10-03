/** Locale-owned copy of the DreamVerse prompt event timeline. */
export const zh = {
  original: '原始',
  current: '当前',
  edit: '编辑',
} satisfies Record<string, string>

/** Prompt event timeline dictionary key union. */
export type DreamverseDirectingKey = keyof typeof zh

/** English dictionary with the same keys. */
export const en = {
  original: 'Original',
  current: 'Current',
  edit: 'Edit',
} satisfies Record<DreamverseDirectingKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** DreamVerse prompt event timeline badges. */
    'dreamverse.directing': DreamverseDirectingKey
  }
}
