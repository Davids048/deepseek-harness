import AppNavRail from './AppNavRail.tsx'
import CreationComposer from './CreationComposer.tsx'
import PresetQuickLaunchRail from './PresetQuickLaunchRail.tsx'

import type { CreationStudioProps } from '@dreamverse/ui-kit/contracts.ts'

/** Arrange the creation composer and preset shortcuts. */
export default function CreationStudio({
  activeSection = 'create',
  onOpenAssets,
  storyPresets = [],
  onPresetGenerate,
  isGenerating = false,
  capabilities,
  ...composerProps
}: CreationStudioProps) {
  return (
    <div className="flex min-h-0 flex-1">
      <AppNavRail activeSection={activeSection} onOpenAssets={onOpenAssets} />
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 py-7 sm:px-6 sm:py-8">
          <CreationComposer {...composerProps} isGenerating={isGenerating} capabilities={capabilities} />
          {storyPresets.length > 0 && onPresetGenerate && (
            <PresetQuickLaunchRail storyPresets={storyPresets} disabled={isGenerating || composerProps.disabled || !capabilities}
              onPresetGenerate={onPresetGenerate} />
          )}
        </div>
      </div>
    </div>
  )
}
