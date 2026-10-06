/**
 * Creator-facing names of the `vh_*` agent tools. The chat shows them in place of wire tool names: in the running
 * group title (through `tool.name.<wire name>` entries added to DSH's `chat` dictionary) and in each tool row.
 *
 * @module @video-harness/ui-composer/tool-labels
 */

/** Wire tool name → [Chinese, English] name. `vh_generate_video` has its own card and is named here for the title. */
export const VH_TOOL_LABELS: Readonly<Record<string, readonly [string, string]>> = {
  vh_project_create: ['新建项目', 'Create project'],
  vh_project_use: ['打开项目', 'Open project'],
  vh_project_state: ['查看项目', 'Read the project'],
  vh_turn_accept: ['接受草稿', 'Accept the draft'],
  vh_turn_reject: ['丢弃草稿', 'Discard the draft'],
  vh_undo: ['撤销', 'Undo'],
  vh_branch_create: ['新建分支', 'Create a branch'],
  vh_branch_use: ['切换分支', 'Switch branch'],
  vh_wait: ['等待生成完成', 'Wait for generation'],
  vh_asset_upload: ['上传素材', 'Upload asset'],
  vh_entity_character_create: ['新建人物', 'Create character'],
  vh_entity_character_update: ['修改人物', 'Update character'],
  vh_entity_style_create: ['新建风格', 'Create style'],
  vh_entity_style_update: ['修改风格', 'Update style'],
  vh_entity_location_create: ['新建场景', 'Create location'],
  vh_entity_location_update: ['修改场景', 'Update location'],
  vh_plan_create: ['制定计划', 'Create plan'],
  vh_plan_update: ['修改计划', 'Update plan'],
  vh_plan_approve: ['批准计划', 'Approve plan'],
  vh_sequence_create: ['新建一集', 'Create episode'],
  vh_sequence_replace: ['替换片段', 'Replace clips'],
  vh_sequence_move: ['移动片段', 'Move clip'],
  vh_sequence_set_range: ['调整片段范围', 'Set clip range'],
  vh_sequence_insert: ['插入片段', 'Insert clip'],
  vh_sequence_remove: ['移除片段', 'Remove clip'],
  vh_sequence_split: ['拆分片段', 'Split clip'],
  vh_sequence_rename: ['重命名这一集', 'Rename episode'],
  vh_sequence_delete: ['删除这一集', 'Delete episode'],
  vh_generate_video: ['生成视频', 'Generate video'],
  vh_media_concat: ['拼接视频', 'Join videos'],
  vh_media_extract_frame: ['截取画面', 'Extract frame'],
  vh_media_probe: ['读取媒体信息', 'Read media info'],
  vh_perception_describe: ['查看画面', 'Look at image'],
}

/**
 * Add a `tool.name.<wire name>` entry per `vh_*` tool to the Chinese and English dictionaries of DSH's `chat`
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
