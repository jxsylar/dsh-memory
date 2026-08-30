/** User-facing copy for the Memory settings section. */

export const en = {
  nav: 'Memory',
  title: 'Memory',
  subtitle: 'Local Markdown memory managed by the Host.',
  refresh: 'Refresh',
  status: 'Status:',
  loading: 'Loading…',
  enabled: 'Enabled',
  global: 'Global:',
  bytes: '{count} bytes',
  workspaces: 'Workspaces:',
  root: 'Root:',
  sections: 'Memory sections',
  globalTab: 'Global',
  workspacesTab: 'Workspaces',
  sessionsTab: 'Sessions',
  saveGlobal: 'Save Global Memory',
  workspacePlaceholder: 'Workspace memory management',
  sessionPlaceholder: 'Session consolidation',
  placeholderBody: 'This surface is reserved by the architecture and will be connected in the next implementation milestone.',
  loopbackOnly: 'This page is available only from the loopback Web host.',
  conflict: 'GLOBAL.md changed since this page loaded. Refresh before saving again.',
} as const

export type MemoryLocaleKey = keyof typeof en

export const zh: { [Key in MemoryLocaleKey]: string } = {
  nav: '记忆',
  title: '记忆',
  subtitle: '由 Host 管理的本地 Markdown 长期记忆。',
  refresh: '刷新',
  status: '状态：',
  loading: '加载中…',
  enabled: '已启用',
  global: '全局记忆：',
  bytes: '{count} 字节',
  workspaces: '工作区：',
  root: '根目录：',
  sections: '记忆分区',
  globalTab: '全局',
  workspacesTab: '工作区',
  sessionsTab: '会话',
  saveGlobal: '保存全局记忆',
  workspacePlaceholder: '工作区记忆管理',
  sessionPlaceholder: '会话整理',
  placeholderBody: '该界面已在架构中预留，将在下一个实现里程碑接通。',
  loopbackOnly: '此页面只能从本机回环 Web Host 访问。',
  conflict: '此页面加载后 GLOBAL.md 已发生变化，请刷新后再保存。',
}

export type MemoryTranslate = (
  key: MemoryLocaleKey,
  params?: Readonly<Record<string, unknown>>,
) => string
