/**
 * The operation record: the only way a video harness project changes. Every generation, upload, edit, approval, and
 * branch is one record; the canvas, the timeline, and the chat are projections of the sequence of records.
 *
 * @module @video-harness/oplog/types
 */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { AssetId, OpId } from '@video-harness/assets'

export type { AssetId, OpId } from '@video-harness/assets'

/** The ID of one turn: a user message with the agent's work for it, or one user gesture on a view. */
export type TurnId = Branded<'VhTurnId'>

/** The ID of a project, which names its directory under the log root. */
export type ProjectId = Branded<'VhProjectId'>

/** The ID of a versioned entity such as a character; versions are `${EntityId}@${number}`. */
export type EntityId = Branded<'VhEntityId'>

/** A reference to one version of an entity, as written in an operation's inputs. */
export type EntityRef = `${string}@${number}`

/**
 * A reference to the n-th output of another operation, as written in the inputs of a scheduled operation whose
 * producer has not finished yet: `<op_id>#<index>`.
 */
export type OutputRef = `${string}#${number}`

/** Anything an input may reference. */
export type InputRef = AssetId | EntityRef | OutputRef

/** Who performed an operation. */
export type Actor = 'user' | 'agent' | 'system'

/** Which view the operation came from. */
export type Surface = 'chat' | 'timeline' | 'canvas' | 'api' | 'tool'

/** What a record represents. */
export type OpKind = 'tool' | 'command' | 'plan' | 'approve' | 'reject' | 'revert' | 'branch' | 'accept_stale' | 'intent'

/** Lifecycle of an operation; transitions only move forward. */
export type OpStatus = 'pending' | 'running' | 'done' | 'failed'

/** One input of an operation: an asset, or an entity version that execution resolved to an asset. */
export interface OpInput {
  role: string
  ref: InputRef
  /** The concrete asset the input stood for when the operation ran; null until resolved or for inputs without bytes. */
  resolved: AssetId | null
}

/** One operation record. */
export interface Op {
  id: OpId
  /** The record this one follows on its branch; empty for a project's first record. */
  parents: OpId[]
  turn: TurnId
  /** The branch the record was appended to. */
  branch: string
  actor: Actor
  surface: Surface
  /** The user's words, or a description of the gesture, that caused the operation. */
  intent: string
  kind: OpKind
  tool?: { name: string; version: string }
  command?: { argv: string[] }
  inputs: OpInput[]
  params: Record<string, unknown>
  outputs: AssetId[]
  status: OpStatus
  /** The operation this one modifies a copy of, such as a regeneration with a changed prompt. */
  base_op?: OpId
  /** Operations whose outputs this one replaces; their consumers become stale. */
  supersedes?: OpId[]
  cost?: { gpu_s?: number; wall_s?: number; cached?: boolean }
  /** Facts the tool reported beyond its outputs: the seed it drew, the probe it read, the answer it received. */
  report?: Record<string, unknown>
  /** Whether identical inputs and params always give identical outputs, which allows caching and replay. */
  deterministic: boolean
  /** ISO-8601 UTC. */
  created_at: string
  finished_at?: string
  error?: string
}

/** The fields a caller supplies; the log assigns `id` and `created_at`. */
export type OpDraft = Omit<Op, 'id' | 'created_at'>

/** The mutable part of a record after it exists: status, results, and resolved inputs. */
export interface OpPatch {
  status?: OpStatus
  outputs?: AssetId[]
  inputs?: OpInput[]
  finished_at?: string
  error?: string
  cost?: Op['cost']
  report?: Op['report']
}
