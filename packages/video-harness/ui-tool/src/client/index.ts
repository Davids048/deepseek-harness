/**
 * Browser half of the Tool mode plugin: exports the Tool view and the Tool session list for the workspace shell to
 * render. The plugin registers nothing itself.
 */
export { ToolView, type ToolViewProps } from './ToolView.tsx'
export { ToolSessionsNav, type ToolSessionsNavProps } from './ToolSessionsNav.tsx'

/** Required browser services: none. */
export const inject: string[] = []

/** Client plugin body: nothing to register; the shell renders the exported components. */
export function apply(): void {}
