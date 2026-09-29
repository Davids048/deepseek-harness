/**
 * Shared setup for user-action specs: the four user-action plugins mounted on the project service with fakes,
 * `project_init_v1` payloads, and builders for the exact browser events and log entries a round produces.
 */

import { Buffer } from 'node:buffer'
import { hostname } from 'node:os'
import { expect } from 'vitest'
import type { Plugin } from '@deepseek-ai/cordis'
import type { BrowserEvent } from '../../project/tests/fakes.ts'
import { openProjects, type FakeServices, type ProjectRun, type ProjectsHarness } from '../../project/tests/harness.ts'
import * as ContinueVideo from '../src/continue-video.ts'
import * as GenerateSingleClip from '../src/generate-single-clip.ts'
import * as GenerateVideoSequence from '../src/generate-video-sequence.ts'
import * as RewriteVideoSequence from '../src/rewrite-video-sequence.ts'

export const userActionPlugins: Plugin[] = [GenerateVideoSequence, GenerateSingleClip, ContinueVideo, RewriteVideoSequence]

/**
 * Mount the project service and every user-action plugin.
 * @param services - the generation backend, asset library, and prompt enhancer fakes; configure held prompt calls
 *   before starting a project.
 * @returns the harness; call `dispose()` after the spec.
 */
export async function openUserActions(services: FakeServices = {}): Promise<ProjectsHarness> {
  return await openProjects(userActionPlugins, services)
}

/** The `project_init_v1` fields that select the reference-image model. */
export const REF2VA = { model_id: 'h3-ref2va', generation_mode: 'ref2va' }

/**
 * A `project_init_v1` payload like the reference `project_payload`: the preset length, or three seed segments.
 * @param settings - fields that replace or extend the defaults.
 * @returns the payload.
 */
export function projectPayload(settings: Record<string, unknown> = {}): Record<string, unknown> {
  const curated = settings['curated_prompts']
  return {
    type: 'project_init_v1',
    model_id: 'fast-ltx23',
    generation_mode: 't2va',
    aspect_ratio: '16:9',
    resolution: '720p',
    segment_count: Array.isArray(curated) && curated.length > 0 ? curated.length : 3,
    segment_duration_sec: 5,
    enhancement_enabled: false,
    auto_extension_enabled: false,
    ...settings,
  }
}

/**
 * Release each expected segment request in order and wait for the round's idle status.
 * @param run - the running project.
 * @param prompts - the prompt each released request must carry.
 */
export async function finishRound(run: ProjectRun, prompts: string[]): Promise<void> {
  const after = run.socket.entries.length
  for (const prompt of prompts) {
    const call = await run.generation.nextCall()
    expect(call.request.prompt).toBe(prompt)
    call.finish.resolve()
  }
  await run.socket.waitForStatus('idle', after)
}

/**
 * @param status - the round status.
 * @param autoExtensionEnabled - the server-confirmed Auto Extension flag.
 * @returns the `generation_round_status` event.
 */
export function roundStatus(status: string, autoExtensionEnabled = false): BrowserEvent {
  return { type: 'generation_round_status', status, auto_extension_enabled: autoExtensionEnabled }
}

/**
 * The browser entries one successfully streamed segment produces with the fake generation backend.
 * @param segmentIdx - the segment's one-based display position.
 * @param source - the wire source label.
 * @param seedPromptIndex - the segment's sequence index.
 * @param promptId - the instruction's request ID.
 * @returns `ltx2_segment_start`, `media_init`, the chunk, and `media_segment_complete`.
 */
export function segmentEntries(
  segmentIdx: number,
  source: string,
  seedPromptIndex: number | null,
  promptId: string | null,
): (BrowserEvent | Buffer)[] {
  return [
    { type: 'ltx2_segment_start', segment_idx: segmentIdx, source, seed_prompt_index: seedPromptIndex, prompt_id: promptId },
    { type: 'media_init', segment_idx: segmentIdx, mime: 'video/mp4', stream_id: `stream-${segmentIdx}` },
    Buffer.from('segment!'),
    { type: 'media_segment_complete', segment_idx: segmentIdx, stream_id: `stream-${segmentIdx}` },
  ]
}

/**
 * @param originPromptId - the instruction's request ID, or null.
 * @param originPrompt - the instruction text.
 * @param prompts - the prompt window.
 * @param continuation - whether the plan appends.
 * @returns the `ltx2_stream_start` event.
 */
export function streamStart(originPromptId: string | null, originPrompt: string, prompts: string[], continuation = false): BrowserEvent {
  return {
    type: 'ltx2_stream_start', origin_prompt_id: originPromptId, origin_prompt: originPrompt,
    prompt_window_prompts: prompts, continuation,
  }
}

/**
 * The expected project log entry, without its timestamp.
 * @param event - the event name.
 * @param payload - the event fields.
 * @returns the entry with the host name and the harness project ID.
 */
export function logEntry(event: string, payload: Record<string, unknown> = {}): BrowserEvent {
  return { event, hostname: hostname(), project_id: 'project', ...payload }
}

/** The raw rollout text of the fake prompt enhancer for `Scene 1..count`. */
export function rolloutText(count: number): string {
  const scenes = Array.from({ length: count }, (_value, index) => `Scene ${index + 1}`)
  return JSON.stringify({ id: 'test-scenes', label: 'Test scenes', segment_prompts: scenes })
}

/** A version 4 UUID. */
export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
