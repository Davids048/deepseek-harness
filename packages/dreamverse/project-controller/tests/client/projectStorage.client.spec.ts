/** @vitest-environment jsdom */
/** Verify storage contents and connection lifetime through controlled IndexedDB events. */
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest'

import {
  deleteProject,
  listProjects,
  loadProjectClips,
  saveProject,
  saveProjectMetadata,
  type StoredClip,
  type StoredProject,
} from '../../src/client/projectStorage.ts'

const project: StoredProject = {
  id: 'project-1',
  label: 'Coast',
  presetId: 'preset-1',
  originalLabel: 'Coast',
  createdAt: 20,
  lastThumbnail: null,
  promptEvents: [{ promptId: 'prompt-1', status: 'submitted', text: 'Waves at sunrise' }],
}

/** IndexedDB request fields that the storage module reads and assigns. */
interface ControlledRequest<T> {
  result: T | undefined
  error: unknown
  onsuccess: ((event: Event) => void) | null
  onerror: ((event: Event) => void) | null
}

/** IndexedDB transaction fields that the storage module reads and assigns. */
interface ControlledTransactionEvents {
  error: unknown
  oncomplete: ((event: Event) => void) | null
  onerror: ((event: Event) => void) | null
  onabort: ((event: Event) => void) | null
}

/** Let each test deliver request results and errors without a storage engine. */
function controlledRequest<T>() {
  const request: ControlledRequest<T> = { result: undefined, error: null, onsuccess: null, onerror: null }
  return {
    request,
    succeed(value: T) {
      request.result = value
      request.onsuccess?.(new Event('success'))
    },
    fail(error: unknown) {
      request.error = error
      const event = new Event('error')
      Object.defineProperty(event, 'target', { value: request })
      request.onerror?.(event)
    },
  }
}

/** Expose only the database operations used by the storage module. */
function controlledDatabase() {
  const projectRead = controlledRequest<unknown[]>()
  const clipRead = controlledRequest<unknown[]>()
  const clipKeys = controlledRequest<IDBValidKey[]>()
  const cursor = controlledRequest<{ primaryKey: string; continue: () => void } | null>()
  const projectWrite = controlledRequest<undefined>()
  const clipWrite = controlledRequest<undefined>()
  const index = {
    getAll: vi.fn((_key: string) => clipRead.request),
    getAllKeys: vi.fn((_key: string) => clipKeys.request),
    openKeyCursor: vi.fn((_key: unknown) => cursor.request),
  }
  const projects = {
    getAll: vi.fn(() => projectRead.request),
    put: vi.fn((_record: StoredProject) => projectWrite.request),
    delete: vi.fn((_key: string) => projectWrite.request),
  }
  const clips = {
    index: vi.fn((_name: string) => index),
    put: vi.fn((_record: unknown) => clipWrite.request),
    delete: vi.fn((_key: IDBValidKey) => clipWrite.request),
  }
  const txEvents: ControlledTransactionEvents = { error: null, oncomplete: null, onerror: null, onabort: null }
  const tx = {
    ...txEvents,
    abort: vi.fn(),
    objectStore: vi.fn((name: string) => name === 'projects' ? projects : clips),
  }
  const started = Promise.withResolvers<undefined>()
  const db = {
    transaction: vi.fn((_stores: string | string[], _mode: IDBTransactionMode) => {
      started.resolve(undefined)
      return tx
    }),
    close: vi.fn(),
  }
  const opening = controlledRequest<typeof db>()
  const open = vi.fn(() => {
    queueMicrotask(() => { opening.succeed(db) })
    return opening.request
  })
  vi.stubGlobal('indexedDB', { open })
  vi.stubGlobal('IDBKeyRange', { only: vi.fn((key: string) => ({ only: key })) })
  return {
    db, tx, open, opening, started: started.promise,
    projects, clips, index, projectRead, clipRead, clipKeys, cursor,
    projectWrite, clipWrite,
  }
}

/** Supply a real Blob with a controllable asynchronous byte read, returned as `readBytes`. */
function makeClip(id: string): { clip: StoredClip; readBytes: Mock<() => Promise<ArrayBuffer>> } {
  const bytes = new Uint8Array([1, 2, 3]).buffer
  const blob = new Blob([bytes], { type: 'video/mp4' })
  const readBytes = vi.fn<() => Promise<ArrayBuffer>>().mockResolvedValue(bytes)
  Object.defineProperty(blob, 'arrayBuffer', {
    value: readBytes,
  })
  const clip = {
    id, projectId: project.id, label: 'Waves', prompt: 'Waves at sunrise',
    mime: 'video/mp4', blob, createdAt: 10,
  }
  return { clip, readBytes }
}

function readBlob(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => { resolve(reader.result as ArrayBuffer) }
    reader.onerror = () => { reject(reader.error ?? new Error('FileReader failed without an error')) }
    reader.readAsArrayBuffer(blob)
  })
}

const writeOperations = [
  { name: 'saveProject', run: () => saveProject(project, []), failure: 'Failed to save project in IndexedDB.' },
  { name: 'saveProjectMetadata', run: () => saveProjectMetadata(project),
    failure: 'Failed to save project metadata in IndexedDB.' },
  { name: 'deleteProject', run: () => deleteProject(project.id),
    failure: 'Failed to delete project project-1 from IndexedDB.' },
]
const readOperations = [
  { name: 'listProjects', run: listProjects, request: 'projectRead' as const },
  { name: 'loadProjectClips', run: () => loadProjectClips(project.id), request: 'clipRead' as const },
]

afterEach(() => { vi.unstubAllGlobals() })

describe('projectStorage connection ownership', () => {
  /** A failed byte read must finish before any database connection is acquired. */
  it('rejects serialization without opening IndexedDB', async () => {
    const fixture = controlledDatabase()
    const { clip, readBytes } = makeClip('clip-1')
    const failure = new Error('Blob bytes are unavailable')
    readBytes.mockRejectedValue(failure)

    await expect(saveProject(project, [clip])).rejects.toBe(failure)
    expect(fixture.open).not.toHaveBeenCalled()
    expect(fixture.db.close).not.toHaveBeenCalled()
  })

  /** Hold both byte reads, then observe replacement contents and transaction settlement. */
  it('prepares all clips before opening and retains the connection until commit', async () => {
    const fixture = controlledDatabase()
    const { clip: first, readBytes: readFirstBytes } = makeClip('clip-1')
    const { clip: second, readBytes: readSecondBytes } = makeClip('clip-2')
    first.mime = ' video/webm '
    second.mime = ''
    const firstBytes = Promise.withResolvers<ArrayBuffer>()
    const secondBytes = Promise.withResolvers<ArrayBuffer>()
    readFirstBytes.mockReturnValue(firstBytes.promise)
    readSecondBytes.mockReturnValue(secondBytes.promise)
    const saving = saveProject(project, [first, second])
    expect(fixture.open).not.toHaveBeenCalled()
    firstBytes.resolve(new Uint8Array([4, 5]).buffer)
    await firstBytes.promise
    expect(fixture.open).not.toHaveBeenCalled()
    secondBytes.resolve(new Uint8Array([6]).buffer)
    await fixture.started

    expect(fixture.open).toHaveBeenCalledExactlyOnceWith('fastvideo-projects', 1)
    expect(fixture.db.transaction).toHaveBeenCalledWith(['projects', 'clips'], 'readwrite')
    expect(fixture.index.getAllKeys).toHaveBeenCalledWith(project.id)
    fixture.clipKeys.succeed(['replaced-clip'])
    expect(fixture.clips.delete).toHaveBeenCalledExactlyOnceWith('replaced-clip')
    expect(fixture.projects.put).toHaveBeenCalledExactlyOnceWith(project)
    expect(fixture.clips.put.mock.calls.map(([record]) => record)).toEqual([
      { id: first.id, projectId: project.id, label: first.label, prompt: first.prompt,
        mime: 'video/webm', createdAt: first.createdAt, blobBytes: new Uint8Array([4, 5]).buffer },
      { id: second.id, projectId: project.id, label: second.label, prompt: second.prompt,
        mime: 'video/mp4', createdAt: second.createdAt, blobBytes: new Uint8Array([6]).buffer },
    ])
    expect(fixture.db.close).not.toHaveBeenCalled()
    fixture.tx.oncomplete?.(new Event('complete'))
    await expect(saving).resolves.toBeUndefined()
    expect(fixture.db.close).toHaveBeenCalledOnce()
  })

  /** Every acquiring operation owns cleanup when transaction creation throws. */
  it.each([...writeOperations, ...readOperations])('closes after $name setup fails', async ({ run }) => {
    const fixture = controlledDatabase()
    const failure = new DOMException('Missing object store', 'NotFoundError')
    fixture.db.transaction.mockImplementation(() => { throw failure })

    await expect(run()).rejects.toBe(failure)
    expect(fixture.open).toHaveBeenCalledOnce()
    expect(fixture.db.close).toHaveBeenCalledOnce()
  })

  /** Cleanup also covers synchronous failures after transaction creation. */
  it('closes when a metadata put throws during setup', async () => {
    const fixture = controlledDatabase()
    const failure = new DOMException('Uncloneable prompt event', 'DataCloneError')
    fixture.projects.put.mockImplementation(() => { throw failure })

    await expect(saveProjectMetadata(project)).rejects.toBe(failure)
    expect(fixture.db.transaction).toHaveBeenCalledOnce()
    expect(fixture.db.close).toHaveBeenCalledOnce()
  })

  /** Metadata writes preserve clips and keep their connection through completion. */
  it('saves only project metadata and closes after completion', async () => {
    const fixture = controlledDatabase()
    const saving = saveProjectMetadata(project)
    await fixture.started
    expect(fixture.db.transaction).toHaveBeenCalledWith('projects', 'readwrite')
    expect(fixture.projects.put).toHaveBeenCalledExactlyOnceWith(project)
    expect(fixture.clips.put).not.toHaveBeenCalled()
    expect(fixture.clips.delete).not.toHaveBeenCalled()
    expect(fixture.db.close).not.toHaveBeenCalled()
    fixture.tx.oncomplete?.(new Event('complete'))
    await saving
    expect(fixture.db.close).toHaveBeenCalledOnce()
  })

  /** Error and later abort events belong to one failed operation and one close. */
  it.each(writeOperations)('closes $name once after error followed by abort', async ({ run }) => {
    const fixture = controlledDatabase()
    const failure = new DOMException('Storage quota reached', 'QuotaExceededError')
    const operation = run()
    const rejected = expect(operation).rejects.toEqual(new Error('QuotaExceededError: Storage quota reached'))
    await fixture.started
    expect(fixture.db.close).not.toHaveBeenCalled()
    fixture.tx.error = failure
    fixture.tx.onerror?.(new Event('error'))
    await rejected
    expect(fixture.db.close).toHaveBeenCalledOnce()
    fixture.tx.onabort?.(new Event('abort'))
    expect(fixture.db.close).toHaveBeenCalledOnce()
  })

  /** Abort without a browser error retains each operation's useful fallback message. */
  it.each(writeOperations)('rejects and closes $name on abort', async ({ run, failure }) => {
    const fixture = controlledDatabase()
    const rejected = expect(run()).rejects.toThrow(failure)
    await fixture.started
    expect(fixture.db.close).not.toHaveBeenCalled()
    fixture.tx.onabort?.(new Event('abort'))
    await rejected
    expect(fixture.db.close).toHaveBeenCalledOnce()
  })

  /** Read request errors reject the caller and release the acquired connection. */
  it.each(readOperations)('closes after a $name request error', async ({ run, request }) => {
    const fixture = controlledDatabase()
    const failure = new Error('Stored records could not be read')
    const rejected = expect(run()).rejects.toBe(failure)
    await fixture.started
    expect(fixture.db.close).not.toHaveBeenCalled()
    fixture[request].fail(failure)
    await rejected
    expect(fixture.db.close).toHaveBeenCalledOnce()
  })

  /** Writes retain the request error when the transaction supplies no error. */
  it.each(['saveProject', 'deleteProject'])('retains the %s request error through abort', async (name) => {
    const fixture = controlledDatabase()
    const failure = new DOMException('Clip request failed', 'UnknownError')
    const operation = name === 'saveProject' ? saveProject(project, []) : deleteProject(project.id)
    const rejected = expect(operation).rejects.toEqual(new Error('UnknownError: Clip request failed'))
    await fixture.started
    if (name === 'saveProject') {
      fixture.clipKeys.fail(failure)
      expect(fixture.tx.abort).toHaveBeenCalledOnce()
    } else {
      fixture.projectWrite.fail(failure)
    }
    fixture.tx.onabort?.(new Event('abort'))
    await rejected
    expect(fixture.db.close).toHaveBeenCalledOnce()
  })

  /** A failed open has no acquired connection for the caller to close. */
  it('preserves an open error without closing an unacquired database', async () => {
    const fixture = controlledDatabase()
    const failure = new Error('IndexedDB is unavailable')
    fixture.open.mockImplementation(() => {
      queueMicrotask(() => { fixture.opening.fail(failure) })
      return fixture.opening.request
    })
    await expect(listProjects()).rejects.toBe(failure)
    expect(fixture.db.transaction).not.toHaveBeenCalled()
    expect(fixture.db.close).not.toHaveBeenCalled()
  })

  /** Read completion preserves project contents and returns the newest project first. */
  it('lists projects newest first and closes after the read', async () => {
    const fixture = controlledDatabase()
    const older = { ...project, id: 'older', createdAt: 1 }
    const listing = listProjects()
    await fixture.started
    expect(fixture.db.close).not.toHaveBeenCalled()
    fixture.projectRead.succeed([older, project])
    await expect(listing).resolves.toEqual([project, older])
    expect(fixture.db.close).toHaveBeenCalledOnce()
  })

  /** Restore supported byte records and legacy Blobs while excluding invalid clips. */
  it('restores clip bytes and MIME types in creation order', async () => {
    const fixture = controlledDatabase()
    const { blob: legacyBlob, ...metadata } = makeClip('legacy').clip
    const paddedBytes = new Uint8Array([99, 4, 5, 99])
    const loading = loadProjectClips(project.id)
    await fixture.started
    expect(fixture.index.getAll).toHaveBeenCalledWith(project.id)
    expect(fixture.db.close).not.toHaveBeenCalled()
    fixture.clipRead.succeed([
      { ...metadata, id: 'buffer', createdAt: 30, mime: ' video/webm ', blobBytes: new Uint8Array([6]).buffer },
      { ...metadata, blob: legacyBlob, createdAt: 20 },
      { ...metadata, id: 'view', createdAt: 10, mime: '', blobBytes: paddedBytes.subarray(1, 3) },
      { ...metadata, id: 'invalid', blobBytes: 'not bytes' },
    ])
    const restored = await loading
    expect(restored.map(clip => clip.id)).toEqual(['view', 'legacy', 'buffer'])
    expect(restored.map(clip => clip.mime)).toEqual(['application/octet-stream', 'video/mp4', 'video/webm'])
    expect(restored[1]?.blob).toBe(legacyBlob)
    expect(restored[0]).toMatchObject({ projectId: project.id, label: metadata.label, prompt: metadata.prompt })
    const [viewClip, , bufferClip] = restored
    if (!viewClip || !bufferClip) throw new Error('Expected restored view and buffer clips')
    paddedBytes.fill(0)
    expect(Array.from(new Uint8Array(await readBlob(viewClip.blob)))).toEqual([4, 5])
    expect(Array.from(new Uint8Array(await readBlob(bufferClip.blob)))).toEqual([6])
    expect(bufferClip.blob.type).toBe('video/webm')
    expect(fixture.db.close).toHaveBeenCalledOnce()
  })

  /** Corrupt timestamps must reject the async read without escaping its request listener. */
  it('closes when sorting stored projects fails', async () => {
    const fixture = controlledDatabase()
    const rejected = expect(listProjects()).rejects.toBeInstanceOf(TypeError)
    await fixture.started
    const invalid = { ...project, createdAt: BigInt(1) }
    expect(() => { fixture.projectRead.succeed([project, invalid]) }).not.toThrow()
    await rejected
    expect(fixture.db.close).toHaveBeenCalledOnce()
  })

  /** Malformed clip records reject through the read owner and still release its connection. */
  it('closes when converting a stored clip fails', async () => {
    const fixture = controlledDatabase()
    const rejected = expect(loadProjectClips(project.id)).rejects.toBeInstanceOf(TypeError)
    await fixture.started
    expect(() => { fixture.clipRead.succeed([null]) }).not.toThrow()
    await rejected
    expect(fixture.db.close).toHaveBeenCalledOnce()
  })

  /** Delete only the selected project and the clip keys returned by its index cursor. */
  it('deletes a project and each matching clip before closing on commit', async () => {
    const fixture = controlledDatabase()
    const deleting = deleteProject(project.id)
    await fixture.started
    expect(fixture.projects.delete).toHaveBeenCalledExactlyOnceWith(project.id)
    expect(fixture.index.openKeyCursor).toHaveBeenCalledExactlyOnceWith({ only: project.id })
    const advance = vi.fn()
    fixture.cursor.succeed({ primaryKey: 'clip-1', continue: advance })
    fixture.cursor.succeed({ primaryKey: 'clip-2', continue: advance })
    fixture.cursor.succeed(null)
    expect(fixture.clips.delete.mock.calls).toEqual([['clip-1'], ['clip-2']])
    expect(advance).toHaveBeenCalledTimes(2)
    expect(fixture.db.close).not.toHaveBeenCalled()
    fixture.tx.oncomplete?.(new Event('complete'))
    await deleting
    expect(fixture.db.close).toHaveBeenCalledOnce()
  })
})
