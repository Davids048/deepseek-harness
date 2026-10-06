/**
 * What the `dv-asset-pool` tab type is: a page type the guide offers, with no resource address.
 */
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { pickText } from '@dv/ui-kit/locale.ts'

/** The tab kind this package owns. */
export const ASSET_POOL_KIND = 'dv-asset-pool'

/** This implementation's identity in the tab system, and the key its body registers under. */
export const ASSET_POOL_ID = '@dv/ui-asset-pool'

/** The asset pool type's registry definition. */
export const assetPoolDefinition: SidebarRightTabDefinition = {
  id: ASSET_POOL_ID,
  kind: ASSET_POOL_KIND,
  priority: 'builtin',
  keepMounted: true,
  title: () => pickText('素材库', 'Asset pool'),
  guide: [{
    id: 'assets', order: 35, title: () => pickText('素材库', 'Asset pool'),
    description: () => pickText('项目的角色、参考图、导入的文件和渲染结果', "The project's characters, reference images, imports, and renders"),
  }],
}
