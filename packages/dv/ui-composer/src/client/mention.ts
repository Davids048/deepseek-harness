/**
 * The `@` source that lists the project items of the project the shell has open: clips by timeline name and position
 * (`时间线 1 · 片段 2`, or `Timeline 1 · Clip 2` in English, for an unnamed timeline), characters, locations, styles,
 * and assets. A pick inserts a reference chip whose text is `@[<label>](dv:<kind>/<id>)`; the host plugin
 * `@dv/chat-references` expands that address into record and asset IDs for the model. Sending a message that holds a
 * `dv:asset/<id>` chip places that asset on the open project's canvas (`DvClient.placeAssets`).
 *
 * @module @dv/ui-composer/mention
 */
import { createElement, type ComponentType } from 'react'
import type { InputTriggerCandidate, InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives'
import { assetUrl, DvClient } from '@dv/ui-kit/api.ts'
import type { Character, WireState } from '@dv/ui-kit/types.ts'
import { getCurrentProject } from '@dv/ui-kit/current-project.ts'
import { pickText } from '@dv/ui-kit/locale.ts'
import { timelineName } from '@dv/ui-kit/timeline.ts'

/** The source name; reference chips carry it so their codec serializes them. */
export const MENTION_SOURCE = 'dv-project'

/**
 * The reference text of one project item.
 * @param label - the chip label.
 * @param uri - the `dv:` address.
 * @returns `@[label](uri)`.
 */
export function referenceText(label: string, uri: string): string {
  return `@[${label.replaceAll(']', '')}](${uri})`
}

/** A small thumbnail as a candidate icon. */
function thumbnail(url: string, video: boolean): ComponentType<IconProps> {
  // Sized to stay clear of the label in the 14 px icon column of the @ menu.
  const style = { width: 20, height: 14, objectFit: 'cover' as const, borderRadius: 3, flex: 'none' }
  return function Thumbnail() {
    return video ? createElement('video', { src: url, muted: true, preload: 'metadata', style }) : createElement('img', { src: url, alt: '', style })
  }
}

/** One listed item before query filtering. */
interface Item {
  uri: string
  label: string
  section: string
  description?: string
  icon?: ComponentType<IconProps>
}

/**
 * The story bible items of one kind: the latest version of each character, location or style.
 * @param kind - the URI kind.
 * @param versions - the versions by ID, oldest first.
 * @param section - the group name.
 * @returns the items.
 */
function bibleItems(kind: 'character' | 'location' | 'style', versions: Record<string, Character[]>, section: string): Item[] {
  return Object.entries(versions).flatMap(([id, list]): Item[] => {
    const latest = list[list.length - 1]
    if (latest === undefined) return []
    const image = latest.references[0]
    return [{
      uri: `dv:${kind}/${encodeURIComponent(id)}`, label: latest.name || id, section,
      description: latest.description.slice(0, 40), ...image === undefined ? {} : { icon: thumbnail(assetUrl(image), false) },
    }]
  })
}

/**
 * The project items of a branch state: every clip of every timeline, the characters, locations and styles, and the
 * assets. Labels and group names follow the interface language at call time, so the label a pick inserts is in that
 * language.
 * @param state - the state of `main`.
 * @returns the items in display order.
 */
export function projectItems(state: WireState): Item[] {
  const assetsById = new Map(state.assets.map(asset => [asset.id, asset]))
  const proj = state.components.proj
  const records = new Map(proj.records.map(record => [record.id, record]))
  const clips = state.components.timeline.timelines.flatMap(timeline => timeline.clips.map((clip, position): Item => {
    // A placeholder clip (no asset yet) takes its prompt from the render it waits for and shows no thumbnail.
    const producer = records.get(clip.asset === null ? clip.source?.record ?? '' : proj.created_by[clip.asset] ?? '')
    const frame = producer?.outputs.find(id => assetsById.get(id)?.mime.startsWith('image/') === true)
    const name = timelineName(timeline, n => pickText(`时间线 ${String(n)}`, `Timeline ${String(n)}`))
    const prompt = typeof producer?.params['prompt'] === 'string' ? producer.params['prompt'] : ''
    return {
      uri: `dv:clip/${encodeURIComponent(clip.id)}`,
      label: pickText(`${name} · 片段 ${String(position + 1)}`, `${name} · Clip ${String(position + 1)}`),
      section: pickText('片段', 'Clips'),
      ...prompt === '' ? {} : { description: prompt.slice(0, 40) },
      ...frame !== undefined
        ? { icon: thumbnail(assetUrl(frame), false) }
        : clip.asset === null ? {} : { icon: thumbnail(assetUrl(clip.asset), true) },
    }
  }))
  const bible = state.components.bible
  const settings = pickText('场景和风格', 'Locations and styles')
  const characters = [
    ...bibleItems('character', bible.characters, pickText('角色', 'Characters')),
    ...bibleItems('location', bible.locations, settings),
    ...bibleItems('style', bible.styles, settings),
  ]
  const assets = state.assets.filter(asset => asset.mime.startsWith('image/') || asset.mime.startsWith('video/')).slice(-40).reverse()
    .map((asset): Item => ({
      uri: `dv:asset/${encodeURIComponent(asset.id)}`, label: asset.name, section: pickText('素材', 'Assets'),
      icon: thumbnail(assetUrl(asset.id), asset.mime.startsWith('video/')),
    }))
  return [...clips, ...characters, ...assets]
}

/**
 * The asset ID a reference text names, when it names an asset.
 * @param text - the chip text, `@[<label>](dv:<kind>/<id>)`.
 * @returns the asset ID, or undefined for a clip, character, location, or style.
 */
function assetOfReference(text: string): string | undefined {
  const match = /\(dv:asset\/([^)]+)\)$/.exec(text)
  return match?.[1] === undefined ? undefined : decodeURIComponent(match[1])
}

/**
 * The `@` source over the `/api/dv` routes.
 * @returns the source.
 */
export function projectMentionSource(): InputTriggerSource {
  const client = new DvClient()
  return {
    trigger: '@',
    name: MENTION_SOURCE,
    showGroupTitle: false,
    async candidates(_session, { query, signal }): Promise<readonly InputTriggerCandidate[]> {
      // The project the shell has open; the entry page lists nothing.
      const projectId = getCurrentProject()
      if (projectId === null) return []
      const state = await client.getState(projectId, 'main', signal)
      const needle = query.toLowerCase()
      // The menu shows a candidate name that differs from its label as a trailing alias, so the name is the label
      // (numbered when labels repeat) and the `dv:` address travels in `value`.
      const seen = new Map<string, number>()
      return projectItems(state)
        .filter(item => needle === '' || item.label.toLowerCase().includes(needle) || (item.description ?? '').toLowerCase().includes(needle))
        .map((item): InputTriggerCandidate => {
          const count = (seen.get(item.label) ?? 0) + 1
          seen.set(item.label, count)
          return {
            name: count === 1 ? item.label : `${item.label} (${String(count)})`, section: item.section, value: JSON.stringify({ uri: item.uri, label: item.label }),
            ...item.description === undefined ? {} : { description: item.description },
            ...item.icon === undefined ? {} : { icon: item.icon },
          }
        })
    },
    onPick({ candidate }) {
      const { uri, label } = JSON.parse(candidate.value ?? '{}') as { uri?: string; label?: string }
      if (uri === undefined || label === undefined) return undefined
      const text = referenceText(label, uri)
      return { insert: { source: MENTION_SOURCE, ref: text, label, clipboardText: text } }
    },
    codec: {
      clipboardText: ref => ref,
      serialize: (ref) => {
        // The message is being sent: an asset it references goes on the open project's canvas. A failed write leaves
        // the canvas as it was and does not stop the message.
        const assetId = assetOfReference(ref)
        const projectId = getCurrentProject()
        if (assetId !== undefined && projectId !== null) void client.placeAssets(projectId, [assetId]).catch(() => null)
        return Promise.resolve(ref)
      },
    },
  }
}
