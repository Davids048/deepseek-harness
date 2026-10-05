/**
 * The `@` source that lists the project items of the project the shell has open: clips by video and position
 * (`第1集·第2段`, or `Ep 1 · Shot 2` in English), characters, and assets. A pick inserts a reference chip whose text
 * is `@[<label>](vh:<address>)`; the host plugin `@video-harness/mentions` expands that address into record and asset
 * IDs for the model.
 *
 * @module @video-harness/ui-composer/mention
 */
import { createElement, type ComponentType } from 'react'
import type { InputTriggerCandidate, InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives'
import { assetUrl, VhClient } from '@video-harness/ui-kit/api.ts'
import type { WireState } from '@video-harness/ui-kit/types.ts'
import { getCurrentProject } from '@video-harness/ui-kit/current-project.ts'
import { pickText } from '@video-harness/ui-kit/locale.ts'

/** The source name; reference chips carry it so their codec serializes them. */
export const MENTION_SOURCE = 'vh-project'

/**
 * The reference text of one project item.
 * @param label - the chip label.
 * @param uri - the `vh:` address.
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
 * The project items of a folded state: every clip of every video, the characters, and the assets. Labels and group
 * names follow the interface language at call time, so the label a pick inserts is in that language.
 * @param state - the folded `main` state.
 * @returns the items in display order.
 */
export function projectItems(state: WireState): Item[] {
  const mime = new Map(state.assets.map(asset => [asset.id, asset]))
  const ops = new Map(state.ops.map(op => [op.id, op]))
  const sequences = state.sequences ?? (state.sequence === null ? [] : [{ id: 'main', title: '', items: state.sequence.items }])
  const clips = sequences.flatMap((sequence, video) => sequence.items.map((item, position): Item => {
    const producer = ops.get(state.producers[item.assetId] ?? '')
    const frame = producer?.outputs.find(id => mime.get(id)?.mime.startsWith('image/') === true)
    const prompt = typeof producer?.params['prompt'] === 'string' ? producer.params['prompt'] : ''
    return {
      uri: `vh:clip/${encodeURIComponent(sequence.id)}/${String(item.slot)}/${encodeURIComponent(item.assetId)}`,
      label: pickText(`第${String(video + 1)}集·第${String(position + 1)}段`, `Ep ${String(video + 1)} · Shot ${String(position + 1)}`),
      section: pickText('片段', 'Clips'),
      ...prompt === '' ? {} : { description: prompt.slice(0, 40) },
      icon: frame === undefined ? thumbnail(assetUrl(item.assetId), true) : thumbnail(assetUrl(frame), false),
    }
  }))
  const characters = Object.entries(state.entities).flatMap(([id, versions]): Item[] => {
    const latest = versions[versions.length - 1]
    if (latest === undefined) return []
    const image = latest.refs[0]
    return [{
      uri: `vh:entity/${encodeURIComponent(id)}`, label: latest.name || id, section: latest.kind === 'character' ? pickText('人物', 'Characters') : pickText('设定', 'Entities'),
      description: latest.description.slice(0, 40), ...image === undefined ? {} : { icon: thumbnail(assetUrl(image), false) },
    }]
  })
  const assets = state.assets.filter(asset => asset.mime.startsWith('image/') || asset.mime.startsWith('video/')).slice(-40).reverse()
    .map((asset): Item => ({
      uri: `vh:asset/${encodeURIComponent(asset.id)}`, label: asset.name, section: pickText('素材', 'Assets'),
      icon: thumbnail(assetUrl(asset.id), asset.mime.startsWith('video/')),
    }))
  return [...clips, ...characters, ...assets]
}

/**
 * The `@` source over the views API.
 * @returns the source.
 */
export function projectMentionSource(): InputTriggerSource {
  const client = new VhClient()
  return {
    trigger: '@',
    name: MENTION_SOURCE,
    showGroupTitle: false,
    async candidates(_session, { query, signal }): Promise<readonly InputTriggerCandidate[]> {
      // The project the shell has open; the entry page lists nothing.
      const projectId = getCurrentProject()
      if (projectId === null) return []
      const state = await client.state(projectId, 'main', signal)
      const needle = query.toLowerCase()
      // The menu shows a candidate name that differs from its label as a trailing alias, so the name is the label
      // (numbered when labels repeat) and the `vh:` address travels in `value`.
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
      serialize: ref => Promise.resolve(ref),
    },
  }
}
