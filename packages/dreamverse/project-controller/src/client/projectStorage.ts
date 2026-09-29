/** Store projects and clips in IndexedDB. Each storage function closes its database connection. */
import type { PromptEvent } from './promptEvents.ts'

const DB_NAME = 'fastvideo-projects'
const DB_VERSION = 1
const PROJECTS_STORE = 'projects'
const CLIPS_STORE = 'clips'

function ensureIdbError(error: unknown, fallbackMessage: string): Error {
  if (error instanceof Error) {
    return error
  }
  if (typeof error === 'string' && error.trim()) {
    return new Error(error.trim())
  }
  if (error && typeof error === 'object') {
    const maybeName =
      'name' in error && typeof error.name === 'string' ? error.name : ''
    const maybeMessage =
      'message' in error && typeof error.message === 'string'
        ? error.message
        : ''
    const combined = [maybeName, maybeMessage]
      .filter(part => part && part.trim())
      .join(': ')
    if (combined) {
      return new Error(combined)
    }
  }
  return new Error(fallbackMessage)
}

/** One saved project's metadata, shown in the project history. */
export interface StoredProject {
  id: string
  label: string
  presetId: string
  originalLabel: string
  createdAt: number
  lastThumbnail: string | null
  promptEvents: PromptEvent[]
}

/** One saved clip of a project, with its playable media. */
export interface StoredClip {
  id: string
  projectId: string
  label: string
  prompt: string
  mime: string
  blob: Blob
  createdAt: number
}

interface PersistedClipRecord {
  id: string
  projectId: string
  label: string
  prompt: string
  mime: string
  createdAt: number
  blob?: Blob
  blobBytes?: ArrayBuffer | ArrayBufferView
}

/** Settle a write operation when its transaction completes, fails, or aborts. */
function settleTransaction(
  tx: IDBTransaction,
  resolve: () => void,
  reject: (error: unknown) => void,
  {
    onTransactionError = 'IndexedDB transaction failed.',
    onTransactionAbort = 'IndexedDB transaction was aborted.',
    getTransactionError,
  }: {
    onTransactionError?: string
    onTransactionAbort?: string
    getTransactionError?: () => unknown
  } = {},
) {
  tx.oncomplete = () => {
    resolve()
  }
  tx.onerror = () => {
    reject(
      ensureIdbError(
        getTransactionError ? getTransactionError() : tx.error,
        onTransactionError,
      ),
    )
  }
  tx.onabort = () => {
    reject(
      ensureIdbError(
        getTransactionError ? getTransactionError() : tx.error,
        onTransactionAbort,
      ),
    )
  }
}

/**
 * Record the first failed request of one transaction, so the transaction's rejection can report that request's error.
 * @returns the request error handler and a reader of the recorded error.
 */
function createRequestErrorTracker(): { trackRequestError: (event: Event) => void; requestError: () => unknown } {
  let recordedError: unknown = null
  return {
    trackRequestError(event: Event) {
      const req = event.target as IDBRequest<unknown> | null
      if (!recordedError && req?.error) {
        recordedError = req.error
      }
    },
    requestError: () => recordedError,
  }
}

function openProjectDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available'))
      return
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(PROJECTS_STORE)) {
        db.createObjectStore(PROJECTS_STORE, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(CLIPS_STORE)) {
        const clipStore = db.createObjectStore(CLIPS_STORE, {
          keyPath: 'id',
        })
        clipStore.createIndex('projectId', 'projectId', {
          unique: false,
        })
      }
    }
    request.onsuccess = () => { resolve(request.result) }
    request.onerror = () => {
      reject(
        ensureIdbError(
          request.error,
          'Failed to open projects IndexedDB.',
        ),
      )
    }
  })
}

function cloneArrayBufferFromView(view: ArrayBufferView): ArrayBuffer {
  return new Uint8Array(
    view.buffer,
    view.byteOffset,
    view.byteLength,
  ).slice().buffer
}

function normalizeBlobBytes(value: unknown): ArrayBuffer | null {
  if (value instanceof ArrayBuffer) {
    return value.slice(0)
  }
  if (ArrayBuffer.isView(value)) {
    return cloneArrayBufferFromView(value)
  }
  return null
}

async function serializeClipForStorage(
  clip: StoredClip,
): Promise<PersistedClipRecord> {
  const mime =
    typeof clip.mime === 'string' && clip.mime.trim()
      ? clip.mime.trim()
      : clip.blob.type || 'application/octet-stream'
  const blobBytes = await clip.blob.arrayBuffer()
  return {
    id: clip.id,
    projectId: clip.projectId,
    label: clip.label,
    prompt: clip.prompt,
    mime,
    createdAt: clip.createdAt,
    blobBytes,
  }
}

function deserializeStoredClip(record: PersistedClipRecord): StoredClip | null {
  const mime =
    typeof record.mime === 'string' && record.mime.trim()
      ? record.mime.trim()
      : 'application/octet-stream'

  if (record.blob instanceof Blob) {
    return {
      id: record.id,
      projectId: record.projectId,
      label: record.label,
      prompt: record.prompt,
      mime,
      blob: record.blob,
      createdAt: record.createdAt,
    }
  }

  const blobBytes = normalizeBlobBytes(record.blobBytes)
  if (!blobBytes) {
    return null
  }

  return {
    id: record.id,
    projectId: record.projectId,
    label: record.label,
    prompt: record.prompt,
    mime,
    blob: new Blob([blobBytes], { type: mime }),
    createdAt: record.createdAt,
  }
}

/** Prepare clip bytes, then save the project and its clips in one transaction. */
export async function saveProject(
  project: StoredProject,
  clips: StoredClip[],
): Promise<void> {
  const persistedClips = await Promise.all(
    clips.map(async (clip) => {
      try {
        return await serializeClipForStorage(clip)
      } catch (error) {
        throw ensureIdbError(
          error,
          `Failed to serialize clip ${clip.id} for storage.`,
        )
      }
    }),
  )

  const db = await openProjectDB()
  try {
    await new Promise<void>((resolve, reject) => {
      const { trackRequestError, requestError } = createRequestErrorTracker()

      const tx = db.transaction([PROJECTS_STORE, CLIPS_STORE], 'readwrite')
      const projectStore = tx.objectStore(PROJECTS_STORE)
      const clipStore = tx.objectStore(CLIPS_STORE)
      const index = clipStore.index('projectId')
      const existingClipKeysRequest = index.getAllKeys(project.id)

      existingClipKeysRequest.onerror = (event) => {
        trackRequestError(event)
        tx.abort()
      }
      existingClipKeysRequest.onsuccess = () => {
        const existingClipKeys = existingClipKeysRequest.result
        for (const key of existingClipKeys) {
          const clipDeleteReq = clipStore.delete(key)
          clipDeleteReq.onerror = trackRequestError
        }

        const projectPutReq = projectStore.put(project)
        projectPutReq.onerror = trackRequestError

        for (const clip of persistedClips) {
          const clipPutReq = clipStore.put(clip)
          clipPutReq.onerror = trackRequestError
        }
      }

      settleTransaction(tx, resolve, reject, {
        onTransactionError: 'Failed to save project in IndexedDB.',
        onTransactionAbort: 'Failed to save project in IndexedDB.',
        getTransactionError: () => tx.error ?? requestError(),
      })
    })
  } finally {
    db.close()
  }
}

/** Save project metadata while retaining its stored clips. */
export async function saveProjectMetadata(
  project: StoredProject,
): Promise<void> {
  const db = await openProjectDB()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(PROJECTS_STORE, 'readwrite')
      tx.objectStore(PROJECTS_STORE).put(project)

      settleTransaction(tx, resolve, reject, {
        onTransactionError:
					'Failed to save project metadata in IndexedDB.',
        onTransactionAbort:
					'Failed to save project metadata in IndexedDB.',
      })
    })
  } finally {
    db.close()
  }
}

/** Read saved projects and return them newest first. */
export async function listProjects(): Promise<StoredProject[]> {
  const db = await openProjectDB()
  try {
    const projects = await new Promise<StoredProject[]>((resolve, reject) => {
      const tx = db.transaction(PROJECTS_STORE, 'readonly')
      const request = tx.objectStore(PROJECTS_STORE).getAll()
      request.onsuccess = () => { resolve(request.result as StoredProject[]) }
      request.onerror = () => {
        reject(
          ensureIdbError(
            request.error,
            'Failed to list saved projects from IndexedDB.',
          ),
        )
      }
    })
    projects.sort((a, b) => b.createdAt - a.createdAt)
    return projects
  } finally {
    db.close()
  }
}

/** Restore a project's clips in creation order. */
export async function loadProjectClips(
  projectId: string,
): Promise<StoredClip[]> {
  const db = await openProjectDB()
  try {
    const records = await new Promise<PersistedClipRecord[]>((resolve, reject) => {
      const tx = db.transaction(CLIPS_STORE, 'readonly')
      const index = tx.objectStore(CLIPS_STORE).index('projectId')
      const request = index.getAll(projectId)
      request.onsuccess = () => { resolve(request.result as PersistedClipRecord[]) }
      request.onerror = () => {
        reject(
          ensureIdbError(
            request.error,
            `Failed to load project clips for ${projectId}.`,
          ),
        )
      }
    })
    const clips = records
      .map(record => deserializeStoredClip(record))
      .filter((clip): clip is StoredClip => Boolean(clip))
    clips.sort((a, b) => a.createdAt - b.createdAt)
    return clips
  } finally {
    db.close()
  }
}

/** Delete a project and its clips in one transaction. */
export async function deleteProject(projectId: string): Promise<void> {
  const db = await openProjectDB()
  try {
    await new Promise<void>((resolve, reject) => {
      const { trackRequestError, requestError } = createRequestErrorTracker()

      const tx = db.transaction([PROJECTS_STORE, CLIPS_STORE], 'readwrite')
      const projectDeleteReq = tx.objectStore(PROJECTS_STORE).delete(projectId)
      projectDeleteReq.onerror = trackRequestError

      const clipStore = tx.objectStore(CLIPS_STORE)
      const index = clipStore.index('projectId')
      const cursorReq = index.openKeyCursor(IDBKeyRange.only(projectId))
      cursorReq.onerror = trackRequestError
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result
        if (cursor) {
          const clipDeleteReq = clipStore.delete(cursor.primaryKey)
          clipDeleteReq.onerror = trackRequestError
          cursor.continue()
        }
      }

      settleTransaction(tx, resolve, reject, {
        onTransactionError:
					`Failed to delete project ${projectId} from IndexedDB.`,
        onTransactionAbort:
					`Failed to delete project ${projectId} from IndexedDB.`,
        getTransactionError: () => tx.error ?? requestError(),
      })
    })
  } finally {
    db.close()
  }
}

export async function pruneOldProjects(maxCount: number): Promise<void> {
  const projects = await listProjects()
  if (projects.length <= maxCount) return
  const toDelete = projects.slice(maxCount)
  for (const project of toDelete) {
    await deleteProject(project.id)
  }
}
