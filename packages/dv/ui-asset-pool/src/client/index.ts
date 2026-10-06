/**
 * Browser half: register `dv-asset-pool` as a right-Sidebar tab type and its body, and export the asset pool panel for
 * the workspace shell to render directly.
 *
 * @module @dv/ui-asset-pool/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { DvClient } from '@dv/ui-kit/api.ts'
import { AssetsTabBody } from './AssetsPanel.tsx'
import { ASSET_POOL_ID, ASSET_POOL_KIND, assetPoolDefinition } from './definition.ts'

export { AssetsPanel, type AssetsPanelProps } from './AssetsPanel.tsx'
export { ASSET_POOL_ID, ASSET_POOL_KIND }

/** Required browser services: the tab registry and the DSH UI slot registry. */
export const inject = ['slots', 'sidebarRightTabs']

/**
 * Client plugin body: register the tab type and its body under the type's id.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.sidebarRightTabs.register(assetPoolDefinition), 'ui-asset-pool: tab type')
  const injected = { client: new DvClient() }
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: ASSET_POOL_ID, inject: () => injected },
    AssetsTabBody,
  )), 'ui-asset-pool: tab body')
}
