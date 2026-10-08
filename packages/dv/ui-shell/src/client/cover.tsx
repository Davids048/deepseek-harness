/**
 * Project covers and card metadata for the entry page and the session switcher: the cover, the shot count and total
 * duration, and the last edit time that `GET /api/dv/projects/summary` computes from each project's records.
 *
 * @module @dv/ui-shell/cover
 */
import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { assetUrl } from '@dv/ui-kit/api.ts'
import type { PickText } from '@dv/ui-kit/locale.ts'
import type { WireProjectCover, WireProjectSummary } from '@dv/ui-kit/types.ts'
import { shellClient } from './store.ts'
import css from './shell.module.css'

/**
 * Read project card summaries in one request when the component mounts and again whenever `refresh` changes, keeping
 * the last summaries while a read is in flight or after it failed.
 * @param project - the one project to summarize, or null for every project.
 * @param refresh - a value whose change asks for a fresh read, such as the listed project IDs or a refetched state.
 * @returns the summaries by project ID, or null until the first read succeeds.
 */
export function useProjectSummaries(project: string | null, refresh: unknown): ReadonlyMap<string, WireProjectSummary> | null {
  const [summaries, setSummaries] = useState<ReadonlyMap<string, WireProjectSummary> | null>(null)
  useEffect(() => {
    const abort = new AbortController()
    shellClient.listProjectSummaries(abort.signal, project).then((list) => {
      if (!abort.signal.aborted) setSummaries(new Map(list.map(summary => [summary.project, summary])))
    }, (error: unknown) => {
      if (!abort.signal.aborted) console.warn('ui-shell: project summaries read failed', error)
    })
    return () => { abort.abort() }
  }, [project, refresh])
  return summaries
}

/**
 * A decorative cover frame beside the project title: the first frame of the take's muted video, or the take's image,
 * or a neutral block without a take.
 * @param props - the cover, the class of the frame box, and overlays drawn on the frame.
 * @returns the frame.
 */
export function CoverFrame(
  { cover, className, children }: { cover: WireProjectCover | null; className: string | undefined; children?: ReactNode },
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
