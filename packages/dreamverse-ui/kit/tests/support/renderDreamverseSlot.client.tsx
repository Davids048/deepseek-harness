/**
 * Render each DreamVerse page child slot with the occupant component that its dreamverse-ui package registers, and
 * translate every package's copy with its English dictionary, as the DSH `t` seat does under the English locale.
 */
import { createElement, type ReactNode } from 'react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import AssetLibrary from '../../../assets/src/client/components/assets/AssetLibrary.tsx'
import { en as assetsEn } from '../../../assets/src/client/locales.ts'
import ChatBar from '../../../creation/src/client/components/ChatBar.tsx'
import CreationStudio from '../../../creation/src/client/components/creation/CreationStudio.tsx'
import { en as creationEn } from '../../../creation/src/client/locales.ts'
import Workspace from '../../../directing/src/client/components/Workspace.tsx'
import { en as directingEn } from '../../../directing/src/client/locales.ts'
import VideoPlayer from '../../../player/src/client/components/VideoPlayer.tsx'
import { en as playerEn } from '../../../player/src/client/locales.ts'
import Sidebar from '../../../project-history/src/client/components/Sidebar.tsx'
import { en as projectHistoryEn } from '../../../project-history/src/client/locales.ts'
import type { DreamverseSlot, DreamverseSlotOwners, DreamverseSlotRenderer } from '../../src/client/contracts.ts'
import { en as kitEn } from '../../src/client/locales.ts'

/** The English `dreamverse.kit` translate function that page tests pass to `DreamverseApp`. */
export const englishKitT = makeTranslate(kitEn)

/** Renders one slot's real occupant with the owner props and the English translate function of its package. */
const OCCUPANTS: { [K in DreamverseSlot]: (props: DreamverseSlotOwners[K]) => ReactNode } = {
  'dreamverse.sidebar': props => createElement(Sidebar, { ...props, t: makeTranslate(projectHistoryEn) }),
  'dreamverse.asset-library': props => createElement(AssetLibrary, { ...props, t: makeTranslate(assetsEn) }),
  'dreamverse.player': props => createElement(VideoPlayer, { ...props, t: makeTranslate(playerEn) }),
  'dreamverse.workspace': props => createElement(Workspace, { ...props, t: makeTranslate(directingEn) }),
  'dreamverse.creation-studio': props => createElement(CreationStudio, { ...props, t: makeTranslate(creationEn) }),
  'dreamverse.chatbar': props => createElement(ChatBar, { ...props, t: makeTranslate(creationEn) }),
}

/** The `renderSlot` prop of `DreamverseApp` in page tests: renders the real occupant with the owner props. */
export const renderDreamverseSlot: DreamverseSlotRenderer = (name, props): ReactNode => {
  const occupant: (owner: DreamverseSlotOwners[typeof name]) => ReactNode = OCCUPANTS[name]
  return occupant(props)
}
