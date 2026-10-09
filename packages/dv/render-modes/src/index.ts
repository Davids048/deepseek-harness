/**
 * Service Definitions of the DreamVerse render mode seams. A render mode is how a shot is rendered from its inputs, and
 * each render mode is its own capability seam: `dvRef2va` (renderers of a prompt and reference images, optionally a first
 * frame) and `dvT2va` (renderers of a prompt only). Each service is a registry of named renderers: a provider plugin
 * registers one `Ref2vaRenderer` or `T2vaRenderer` under its backend name, and any number of providers can register into
 * the same render mode. Shot render consumes each registry through its operation `shot.render_<mode>`, registered only
 * while the registry holds at least one renderer. Every renderer returns one video with audio and its last frame as a
 * `RenderStreamEvent` stream.
 *
 * Mount this plugin once; it provides both registries.
 *
 * @module @dv/render-modes
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { RenderModelFacts, RenderStreamEvent, Ref2vaRequest, T2vaRequest } from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The `ref2va` render mode: the renderers of a shot from a prompt and reference images, by backend name. */
    dvRef2va: Ref2vaRegistry
    /** The `t2va` render mode: the renderers of a shot from a prompt only, by backend name. */
    dvT2va: T2vaRegistry
  }
}

/**
 * One `ref2va` renderer: a prompt, 1 to `maxReferenceImages` reference images, and an optional first frame.
 *
 * Renderers must honor these semantics:
 * - `model()` resolves with the facts of the model the backend serves; `maxReferenceImages` is at least 1 and
 *   `imageLabels` names every request image, the reference images first, then the first frame.
 * - `render()` sends the images in that order, yields exactly one `last_frame`, one `video_start`, the `chunk` events,
 *   then `done`, and rejects for any backend failure. Aborting `signal` cancels the render and rejects with its reason.
 */
export interface Ref2vaRenderer {
  /**
   * Read the facts of the served model.
   * @returns the model facts.
   * @throws Error when the backend cannot be reached.
   */
  model(): Promise<RenderModelFacts>
  /**
   * Read whether the backend serves renders.
   * @returns `ready`, and `detail`: why the backend is not ready, or null when it is.
   */
  ready(): Promise<{ ready: boolean; detail: string | null }>
  /**
   * Render one shot.
   * @param request - the prompt, images, frame size, frame count, and seed.
   * @param signal - cancels the render.
   * @returns the render stream.
   */
  render(request: Ref2vaRequest, signal?: AbortSignal): AsyncIterable<RenderStreamEvent>
}

/**
 * One `t2va` renderer: a prompt only.
 *
 * Renderers must honor these semantics: `model()` resolves with the facts of the served model, with
 * `maxReferenceImages` 0 and no `imageLabels`; `render()` yields exactly one `last_frame`, one `video_start`, the
 * `chunk` events, then `done`, and rejects for any backend failure. Aborting `signal` cancels the render and rejects
 * with its reason.
 */
export interface T2vaRenderer {
  /**
   * Read the facts of the served model.
   * @returns the model facts.
   * @throws Error when the backend cannot be reached.
   */
  model(): Promise<RenderModelFacts>
  /**
   * Read whether the backend serves renders.
   * @returns `ready`, and `detail`: why the backend is not ready, or null when it is.
   */
  ready(): Promise<{ ready: boolean; detail: string | null }>
  /**
   * Render one shot.
   * @param request - the prompt, frame size, frame count, and seed.
   * @param signal - cancels the render.
   * @returns the render stream.
   */
  render(request: T2vaRequest, signal?: AbortSignal): AsyncIterable<RenderStreamEvent>
}

/**
 * The registry of one render mode: renderers by backend name, in registration order. A provider registers inside
 * `ctx.effect`, so disposing the provider removes its renderer; listeners of `onChanged` hear every registration and
 * removal.
 */
export abstract class RendererRegistry<R> extends Service {
  private readonly renderers = new Map<string, R>()
  private readonly listeners = new Set<() => void>()

  /**
   * Register a renderer under its backend name.
   * @param backend - the backend name; unique within this render mode.
   * @param renderer - the renderer.
   * @returns a function that removes the renderer.
   * @throws Error when a renderer is already registered under `backend`.
   */
  register(backend: string, renderer: R): () => void {
    if (this.renderers.has(backend)) throw new Error(`${this.name}: backend "${backend}" is already registered.`)
    this.renderers.set(backend, renderer)
    this.notify()
    return () => {
      if (this.renderers.get(backend) !== renderer) return
      this.renderers.delete(backend)
      this.notify()
    }
  }

  /**
   * Read one renderer.
   * @param backend - the backend name.
   * @returns the renderer, or undefined when no renderer is registered under `backend`.
   */
  get(backend: string): R | undefined {
    return this.renderers.get(backend)
  }

  /** @returns the registered backend names, in registration order. */
  backends(): string[] {
    return [...this.renderers.keys()]
  }

  /**
   * Listen to registrations and removals.
   * @param listener - called after each change.
   * @returns a function that removes the listener.
   */
  onChanged(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}

/** The `ref2va` render mode registry (`ctx.dvRef2va`). */
export class Ref2vaRegistry extends RendererRegistry<Ref2vaRenderer> {
  constructor(ctx: Context) {
    super(ctx, 'dvRef2va')
  }
}

/** The `t2va` render mode registry (`ctx.dvT2va`). */
export class T2vaRegistry extends RendererRegistry<T2vaRenderer> {
  constructor(ctx: Context) {
    super(ctx, 'dvT2va')
  }
}

/** Plugin name. */
export const name = 'dv-render-modes'

/**
 * Provide the `dvRef2va` and `dvT2va` registries.
 * @param ctx - the plugin context.
 */
export function apply(ctx: Context): void {
  ctx.plugin(Ref2vaRegistry)
  ctx.plugin(T2vaRegistry)
}
