/**
 * Types of the Shot render component: the `shot` state slice that groups the takes of each shot.
 *
 * @module @dv/shot-render/types
 */
import type { RecordId } from '@dv/project'

/** The `shot` slice: the takes of each shot, rebuilt from the finished render records of every render mode. */
export interface ShotState {
  /** The root record of each shot → the root and every take that is `based_on` it, directly or through others. */
  takes: Record<RecordId, RecordId[]>
  /** Each take with a `based_on` → its root record; the reducer's index for `takes`. */
  roots: Record<RecordId, RecordId>
}

declare module '@dv/project' {
  interface ComponentStates {
    /** The takes of each shot (Shot render). */
    shot: ShotState
  }
}
