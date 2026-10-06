/**
 * Types of the Story bible component: one version of a character, a location or a style, and the `bible` slice of the
 * project state. The three ID types are defined in `@dv/project`, because record inputs name versions, and re-exported
 * here.
 *
 * @module @dv/story-bible/types
 */
import type { AssetId, CharacterId, LocationId, RecordId, StyleId } from '@dv/project'

export type { CharacterId, LocationId, StyleId } from '@dv/project'

/** One version of a character: a person who must look the same across shots. */
export interface Character {
  id: CharacterId
  /** 1 for the version `bible.character_create` wrote, one more for each `bible.character_update`. */
  version: number
  /** Display name. */
  name: string
  /** Wardrobe and mood words carried into prompts. */
  description: string
  /** The reference images the version stands for; a shot that names `<id>@<version>` carries them. */
  references: AssetId[]
  /** The record that wrote this version. */
  created_by: RecordId
}

/** One version of a location: a place shots happen in. */
export interface Location {
  id: LocationId
  /** 1 for the version `bible.location_create` wrote, one more for each `bible.location_update`. */
  version: number
  /** Display name. */
  name: string
  /** Look and mood words carried into prompts. */
  description: string
  /** The reference images the version stands for. */
  references: AssetId[]
  /** The record that wrote this version. */
  created_by: RecordId
}

/** One version of a style: a reusable visual look with reference images. */
export interface Style {
  id: StyleId
  /** 1 for the version `bible.style_create` wrote, one more for each `bible.style_update`. */
  version: number
  /** Display name. */
  name: string
  /** Style words carried into prompts. */
  description: string
  /** The reference images the version stands for. */
  references: AssetId[]
  /** The record that wrote this version. */
  created_by: RecordId
}

/** The `bible` slice: every version of each character, location and style, oldest first, by ID. */
export interface StoryBibleState {
  characters: Record<CharacterId, Character[]>
  locations: Record<LocationId, Location[]>
  styles: Record<StyleId, Style[]>
}

declare module '@dv/project' {
  interface ComponentStates {
    /** Characters, locations and styles with their versions (the Story bible component). */
    bible: StoryBibleState
  }
}
