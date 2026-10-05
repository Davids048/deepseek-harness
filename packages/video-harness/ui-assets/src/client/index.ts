/**
 * Browser half: register `vh-assets` as a right-Sidebar tab type and its body, and export the assets panel for the
 * workspace shell to render directly.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { VhClient } from '@video-harness/ui-kit/api.ts'
import { ToolApi } from '@video-harness/ui-kit/tool-api.ts'
import { AssetsTabBody } from './AssetsPanel.tsx'
import { ASSETS_ID, ASSETS_KIND, assetsDefinition } from './definition.ts'

export { AssetsPanel, type AssetsPanelProps } from './AssetsPanel.tsx'
export { ASSETS_ID, ASSETS_KIND }

/** Required browser services: the tab registry and the slot registry. */
export const inject = ['slots', 'sidebarRightTabs']

/**
 * Client plugin body: register the tab type and its body under the type's id.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.sidebarRightTabs.register(assetsDefinition), 'ui-assets: tab type')
  const injected = { client: new VhClient(), api: new ToolApi() }
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: ASSETS_ID, inject: () => injected },
    AssetsTabBody,
  )), 'ui-assets: tab body')
}
