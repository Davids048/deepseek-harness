/**
 * The interface language for DreamVerse panels. DSH's locale plugin writes the active language to `<html lang>`
 * (`zh-CN` for Chinese), so every DreamVerse bundle reads that attribute and re-renders when it changes. Panels write
 * each product string as a Chinese and English pair through `useText()`.
 *
 * @module @dv/ui-kit/locale
 */
import { useSyncExternalStore } from 'react'

/** A DreamVerse interface language. */
export type DvLanguage = 'zh' | 'en'

/** Pick one string of a Chinese and English pair. */
export type PickText = (zh: string, en: string) => string

/** @returns the language that `<html lang>` names; Chinese for any `zh*` value, English otherwise. */
export function currentLanguage(): DvLanguage {
  return document.documentElement.lang.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

/**
 * Call `listener` whenever `<html lang>` changes.
 * @param listener - the callback.
 * @returns the unsubscribe function.
 */
function subscribe(listener: () => void): () => void {
  const observer = new MutationObserver(listener)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
  return () => { observer.disconnect() }
}

/** @returns the interface language, re-rendering the component when it changes. */
export function useLanguage(): DvLanguage {
  return useSyncExternalStore(subscribe, currentLanguage)
}

/**
 * The string picker for the interface language.
 * @returns a function that returns the Chinese or the English string of a pair.
 */
export function useText(): PickText {
  const language = useLanguage()
  return language === 'zh' ? zh => zh : (_zh, en) => en
}

/**
 * Pick one string outside React, for example in event handlers or confirm dialogs.
 * @param zh - the Chinese string.
 * @param en - the English string.
 * @returns the string for the current interface language.
 */
export function pickText(zh: string, en: string): string {
  return currentLanguage() === 'zh' ? zh : en
}
