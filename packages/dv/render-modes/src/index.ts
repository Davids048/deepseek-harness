/**
 * Service Definitions of the DreamVerse render mode seams. A render mode is how a shot is rendered from its inputs, and
 * each render mode is its own capability seam: `dvRef2va` (`Ref2vaRenderer`: a prompt and reference images, optionally a
 * first frame) and `dvT2va` (`T2vaRenderer`: a prompt only). Provider packages subclass one of the classes and load as a
 * plugin; Shot render consumes each service through its operation `shot.render_<mode>`, registered only while the
 * service is mounted. Every render mode returns one video with audio and its last frame as a `RenderStreamEvent` stream.
 *
 * @module @dv/render-modes
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { RenderModelFacts, RenderStreamEvent, Ref2vaRequest, T2vaRequest } from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The `ref2va` render mode: renders a shot from a prompt and reference images. */
    dvRef2va: Ref2vaRenderer
    /** The `t2va` render mode: renders a shot from a prompt only. */
    dvT2va: T2vaRenderer
  }
}

/**
 * The `ref2va` render mode (`ctx.dvRef2va`): a prompt, 1 to `maxReferenceImages` reference images, and an optional first
 * frame. Subclass it and load the subclass as a plugin; one provider per context.
 *
 * Providers must honor these semantics:
 * - `model()` resolves with the facts of the model the backend serves; `maxReferenceImages` is at least 1 and
 *   `imageLabels` names every request image, the reference images first, then the first frame.
 * - `render()` sends the images in that order, yields exactly one `last_frame`, one `video_start`, the `chunk` events,
 *   then `done`, and rejects for any backend failure. Aborting `signal` cancels the render and rejects with its reason.
 */
export abstract class Ref2vaRenderer extends Service {
  constructor(ctx: Context) {
    super(ctx, 'dvRef2va')
  }

  /**
   * Read the facts of the served model.
   * @returns the model facts.
   * @throws Error when the backend cannot be reached.
   */
  abstract model(): Promise<RenderModelFacts>

  /**
   * Read whether the backend serves renders.
   * @returns `ready`, and `detail`: why the backend is not ready, or null when it is.
   */
  abstract ready(): Promise<{ ready: boolean; detail: string | null }>

  /**
   * Render one shot.
   * @param request - the prompt, images, frame size, frame count, and seed.
   * @param signal - cancels the render.
   * @returns the render stream.
   */
  abstract render(request: Ref2vaRequest, signal?: AbortSignal): AsyncIterable<RenderStreamEvent>
}

/**
 * The `t2va` render mode (`ctx.dvT2va`): a prompt only. Subclass it and load the subclass as a plugin; one provider per
 * context.
 *
 * Providers must honor these semantics: `model()` resolves with the facts of the served model, with
 * `maxReferenceImages` 0 and no `imageLabels`; `render()` yields exactly one `last_frame`, one `video_start`, the
 * `chunk` events, then `done`, and rejects for any backend failure. Aborting `signal` cancels the render and rejects
 * with its reason.
 */
export abstract class T2vaRenderer extends Service {
  constructor(ctx: Context) {
    super(ctx, 'dvT2va')
  }

  /**
   * Read the facts of the served model.
   * @returns the model facts.
   * @throws Error when the backend cannot be reached.
   */
  abstract model(): Promise<RenderModelFacts>

  /**
   * Read whether the backend serves renders.
   * @returns `ready`, and `detail`: why the backend is not ready, or null when it is.
   */
  abstract ready(): Promise<{ ready: boolean; detail: string | null }>

  /**
   * Render one shot.
   * @param request - the prompt, frame size, frame count, and seed.
   * @param signal - cancels the render.
   * @returns the render stream.
   */
  abstract render(request: T2vaRequest, signal?: AbortSignal): AsyncIterable<RenderStreamEvent>
}
