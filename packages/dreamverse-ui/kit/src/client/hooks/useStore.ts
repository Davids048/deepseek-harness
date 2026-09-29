import { useSyncExternalStore } from 'react'

import type { ManagedStore } from '@dreamverse/project-controller/client/stores/createManagedStore.ts'

export function useStore<T>(
  store: ManagedStore<T>,
): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get)
}
