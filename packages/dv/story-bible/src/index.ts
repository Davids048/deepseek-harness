/**
 * The Story bible component of DreamVerse as the `dvStoryBible` Cordis service: characters, locations and styles with
 * their reference images. It owns six operations, a create and an update per kind (`bible.character_create`,
 * `bible.character_update`, and the same for `location` and `style`), and the `bible` reducer that turns their records
 * into versions. Each create or update writes the next version of an ID; a shot names a version as the input
 * `<id>@<version>`, which stands for that version's reference images.
 *
 * The operations write only their records. `dvProject` turns each into its agent tool (`dv_bible_character_create`,
 * and so on), resolves `<id>@<version>` inputs through the reducer's `assetsOf`, and marks every record that read a
 * version stale once an update supersedes the record that wrote it.
 *
 * @module @dv/story-bible
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { OperationContext, OperationResult, OperationSpec, ProjectState, RecordId } from '@dv/project'
import { BIBLE_KINDS, bibleReducer, kindOf, latestVersion, type BibleKind } from './reducer.ts'

export * from './types.ts'
export { bibleReducer } from './reducer.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The Story bible component: characters, locations and styles with their reference images. */
    dvStoryBible: DvStoryBible
  }
}

/** `dvStoryBible` plugin configuration; the component has no settings. */
export type Config = Record<string, unknown>

/** Loader validation. */
export const Config: z<Config> = z.object({})

/** What each kind is, in the words of the operation descriptions. */
const MEANING: Record<BibleKind, string> = {
  character: 'a person who must look the same across shots',
  location: 'a place shots happen in',
  style: 'a reusable visual look',
}

/** The `reference` input role of every Story bible operation. */
const REFERENCE_INPUT = {
  reference: { type: 'image', many: true, description: 'The reference images of the version, in order.' },
} as const satisfies OperationSpec['inputs']

/**
 * A params field as text.
 * @param value - the field.
 * @param fallback - the text for an absent or non-string field.
 * @returns the text.
 */
function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

/** The Story bible service: the `bible` reducer and the six operations. */
export default class DvStoryBible extends Service {
  static inject = ['dvProject']
  static Config = Config

  constructor(ctx: Context) {
    super(ctx, 'dvStoryBible')
    ctx.effect(() => ctx.dvProject.registerReducer('bible', bibleReducer), 'dvStoryBible reducer')
    for (const kind of BIBLE_KINDS) {
      for (const spec of [createOperation(kind), updateOperation(kind)]) {
        ctx.effect(() => ctx.dvProject.registerOperation(spec), `dvStoryBible ${spec.name}`)
      }
    }
  }
}

/**
 * `bible.<kind>_create`: version 1 of a new ID.
 * @param kind - the kind.
 * @returns the operation.
 */
function createOperation(kind: BibleKind): OperationSpec {
  return {
    name: `bible.${kind}_create`,
    component: 'bible',
    version: '1',
    description: `Create a ${kind} (${MEANING[kind]}) with its reference images. Writes version 1; a shot names it as the input `
      + `<${kind}>@1, which stands for those reference images. The ID must not name another character, location or style.`,
    inputs: REFERENCE_INPUT,
    params: {
      [kind]: { type: 'string', required: true, description: 'Short stable ID, such as c1; without @ or #.' },
      name: { type: 'string', required: true, description: 'Display name.' },
      description: { type: 'string', description: 'Words carried into every prompt: wardrobe, mood, or look.' },
    },
    outputs: [],
    deterministic: false,
    resource: 'none',
    confirm: 'never',
    summarize: record => `${kind} ${text(record.params['name'], text(record.params[kind]))} created`,
    execute(context: OperationContext): Promise<OperationResult> {
      const id = text(context.params[kind])
      if (id === '' || /[@#]/.test(id)) throw new Error(`The ${kind} ID '${id}' must be non-empty and contain no @ or #.`)
      const used = kindOf(context.state.components.bible, id)
      if (used !== null) throw new Error(`The ID '${id}' already names a ${used}; update it, or choose another ID.`)
      return Promise.resolve({ outputs: [] })
    },
  }
}

/**
 * `bible.<kind>_update`: the next version of an ID. It supersedes the record that wrote the current version, so the
 * records that read that version become stale.
 * @param kind - the kind.
 * @returns the operation.
 */
function updateOperation(kind: BibleKind): OperationSpec {
  return {
    name: `bible.${kind}_update`,
    component: 'bible',
    version: '1',
    description: `Update a ${kind}: new reference images, name, or description. Writes the next version, which keeps what the `
      + 'call does not change, and marks everything made with the previous version as stale.',
    inputs: REFERENCE_INPUT,
    params: {
      [kind]: { type: 'string', required: true, description: `The ${kind} ID.` },
      name: { type: 'string', description: 'Display name.' },
      description: { type: 'string', description: 'Words carried into every prompt: wardrobe, mood, or look.' },
    },
    outputs: [],
    deterministic: false,
    resource: 'none',
    confirm: 'never',
    supersedes: (params: Record<string, unknown>, state: ProjectState): RecordId[] => {
      const current = latestVersion(state.components.bible, kind, text(params[kind]))
      return current === undefined ? [] : [current.created_by]
    },
    summarize: record => `${kind} ${text(record.params[kind])} updated`,
    execute(context: OperationContext): Promise<OperationResult> {
      const id = text(context.params[kind])
      if (latestVersion(context.state.components.bible, kind, id) === undefined) throw new Error(`Unknown ${kind} '${id}'.`)
      return Promise.resolve({ outputs: [] })
    },
  }
}
