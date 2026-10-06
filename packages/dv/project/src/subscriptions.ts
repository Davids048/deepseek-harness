/**
 * Subscriptions: per-project listeners for record appends, record updates and branch changes. The record store calls
 * {@link Subscriptions.emit} after each change is on disk; the live stream (`/dv/events`) and the stream service
 * subscribe through `dvProject.subscribe`.
 *
 * @module @dv/project/subscriptions
 */
import type { ProjectEvent, ProjectId } from './types.ts'

/** One subscription; an object per call, so the same listener subscribed twice is removed once per remover. */
interface Subscription {
  listener: (event: ProjectEvent) => void
}

/** Listener sets, one per project. */
export class Subscriptions {
  private readonly listeners = new Map<ProjectId, Subscription[]>()

  /**
   * Add a listener for one project's changes.
   * @param project - the project; it need not have any listener yet.
   * @param listener - called synchronously, in subscription order, after each change.
   * @returns a function that removes the listener; calling it twice is harmless.
   */
  subscribe(project: ProjectId, listener: (event: ProjectEvent) => void): () => void {
    const subscription: Subscription = { listener }
    this.listeners.set(project, [...(this.listeners.get(project) ?? []), subscription])
    return () => {
      const remaining = (this.listeners.get(project) ?? []).filter(entry => entry !== subscription)
      if (remaining.length === 0) this.listeners.delete(project)
      else this.listeners.set(project, remaining)
    }
  }

  /**
   * Deliver one change to every listener of its project. A listener that throws does not stop delivery to the others;
   * its error is passed to `onListenerError`.
   * @param project - the project that changed.
   * @param event - the change.
   */
  emit(project: ProjectId, event: ProjectEvent): void {
    // The array is replaced on every change, so this loop walks the listeners subscribed when delivery started.
    for (const subscription of this.listeners.get(project) ?? []) {
      try {
        subscription.listener(event)
      } catch (error) {
        this.onListenerError(error)
      }
    }
  }

  /**
   * Where listener errors go; the service sets it to its logger.
   * @param error - what a listener threw.
   */
  onListenerError: (error: unknown) => void = () => undefined
}
