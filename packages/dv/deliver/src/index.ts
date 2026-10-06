/**
 * The Deliver component of DreamVerse as the `dvDeliver` Cordis service: it exports a timeline to one video file. It
 * owns one operation, `deliver.timeline_export`: it reads the timeline's clips from the `timeline` slice of the project
 * state, trims each clip that has an in or out point with `dvFfmpeg`, joins all clips in playback order, and imports
 * the joined video into the asset pool as the record's output.
 *
 * `dvProject` turns the operation into the agent tool `dv_deliver_timeline_export`. The component has no reducer: an
 * export changes no project state besides the asset it creates.
 *
 * @module @dv/deliver
 */
import { join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@dv/asset-pool'
import { FfmpegError } from '@dv/ffmpeg'
import type { OperationResult, OperationSpec } from '@dv/project'
import type { Clip, Timeline } from '@dv/timeline'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The Deliver component: exports a timeline to one video file. */
    dvDeliver: DvDeliver
  }
}

/** `dvDeliver` plugin configuration; the component has no deployment-varying values. */
export type Config = Record<string, unknown>

/** Loader validation. */
export const Config: z<Config> = z.object({})

/** The ffmpeg video encoder arguments of every re-encoded file: H.264 in yuv420p. */
const ENCODE_ARGS = ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p'] as const

/** The Deliver service: the export operation and the method it runs. */
export default class DvDeliver extends Service {
  static inject = ['dvProject', 'dvAssetPool', 'dvFfmpeg']
  static Config = Config

  constructor(ctx: Context) {
    super(ctx, 'dvDeliver')
    ctx.effect(() => ctx.dvProject.registerOperation(this.exportOperation()), 'dvDeliver deliver.timeline_export')
  }

  /**
   * Export a timeline to one MP4 file: trim each clip with an in or out point to that range, then join all clips in
   * playback order.
   * @param timeline - the timeline with at least one clip.
   * @param dir - an existing directory for the trimmed clips and the joined file, usually the operation's `scratchDir`.
   * @returns the path of the joined file inside `dir`.
   * @throws Error for a timeline without clips; FfmpegError when ffmpeg cannot trim or join the clips.
   */
  async exportTimeline(timeline: Timeline, dir: string): Promise<string> {
    if (timeline.clips.length === 0) throw new Error(`Timeline ${timeline.id} has no clips to export.`)
    const paths: string[] = []
    for (const [index, clip] of timeline.clips.entries()) paths.push(await this.clipFile(clip, index, dir))
    return await this.join(paths, dir)
  }

  /**
   * The file of one clip: the asset's own file for a clip that plays the whole asset, else the clip's range trimmed
   * into a new file. Re-encoding makes the trim frame-accurate.
   * @param clip - the clip.
   * @param index - the clip's index in the timeline, which names the trimmed file.
   * @param dir - the directory for the trimmed file.
   * @returns the file path.
   */
  private async clipFile(clip: Clip, index: number, dir: string): Promise<string> {
    const path = this.ctx.dvAssetPool.path(clip.asset)
    if (clip.in_sec === null && clip.out_sec === null) return path
    const name = `clip-${index + 1}.mp4`
    const end = clip.out_sec === null ? [] : ['-to', String(clip.out_sec)]
    // The seek comes after `-i` so the decoder reads the frames before the trim and the trim lands on the exact frame.
    await this.ctx.dvFfmpeg.run({
      argv: [
        'ffmpeg', '-y', '-loglevel', 'error', '-i', '{{in:0}}', '-ss', String(clip.in_sec ?? 0), ...end, ...ENCODE_ARGS, '-c:a', 'aac',
        '-movflags', '+faststart', `{{out:${name}}}`,
      ],
      inputs: [path], outputs: [name], dir,
    })
    return join(dir, name)
  }

  /**
   * Join clip files in order. Stream copy through the concat demuxer comes first; when the files disagree on codec or
   * geometry it fails, and the concat filter re-encodes the video of every file at the first file's frame size.
   * @param paths - the clip files, in playback order.
   * @param dir - the directory for the joined file.
   * @returns the path of the joined file.
   */
  private async join(paths: readonly string[], dir: string): Promise<string> {
    const ffmpeg = this.ctx.dvFfmpeg
    try {
      await ffmpeg.run({
        argv: ['ffmpeg', '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c', 'copy', '-movflags', '+faststart', '{{out:timeline.mp4}}'],
        inputs: paths, outputs: ['timeline.mp4'], dir,
        files: [{ name: 'list.txt', content: paths.map((_path, index) => `file '{{in:${index}}}'`).join('\n') }],
      })
      return join(dir, 'timeline.mp4')
    } catch (error: unknown) {
      if (!(error instanceof FfmpegError)) throw error
    }
    const lead = await ffmpeg.probe(paths[0] ?? '')
    if (lead.width === null || lead.height === null) throw new Error('The first clip has no video frame size to join the clips at.')
    const { width, height } = lead
    // Every clip is scaled and padded to the first clip's frame size, which the concat filter requires.
    const scaled = paths.map((_path, index) =>
      `[${index}:v:0]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1[v${index}]`)
    const filter = `${scaled.join(';')};${paths.map((_path, index) => `[v${index}]`).join('')}concat=n=${paths.length}:v=1:a=0[v]`
    await ffmpeg.run({
      argv: [
        'ffmpeg', '-y', '-loglevel', 'error', ...paths.flatMap((_path, index) => ['-i', `{{in:${index}}}`]), '-filter_complex', filter,
        '-map', '[v]', ...ENCODE_ARGS, '-movflags', '+faststart', '{{out:timeline.mp4}}',
      ],
      inputs: paths, outputs: ['timeline.mp4'], dir,
    })
    return join(dir, 'timeline.mp4')
  }

  /** The `deliver.timeline_export` operation. */
  private exportOperation(): OperationSpec {
    return {
      name: 'deliver.timeline_export',
      component: 'deliver',
      version: '1',
      description: 'Export a timeline to one video: each clip with an in or out point is trimmed to that range, and all clips are '
        + 'joined in timeline order.',
      inputs: {},
      params: { timeline: { type: 'string', description: 'The ID of the timeline to export, such as `t1`; default: the first timeline.' } },
      outputs: [{ role: 'video', type: 'video' }],
      // The output depends on the timeline's clips in the project state, which the params and inputs do not name.
      deterministic: false,
      resource: 'cpu',
      confirm: 'never',
      summarize: record => (typeof record.params['timeline'] === 'string' ? `exported timeline ${record.params['timeline']}` : 'exported the first timeline'),
      execute: async (context): Promise<OperationResult> => {
        const id = context.params['timeline']
        const timelines = context.state.components.timeline.timelines
        const timeline = typeof id === 'string' ? timelines.find(candidate => candidate.id === id) : timelines[0]
        if (timeline === undefined) throw new Error(typeof id === 'string' ? `Unknown timeline "${id}".` : 'The project has no timeline to export.')
        const path = await this.exportTimeline(timeline, context.scratchDir)
        const probe = await this.ctx.dvFfmpeg.probe(path)
        const video = context.importAsset({ path }, {
          mime: 'video/mp4', name: `${timeline.name === '' ? timeline.id : timeline.name}.mp4`,
          ...probe.durationSec === null ? {} : { durationSec: probe.durationSec },
          ...probe.width === null || probe.height === null ? {} : { width: probe.width, height: probe.height },
        })
        return { outputs: [video] }
      },
    }
  }
}
