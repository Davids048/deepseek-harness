/**
 * What the `vh-assets` tab type is: a page type the guide offers, with no resource address.
 */
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { pickText } from '@video-harness/ui-kit/locale.ts'

/** The tab kind this package owns. */
export const ASSETS_KIND = 'vh-assets'

/** This implementation's identity in the tab system, and the key its body registers under. */
export const ASSETS_ID = '@video-harness/ui-assets'

/** The assets type's registry definition. */
export const assetsDefinition: SidebarRightTabDefinition = {
  id: ASSETS_ID,
  kind: ASSETS_KIND,
  priority: 'builtin',
  keepMounted: true,
  title: () => pickText('素材', 'Assets'),
  guide: [{
    id: 'assets', order: 35, title: () => pickText('素材', 'Assets'),
    description: () => pickText('项目的人物、参考图、导入和渲染结果', "The project's characters, reference images, imports, and renders"),
  }],
}
