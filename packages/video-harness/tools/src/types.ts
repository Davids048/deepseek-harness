/**
 * Types of the structured tools: what a tool declares beyond what the runtime needs to run it, so the agent, the
 * views, and the confirmation policy can read the same declaration.
 *
 * @module @video-harness/tools/types
 */
import type { ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { Op } from '@video-harness/oplog'
import type { RuntimeToolSpec, ToolCost } from '@video-harness/runtime'

/** The kind of artifact an input or output carries. */
export type ArtifactType = 'image' | 'video' | 'audio' | 'text' | 'json' | 'any'

/** One named input of a tool. */
export interface InputSpec {
  type: ArtifactType
  description: string
  required?: boolean
  /** Whether the role accepts several references, such as every reference image of a shot. */
  many?: boolean
  /** Whether the role accepts `entity@version` references in addition to asset IDs. */
  entity?: boolean
}

/** One output of a tool, in the order the tool returns them. */
export interface OutputSpec {
  role: string
  type: ArtifactType
}

/** When the agent must ask before running the tool: never, when the call is costly, or always. */
export type Confirm = 'never' | 'cost' | 'always'

/** A structured tool: a runtime tool plus the declaration the agent and the views read. */
export interface ToolSpec extends RuntimeToolSpec {
  /** The model-facing description. */
  summary: string
  inputs: Record<string, InputSpec>
  /** The JSON schema of `params`, in the DSH tool parameter format; also the canvas form. */
  params: ParameterSchemaSpec
  outputs: OutputSpec[]
  cost: ToolCost
  confirm: Confirm
  /**
   * Whether the call only reads the project and records an answer, such as looking at an image: its record changes
   * nothing the user would accept or discard, so it never keeps an agent draft open.
   */
  readOnly?: boolean
  /**
   * One line for a chat card or a canvas node.
   * @param op - the finished record.
   * @returns the line.
   */
  summarize(op: Op): string
}
