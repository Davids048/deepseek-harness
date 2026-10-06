/**
 * Creator-facing names of the agent tools: the `dv_*` tools of the components. The chat shows
 * them in place of wire tool names: in the running group title (through `tool.name.<wire name>` entries added to DSH's
 * `chat` dictionary) and in each tool row.
 *
 * @module @video-harness/ui-composer/tool-labels
 */

/** Wire tool name → [Chinese, English] name. `dv_shot_render` has its own card and is named here for the title. */
export const VH_TOOL_LABELS: Readonly<Record<string, readonly [string, string]>> = {
  dv_proj_create: ['新建项目', 'Create project'],
  dv_proj_open: ['打开项目', 'Open project'],
  dv_proj_state: ['查看项目', 'Read the project'],
  dv_proj_draft_accept: ['接受草稿', 'Accept the draft'],
  dv_proj_draft_discard: ['丢弃草稿', 'Discard the draft'],
  dv_proj_undo: ['撤销', 'Undo'],
  dv_proj_redo: ['重做', 'Redo'],
  dv_proj_stale_accept: ['保留过期结果', 'Keep out-of-date result'],
  dv_proj_history_list: ['查看历史', 'List history'],
  dv_proj_branch_create: ['新建分支', 'Create a branch'],
  dv_proj_branch_switch: ['切换分支', 'Switch branch'],
  dv_proj_wait: ['等待生成完成', 'Wait for generation'],
  dv_asset_import: ['导入素材', 'Import asset'],
  dv_bible_character_create: ['新建角色', 'Create character'],
  dv_bible_character_update: ['修改角色', 'Update character'],
  dv_bible_location_create: ['新建场景', 'Create location'],
  dv_bible_location_update: ['修改场景', 'Update location'],
  dv_bible_style_create: ['新建风格', 'Create style'],
  dv_bible_style_update: ['修改风格', 'Update style'],
  dv_plan_create: ['新建分镜计划', 'Create plan'],
  dv_plan_update: ['修改分镜计划', 'Update plan'],
  dv_plan_approve: ['批准分镜计划', 'Approve plan'],
  dv_timeline_create: ['新建时间线', 'Create timeline'],
  dv_timeline_rename: ['重命名时间线', 'Rename timeline'],
  dv_timeline_delete: ['删除时间线', 'Delete timeline'],
  dv_timeline_clip_insert: ['插入片段', 'Insert clip'],
  dv_timeline_clip_move: ['移动片段', 'Move clip'],
  dv_timeline_clip_remove: ['移除片段', 'Remove clip'],
  dv_timeline_clip_split: ['拆分片段', 'Split clip'],
  dv_timeline_clip_trim: ['裁剪片段', 'Trim clip'],
  dv_timeline_clip_replace: ['替换片段', 'Replace clip'],
  dv_shot_render: ['生成镜头', 'Render shot'],
  dv_deliver_timeline_export: ['导出时间线', 'Export timeline'],
  dv_asset_grab_still: ['截取静帧', 'Grab still'],
  dv_inspect_image: ['检查画面', 'Inspect image'],
  dv_inspect_asset: ['检查素材', 'Inspect asset'],
}

/**
 * Add a `tool.name.<wire name>` entry per labelled tool to the Chinese and English dictionaries of DSH's `chat`
 * namespace, which the running group title reads. The locale runtime refuses a second registration of a namespace
 * and keeps one dictionary object per namespace and language, so the entries are written into those objects; the
 * caller re-runs this when the runtime announces dictionaries registered later.
 * @param locale - `ctx.locale`.
 */
export function addToolNames(locale: unknown): void {
  const dicts: unknown = locale === undefined || locale === null ? undefined : Reflect.get(locale as object, 'dicts')
  if (!(dicts instanceof Map)) return
  const byLocale: unknown = dicts.get('chat')
  if (!(byLocale instanceof Map)) return
  const zh: unknown = byLocale.get('zh')
  const en: unknown = byLocale.get('en')
  for (const [name, [zhName, enName]] of Object.entries(VH_TOOL_LABELS)) {
    if (zh !== null && typeof zh === 'object') Reflect.set(zh, `tool.name.${name}`, zhName)
    if (en !== null && typeof en === 'object') Reflect.set(en, `tool.name.${name}`, enName)
  }
}
