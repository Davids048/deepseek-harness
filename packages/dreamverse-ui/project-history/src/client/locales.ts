/** Locale-owned copy of the DreamVerse project history sidebar. */
export const zh = {
  'time.justNow': '刚刚',
  'time.minutes': '{count} 分钟前',
  'time.hours': '{count} 小时前',
  'time.days': '{count} 天前',
  'sidebar.label': '项目历史',
  title: '项目',
  'close.label': '关闭侧边栏',
  'project.starting': '正在新建项目…',
  'project.new': '新建项目',
  assets: '素材',
  current: '当前',
  'project.untitled': '未命名项目',
  disconnected: '已断开',
  active: '活跃',
  previous: '之前',
  'delete.confirm.label': '确认删除项目',
  'delete.confirm': '删除？',
  'delete.label': '删除项目',
  empty: '还没有项目',
} satisfies Record<string, string>

/** Project history dictionary key union. */
export type DreamverseProjectHistoryKey = keyof typeof zh

/** English dictionary with the same keys. */
export const en = {
  'time.justNow': 'just now',
  'time.minutes': '{count}m ago',
  'time.hours': '{count}h ago',
  'time.days': '{count}d ago',
  'sidebar.label': 'Project history',
  title: 'Projects',
  'close.label': 'Close sidebar',
  'project.starting': 'Starting new project...',
  'project.new': 'New project',
  assets: 'Assets',
  current: 'Current',
  'project.untitled': 'Untitled project',
  disconnected: 'Disconnected',
  active: 'Active',
  previous: 'Previous',
  'delete.confirm.label': 'Confirm delete project',
  'delete.confirm': 'Delete?',
  'delete.label': 'Delete project',
  empty: 'No projects yet',
} satisfies Record<DreamverseProjectHistoryKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** DreamVerse project history headings, states, actions, and elapsed times. */
    'dreamverse.projectHistory': DreamverseProjectHistoryKey
  }
}
