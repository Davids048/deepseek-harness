/**
 * The scheduler: scheduled runs (a run request with `after`) wait here until the records they depend on are done,
 * then run through the runner's `execute` under one concurrency limit per resource class.
 *
 * A queued record depends on every record in its `after` list and on the record of every `{record, output}` input,
 * except the inputs of the operation's `pendingInputRoles`, whose producers it neither waits for nor fails with.
 * Rules:
 * - When every dependency is `done`, the record is ready. Ready records start in enqueue order (first in, first out
 *   across all projects) while their resource class has room: at most `gpu` running `gpu` records, at most `cpu`
 *   running `cpu` records; `none` records are not limited.
 * - When a dependency ends `failed` or `cancelled`, the queued record is updated to `failed` with
 *   `error {code: 'input_failed', message}` naming the dependency, and leaves the queue without running.
 * - Readiness is checked again whenever a record of the project finishes (the service calls `recordFinished`) and
 *   whenever a scheduled run ends.
 *
 * Calls: reads record status through the record store and writes the `input_failed` update under the project lock;
 * runs ready records through the `execute` callback (the runner's `execute`). Called by the runner (`enqueue`, `cancel`) and by
 * the service (`wait`, `recordFinished`, `dispose`).
 *
 * @module @dv/project/scheduler
 */
import type { RecordStore } from './record-store.ts'
import type { OperationSpec, ProjectId, ProjectRecord, RecordId, RecordStatus } from './types.ts'

/** The concurrency limits of the `cpu` and `gpu` resource classes. */
export interface SchedulerLimits {
  cpu: number
  gpu: number
}

/** One scheduled record, from `enqueue` until its final update is written. */
interface ScheduledRecord {
  project: ProjectId
  record: RecordId
  resource: OperationSpec['resource']
  after: RecordId[]
  /** The operation's `pendingInputRoles`: inputs of these roles are not dependencies. */
  pendingInputRoles: readonly string[]
}

/** Whether a queued record can start, must wait, or can never run because a dependency did not finish `done`. */
type Readiness = { kind: 'ready' } | { kind: 'waiting' } | { kind: 'input_failed'; message: string }

/** The statuses that end a record. */
const FINISHED: ReadonlySet<RecordStatus> = new Set(['done', 'failed', 'cancelled'])

/** Queued and running scheduled records of every project. */
export class Scheduler {
  /** Records waiting to start, in enqueue order. */
  private readonly queue: ScheduledRecord[] = []
  /** Records that left the queue and whose final update is not written yet (running, or being failed). */
  private readonly active = new Set<ScheduledRecord>()
  /** Running records per limited resource class. */
  private readonly running = { cpu: 0, gpu: 0 }
  /** Pending `wait` calls; each returns true once it resolved and can be dropped. */
  private readonly waiters = new Set<() => boolean>()
  private disposed = false
  private pumping = false
  private pumpAgain = false

  /**
   * @param store - the record store.
   * @param execute - runs one pending record to its final status; it never rejects for the operation's own failure.
   * @param limits - the concurrency limits.
   */
  constructor(
    private readonly store: RecordStore,
    private readonly execute: (project: ProjectId, record: RecordId) => Promise<ProjectRecord>,
    private readonly limits: SchedulerLimits,
  ) {}

  /**
   * Queue a pending record and start every ready record that has room.
   * @param project - the project.
   * @param record - a `pending` record the runner just wrote.
   * @param resource - the operation's resource class.
   * @param after - records that must be done first, besides the records of its `{record, output}` inputs.
   * @param pendingInputRoles - the operation's `pendingInputRoles`; the records of those inputs are not waited for.
   */
  enqueue(
    project: ProjectId, record: RecordId, resource: OperationSpec['resource'], after: RecordId[], pendingInputRoles: readonly string[] = [],
  ): void {
    this.queue.push({ project, record, resource, after, pendingInputRoles })
    this.pump()
  }

  /**
   * Re-check readiness after a record of the project finished (status `done`, `failed` or `cancelled`).
   * @param project - the project.
   */
  recordFinished(project: ProjectId): void {
    void project
    this.pump()
  }

  /**
   * Wait for records to finish.
   * @param project - the project.
   * @param records - records to wait for (any record, scheduled or not); omitted means every record the scheduler
   *   holds for the project, queued or running, including records enqueued while waiting.
   * @returns a promise that settles when they all have status `done`, `failed` or `cancelled`. It never rejects for a
   *   record's failure; an unknown record rejects with `unknown_record`.
   */
  wait(project: ProjectId, records?: RecordId[]): Promise<void> {
    let settled: () => boolean
    if (records === undefined) {
      settled = () => !this.holds(project)
    } else {
      try {
        for (const record of records) this.store.getRecord(project, record)
      } catch (error: unknown) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)))
      }
      settled = () => records.every(record => FINISHED.has(this.store.getRecord(project, record).status))
    }
    if (settled()) return Promise.resolve()
    return new Promise((resolve) => {
      this.waiters.add(() => {
        if (!settled()) return false
        resolve()
        return true
      })
    })
  }

  /**
   * Take a queued record that has not started out of the queue; the caller ends it. Waiters and the records that
   * depend on it re-check after the caller's update.
   * @param project - the project.
   * @param record - a record.
   * @returns whether the record was queued.
   */
  cancel(project: ProjectId, record: RecordId): boolean {
    const index = this.queue.findIndex(item => item.project === project && item.record === record)
    if (index < 0) return false
    this.queue.splice(index, 1)
    void Promise.resolve().then(() => { this.pump() })
    return true
  }

  /** Stop starting queued records; records already running finish. Queued records stay `pending` on disk. */
  dispose(): void {
    this.disposed = true
  }

  /**
   * Walk the queue once, front to back: start each ready record whose resource class has room, fail each record with a
   * failed dependency, and leave the others in place. A call made while a walk runs (a record that finished during it)
   * makes the walk repeat. Then let every waiter re-check.
   */
  private pump(): void {
    if (this.pumping) {
      this.pumpAgain = true
      return
    }
    this.pumping = true
    try {
      do {
        this.pumpAgain = false
        if (this.disposed) break
        for (const item of [...this.queue]) {
          const readiness = this.readiness(item)
          if (readiness.kind === 'waiting') continue
          if (readiness.kind === 'ready' && item.resource !== 'none' && this.running[item.resource] >= this.limits[item.resource]) continue
          this.queue.splice(this.queue.indexOf(item), 1)
          this.active.add(item)
          if (readiness.kind === 'ready') this.start(item)
          else this.failInput(item, readiness.message)
        }
      } while (this.pumpAgain)
    } finally {
      this.pumping = false
    }
    for (const waiter of [...this.waiters]) {
      if (waiter()) this.waiters.delete(waiter)
    }
  }

  /**
   * @param item - a queued record.
   * @returns whether its dependencies are all done, one did not finish `done`, or some are still unfinished.
   */
  private readiness(item: ScheduledRecord): Readiness {
    const record = this.store.getRecord(item.project, item.record)
    const producers = record.inputs.flatMap(input => (
      'record' in input.ref && !item.pendingInputRoles.includes(input.role) ? [input.ref.record] : []))
    let waiting = false
    for (const dependency of [...item.after, ...producers]) {
      const { status, error } = this.store.getRecord(item.project, dependency)
      if (status === 'failed' || status === 'cancelled') {
        const reason = error === undefined ? '' : `: ${error.message}`
        return { kind: 'input_failed', message: `Record ${dependency}, which this call waits for, ended ${status}${reason}` }
      }
      if (status !== 'done') waiting = true
    }
    return waiting ? { kind: 'waiting' } : { kind: 'ready' }
  }

  /**
   * Run a ready record through the runner and release its share of the resource class capacity when it ends.
   * @param item - a record that left the queue.
   */
  private start(item: ScheduledRecord): void {
    const { resource } = item
    if (resource !== 'none') this.running[resource] += 1
    // Start after the current walk, so that the runner's first steps never run inside it.
    void Promise.resolve().then(() => this.execute(item.project, item.record)).then(() => undefined, (error: unknown) => {
      // The runner ends the record itself; a rejection means it could not write the final update (for example, the
      // project was deleted meanwhile). The capacity is released all the same.
      void error
    }).finally(() => {
      if (resource !== 'none') this.running[resource] -= 1
      this.active.delete(item)
      this.pump()
    })
  }

  /**
   * End a queued record whose dependency failed, under the project lock, without running it.
   * @param item - a record that left the queue.
   * @param message - the failure message naming the dependency.
   */
  private failInput(item: ScheduledRecord, message: string): void {
    void this.store.lock(item.project, () => this.store.update(item.project, {
      update: item.record, status: 'failed', finished_at: new Date().toISOString(), error: { code: 'input_failed', message },
    })).then(() => undefined, (error: unknown) => {
      // The record could not be updated (for example, the project was deleted meanwhile); it leaves the scheduler.
      void error
    }).finally(() => {
      this.active.delete(item)
      this.pump()
    })
  }

  /**
   * @param project - the project.
   * @returns whether the scheduler holds a queued or unfinished record of the project.
   */
  private holds(project: ProjectId): boolean {
    return this.queue.some(item => item.project === project) || [...this.active].some(item => item.project === project)
  }
}
