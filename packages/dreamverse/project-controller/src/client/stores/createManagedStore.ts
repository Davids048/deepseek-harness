type Subscriber<T> = (state: T) => void

/** A subscribable state container; every write notifies subscribers with the derived state. */
export interface ManagedStore<T> {
  subscribe: (callback: Subscriber<T>) => () => void
  get: () => T
  set: (nextState: T) => T
  update: (updater: (state: T) => T) => T
  patch: (partial: Partial<T> | ((state: T) => Partial<T>)) => T
}

/**
 * Create a store whose state passes through `deriveState` on every write.
 * @param initialState - the state before any write.
 * @param deriveState - recomputes derived fields from a written state.
 * @returns the store.
 */
export function createManagedStore<T extends object>(
  initialState: T,
  deriveState: (state: T) => T = state => state,
): ManagedStore<T> {
  let currentState = deriveState(initialState)
  const subscribers = new Set<Subscriber<T>>()

  function notify() {
    subscribers.forEach((cb) => { cb(currentState) })
  }

  function set(nextState: T): T {
    currentState = deriveState(nextState)
    notify()
    return currentState
  }

  function update(updater: (state: T) => T): T {
    return set(updater(currentState))
  }

  function patch(partial: Partial<T> | ((state: T) => Partial<T>)): T {
    return update(state => ({
      ...state,
      ...(typeof partial === 'function' ? partial(state) : partial),
    }))
  }

  return {
    subscribe(callback: Subscriber<T>) {
      subscribers.add(callback)
      return () => {
        subscribers.delete(callback)
      }
    },
    get: () => currentState,
    set,
    update,
    patch,
  }
}
