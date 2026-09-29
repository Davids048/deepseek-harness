import { isJsonObject } from './json.ts'

/** The preset ID of a project that starts from the user's own prompt instead of a story preset. */
export const DEFAULT_CUSTOM_PRESET_ID = 'custom_editable'

/**
 * Normalize a preset ID to lowercase letters, digits, and single underscores.
 * @param value - the preset ID to normalize.
 * @returns the normalized ID, or {@link DEFAULT_CUSTOM_PRESET_ID} when nothing remains.
 */
export function sanitizePresetId(value: string | null | undefined): string {
  const normalized = (value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return normalized || DEFAULT_CUSTOM_PRESET_ID
}

/** One story preset: a labeled prompt sequence that starts a project with at least two segments. */
export interface StoryPreset {
  id: string
  label: string
  description?: string | undefined
  segment_prompts: string[]
}

/**
 * Read the story presets from the bundled preset JSON, keeping only complete presets with trimmed text.
 * @param rawPresets - the preset list, or a module namespace whose `default` export is the list.
 * @returns the valid presets in their original order.
 */
export function parseStoryPresets(rawPresets: unknown): StoryPreset[] {
  const source = presetEntries(rawPresets)
  const parsed: StoryPreset[] = []
  for (const entry of source) {
    if (!isJsonObject(entry)) continue
    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    const label = typeof entry.label === 'string' ? entry.label.trim() : ''
    const prompts = entry.segment_prompts

    if (id && label && isNonEmptyStringList(prompts) && prompts.length >= 2) {
      parsed.push({
        id,
        label,
        description: typeof entry.description === 'string' ? entry.description.trim() : undefined,
        segment_prompts: prompts.map(prompt => prompt.trim()),
      })
    }
  }

  return parsed
}

/** The preset list itself, the `default` export of a JSON module namespace, or no entries. */
function presetEntries(rawPresets: unknown): readonly unknown[] {
  if (Array.isArray(rawPresets)) return rawPresets
  if (typeof rawPresets === 'object' && rawPresets !== null && 'default' in rawPresets
    && Array.isArray(rawPresets.default)) {
    return rawPresets.default
  }
  return []
}

/** Whether every item is a string with non-whitespace text. */
function isNonEmptyStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === 'string' && item.trim() !== '')
}
