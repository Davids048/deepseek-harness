/** Render each DreamVerse page child slot with the occupant component that its dreamverse-ui package registers. */
import { type ComponentType, createElement, type ReactNode } from 'react'
import AssetLibrary from '../../../assets/src/client/components/assets/AssetLibrary.tsx'
import ChatBar from '../../../creation/src/client/components/ChatBar.tsx'
import CreationStudio from '../../../creation/src/client/components/creation/CreationStudio.tsx'
import Workspace from '../../../directing/src/client/components/Workspace.tsx'
import VideoPlayer from '../../../player/src/client/components/VideoPlayer.tsx'
import Sidebar from '../../../project-history/src/client/components/Sidebar.tsx'
import type { DreamverseSlot, DreamverseSlotOwners, DreamverseSlotRenderer } from '../../src/client/contracts.ts'

const OCCUPANTS: { [K in DreamverseSlot]: ComponentType<DreamverseSlotOwners[K]> } = {
  'dreamverse.sidebar': Sidebar,
  'dreamverse.asset-library': AssetLibrary,
  'dreamverse.player': VideoPlayer,
  'dreamverse.workspace': Workspace,
  'dreamverse.creation-studio': CreationStudio,
  'dreamverse.chatbar': ChatBar,
}

/** The `renderSlot` prop of `DreamverseApp` in page tests: renders the real occupant with the owner props. */
export const renderDreamverseSlot: DreamverseSlotRenderer = (name, props): ReactNode => {
  const occupant: ComponentType<DreamverseSlotOwners[typeof name]> = OCCUPANTS[name]
  return createElement(occupant, props)
}
