/**
 * Project covers and card metadata for the entry page and the session switcher: the first rendered take of a project
 * as its cover, the shot count of its plans, and the time of its last record, all read from the project's state.
 *
 * @module @dv/ui-shell/cover
 */
import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { assetUrl } from '@dv/ui-kit/api.ts'
import type { PickText } from '@dv/ui-kit/locale.ts'
import type { WireState } from '@dv/ui-kit/types.ts'
import { shellClient } from './store.ts'
import css from './shell.module.css'

/**
 * The media a project card shows as its cover: the first frame of the take's video, else the take's image. A render's
 * image output is the take's last frame, kept for the next shot to continue from, so the video comes first. A project
 * without a rendered take shows its first imported image.
 */
export interface ProjectCover {
  image: string | null
  video: string | null
}

/** What a project card shows besides the title. */
export interface ProjectSummary {
  cover: ProjectCover | null
  /** Whether the cover is a rendered take; false for an imported image or no cover. */
  rendered: boolean
  /** Shots in the latest version of every plan. */
  shots: number
  /** Total duration of those shots in seconds; 0 when no shot states one. */
  durationSec: number
  /** When the last record of the branch was written, ISO-8601. */
  editedAt: string | null
}

/**
 * Summarize one branch state of a project.
 * @param state - the branch state.
 * @returns the cover (the outputs of the first successful `shot.render_*` record with a video or image output, else
 *   the first imported image), the shot count and total duration, and the last edit time.
 */
export function summarizeProject(state: WireState): ProjectSummary {
  const mime = new Map(state.assets.map(asset => [asset.id, asset.mime]))
  const records = state.components.proj.records
  let cover: ProjectCover | null = null
  let rendered = false
  for (const record of records) {
    if (record.status !== 'done' || (record.operation !== 'shot.render_ref2va' && record.operation !== 'shot.render_t2va')) continue
    const image = record.outputs.find(id => mime.get(id)?.startsWith('image/') === true) ?? null
    const video = record.outputs.find(id => mime.get(id)?.startsWith('video/') === true) ?? null
    if (image === null && video === null) continue
    cover = { image, video }
    rendered = true
    break
  }
  if (cover === null) {
    const imported = records.find(record => record.status === 'done' && record.operation === 'asset.import'
      && record.outputs.some(id => mime.get(id)?.startsWith('image/') === true))
    const image = imported?.outputs.find(id => mime.get(id)?.startsWith('image/') === true)
    if (image !== undefined) cover = { image, video: null }
  }
  const latest = Object.values(state.components.plan.plans).map(versions => versions.at(-1)?.shots ?? [])
  const shots = latest.reduce((sum, list) => sum + list.length, 0)
  const durationSec = latest.flat().reduce((sum, shot) => sum + (shot.duration_sec ?? 0), 0)
  const last = records.at(-1)
  return { cover, rendered, shots, durationSec, editedAt: last === undefined ? null : last.finished_at ?? last.created_at }
}

/**
 * Read a project's summary once: from `main` when it has a rendered take, else from an open draft branch, because the
 * plans and takes of a chat session stay on its draft until they are accepted and a draft state includes `main`.
 * @param projectId - the project.
 * @returns the summary, or null while it loads or when the read failed.
 */
export function useProjectSummary(projectId: string): ProjectSummary | null {
  const [summary, setSummary] = useState<ProjectSummary | null>(null)
  useEffect(() => {
    const abort = new AbortController()
    const read = async (): Promise<ProjectSummary> => {
      const main = await shellClient.getState(projectId, 'main', abort.signal)
      const fromMain = summarizeProject(main)
      const draft = main.branches.find(branch => branch.counts !== null)
      if (fromMain.rendered || draft === undefined) return fromMain
      return summarizeProject(await shellClient.getState(projectId, draft.name, abort.signal))
    }
    read().then(setSummary, (error: unknown) => {
      if (!abort.signal.aborted) console.warn('ui-shell: project summary read failed', error)
    })
    return () => { abort.abort() }
  }, [projectId])
  return summary
}

/**
 * A decorative cover frame beside the project title: the first frame of the take's muted video, or the take's image,
 * or a neutral block without a take.
 * @param props - the cover, the class of the frame box, and overlays drawn on the frame.
 * @returns the frame.
 */
export function CoverFrame(
  { cover, className, children }: { cover: ProjectCover | null; className: string | undefined; children?: ReactNode },
): ReactNode {
  return (
    <span className={className} aria-hidden="true">
      {cover?.video != null && (
        // `#t=0.1` asks the browser to decode a frame past the first keyframe's black lead-in.
        <video className={css.coverMedia} src={`${assetUrl(cover.video)}#t=0.1`} muted playsInline preload="metadata" />
      )}
      {cover?.video == null && cover?.image != null && <img className={css.coverMedia} src={assetUrl(cover.image)} alt="" />}
      {children}
    </span>
  )
}

/**
 * Describe when a project was last edited: today's time, 昨天 / Yesterday, or the date.
 * @param iso - the ISO-8601 time.
 * @param t - the string picker.
 * @returns the text.
 */
export function editedText(iso: string, t: PickText): string {
  const at = new Date(iso)
  const today = new Date()
  const days = Math.round((new Date(today.toDateString()).getTime() - new Date(at.toDateString()).getTime()) / 86_400_000)
  const time = at.toLocaleTimeString(t('zh-CN', 'en-US'), { hour: '2-digit', minute: '2-digit', hour12: false })
  if (days === 0) return t(`今天 ${time}`, `Today ${time}`)
  if (days === 1) return t('昨天', 'Yesterday')
  return at.toLocaleDateString(t('zh-CN', 'en-US'), { month: 'short', day: 'numeric' })
}
