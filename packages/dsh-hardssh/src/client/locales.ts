/**
 * Locale dictionaries for the dsh-hardssh surface (zh/en).
 * The key union derives from the zh dictionary (mirrors the dsh-ssh locale
 * pattern), so the LocaleNamespaceMap augmentation types the `t` seat and
 * the register call against exactly the shipped keys.
 */

/** Locale namespace this plugin owns. */
export const NS = 'dsh-hardssh'

/** The zh dictionary (the key union source). */
export const zh = {
  'manager.label': 'SSH 工作区',
  'manager.tooltip': '管理 SSH 工作区：绑定服务器目录，绑定后的会话在远程操作，其余会话在本机',
  'manager.title': 'SSH 工作区管理',
    'manager.empty': '还没有 SSH 工作区',
  'manager.delete': '删除',
  'manager.editServer': '编辑服务器',
  'manager.deleteServer': '删除服务器',
  'manager.newHost': '新建服务器',
  'manager.hostInUse': '该服务器仍有 %d 个工作区，请先删除工作区',
        'create.host': '服务器',
  'create.hostEmpty': '未配置 SSH 主机，请先在设置页配置',
  'create.dir': '远程目录',
  'create.dirPlaceholder': '点击「浏览」选择远程目录，或输入绝对路径（如 /data/home/user/project）',
  'create.browse': '浏览…',
  'create.up': '上级',
  'create.current': '当前：',
  'create.titleLabel': '工作区名称',
  'create.titlePlaceholder': '如 zebrafish、atac-pipeline',
  'create.submit': '创建',
  'create.cancel': '取消',
  'create.connecting': '正在连接…',
  'create.needHost': '请先选择服务器',
  'create.needDir': '请选择或输入远程目录',
  'create.needTitle': '请填写工作区名称',
      'host.add': '添加服务器…',
  'host.save': '保存服务器',
  'host.needFields': '别名、主机、用户名为必填项',
  'host.needPassword': '密码为必填项（当前仅支持密码认证）',
  'dialog.alias': '别名',
  'dialog.host': '主机',
  'dialog.port': '端口',
  'dialog.user': '用户名',
  'dialog.password': '密码',
      'flow.local': '本地工作区…',
  'flow.ssh': 'SSH 工作区…',
  'flow.useThisDir': '使用此目录',
  'panel.loading': '加载中…',
  'gate.failed': '连接 SSH 服务器 %s 失败',
  'gate.retryLimit': '多次交互后仍未连上，请稍后重试或在 SSH 面板检查服务器',
              }

/** The key union (used by the LocaleNamespaceMap augmentation). */
export type WorkspaceKey = keyof typeof zh

/** The en dictionary (same key set). */
export const en: Record<WorkspaceKey, string> = {
  'manager.label': 'SSH workspaces',
  'manager.tooltip': 'Manage SSH workspaces: bind a server directory — sessions in a bound workspace operate remotely, all others stay local',
  'manager.title': 'SSH Workspaces',
    'manager.empty': 'No SSH workspaces yet',
      'manager.delete': 'Delete',
  'manager.editServer': 'Edit server',
  'manager.deleteServer': 'Delete server',
  'manager.newHost': 'New server',
  'manager.hostInUse': 'This server still backs %d workspace(s) — delete them first',
        'create.host': 'Server',
  'create.hostEmpty': 'No SSH host configured — add one in Settings first',
  'create.dir': 'Remote directory',
  'create.dirPlaceholder': 'Click Browse to pick a remote directory, or type an absolute path (e.g. /data/home/user/project)',
  'create.browse': 'Browse…',
  'create.up': 'Up',
  'create.current': 'Current: ',
  'create.titleLabel': 'Workspace name',
  'create.titlePlaceholder': 'e.g. zebrafish, atac-pipeline',
  'create.submit': 'Create',
  'create.cancel': 'Cancel',
  'create.connecting': 'Connecting…',
  'create.needHost': 'Pick a server first',
  'create.needDir': 'Pick or type a remote directory',
  'create.needTitle': 'Give the workspace a name',
      'host.add': 'Add server…',
  'host.save': 'Save server',
  'host.needFields': 'Alias, host and user are required',
  'host.needPassword': 'Password is required (password auth only for now)',
  'dialog.alias': 'Alias',
  'dialog.host': 'Host',
  'dialog.port': 'Port',
  'dialog.user': 'User',
  'dialog.password': 'Password',
      'flow.local': 'Local workspace…',
  'flow.ssh': 'SSH workspace…',
  'flow.useThisDir': 'Use this directory',
  'panel.loading': 'Loading…',
  'gate.failed': 'Failed to connect SSH server %s',
  'gate.retryLimit': 'Still not connected after several attempts — retry later or check the server in the SSH panel',
              }

/** The dictionary pair registered into the locale service. */
export const dictionaries = { zh, en } as const
