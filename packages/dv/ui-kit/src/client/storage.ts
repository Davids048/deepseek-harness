/**
 * Web storage access for view preferences that a browser may refuse: storage throws in a private window or with
 * blocked site data, and a refused read or write leaves the view on its default.
 *
 * @module @dv/ui-kit/storage
 */

/** The storage a preference lives in: `local` keeps it across visits, `session` for the browser tab. */
export type StorageArea = 'local' | 'session'

/**
 * @param area - the storage.
 * @returns the browser's storage object; throws where storage is refused.
 */
function storageOf(area: StorageArea): Storage {
  return area === 'local' ? window.localStorage : window.sessionStorage
}

/**
 * Read one stored value.
 * @param area - the storage.
 * @param key - the key.
 * @returns the stored text, or null when none is stored or storage is refused.
 */
export function readStored(area: StorageArea, key: string): string | null {
  try {
    return storageOf(area).getItem(key)
  } catch (error) {
    // Refused storage reads as nothing stored, so the caller keeps its default.
    void error
    return null
  }
}

/**
 * Store one value, or remove it.
 * @param area - the storage.
 * @param key - the key.
 * @param value - the text to store, or null to remove the key.
 */
export function writeStored(area: StorageArea, key: string, value: string | null): void {
  try {
    if (value === null) storageOf(area).removeItem(key)
    else storageOf(area).setItem(key, value)
  } catch (error) {
    // Refused storage keeps the value for this page only.
    void error
  }
}
