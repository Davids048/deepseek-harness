import { useMemo } from 'react'
import { Box, ChevronDown, Clock, Monitor, Wand2 } from 'lucide-react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

import AutoExtensionPill from './AutoExtensionPill.tsx'
import ConfigPill from './ConfigPill.tsx'
import HeroTagline from '../HeroTagline.tsx'
import ChatBar from '../ChatBar.tsx'
import type { ReferencePickerProps } from '@dreamverse/ui-kit/contracts.ts'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@dreamverse/ui-kit/components/ui/dropdown-menu.tsx'
import { Popover, PopoverContent, PopoverTrigger } from '@dreamverse/ui-kit/components/ui/popover.tsx'
import { Slider } from '@dreamverse/ui-kit/components/ui/slider.tsx'
import {
  ASPECT_RATIOS,
  CREATION_MODELS,
  CREATION_MODES,
  RESOLUTIONS,
  UNSUPPORTED_CREATION_MODES,
  UNSUPPORTED_RESOLUTIONS,
  modeRequiresReference,
  type MentionOption,
} from '@dreamverse/project-controller/client/creationConfig.ts'
import {
  isSupportedCreationMode,
  isSupportedResolution,
  unsupportedModeNotice,
  type LobbyCreationCapabilities,
  type LobbySelection,
} from '@dreamverse/project-controller/client/creationCapabilities.ts'
import { modeName, modeSummary, modelName, resolutionName, secondsName } from '../../creationChoiceText.ts'
import { cn } from '@dreamverse/ui-kit/utils.ts'

interface CreationComposerProps {
  value: string
  disabled?: boolean
  isGenerating?: boolean
  canSubmit?: boolean
  autoExtensionRequested?: boolean
  onAutoExtensionRequestChange?: (enabled: boolean) => void
  selection: LobbySelection
  referencePicker?: ReferencePickerProps | undefined
  mentionOptions?: MentionOption[]
  onValueChange: (value: string) => void
  onSubmit: () => void
  onSelectionChange: (changes: Partial<LobbySelection>) => void

  capabilities: LobbyCreationCapabilities | null
  capabilityNotice: string | null
  t: TranslateNS<'dreamverse.creation'>
}

/** Edit the lobby prompt and generation choices before starting a project. */
export default function CreationComposer({
  value,
  disabled = false,
  isGenerating = false,
  canSubmit = false,
  autoExtensionRequested = false,
  onAutoExtensionRequestChange,
  selection,
  referencePicker,
  mentionOptions = [],
  onValueChange,
  onSubmit,
  onSelectionChange,

  capabilities,
  capabilityNotice,
  t,
}: CreationComposerProps) {
  const { modeId, aspectRatio, resolution, segmentCount, segmentDurationSec } = selection

  const availableModes = useMemo(
    () => capabilities
      ? [...CREATION_MODES, ...UNSUPPORTED_CREATION_MODES].filter(mode => isSupportedCreationMode(mode, capabilities))
      : [],
    [capabilities],
  )
  const unavailableModes = useMemo(
    () => capabilities
      ? UNSUPPORTED_CREATION_MODES.filter(mode => unsupportedModeNotice(mode, capabilities) !== null)
      : [],
    [capabilities],
  )
  const availableAspectRatios = useMemo(
    () => capabilities ? ASPECT_RATIOS.filter(ratio => capabilities.aspect_ratios.includes(ratio)) : [],
    [capabilities],
  )
  const availableResolutions = useMemo(
    () => capabilities
      ? [...RESOLUTIONS, ...UNSUPPORTED_RESOLUTIONS].filter(item => isSupportedResolution(item, capabilities))
      : [],
    [capabilities],
  )
  const unavailableResolutions = useMemo(
    () => capabilities ? UNSUPPORTED_RESOLUTIONS.filter(item => !isSupportedResolution(item, capabilities)) : [],
    [capabilities],
  )

  const selectedModel = CREATION_MODELS.find(model => model.id === capabilities?.model_id)
  const selectedMode = availableModes.find(mode => mode === modeId)
  const requiresReference = modeRequiresReference(modeId)
  const referenceMissing = requiresReference && !referencePicker?.references.length
  const submitDisabled = !capabilities || !canSubmit || disabled || isGenerating || !value.trim() || referenceMissing


  return (
    <section className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <HeroTagline t={t} />

      <ChatBar
        continuationDraft={value}
        canStartProject={!submitDisabled}
        autoExtensionRequested={autoExtensionRequested}
        canChooseAutoExtension={!disabled && !isGenerating}
        {...(onAutoExtensionRequestChange ? { onAutoExtensionRequestChange } : {})}
        isGenerating={isGenerating || disabled}
        onContinuationInput={onValueChange}
        onGenerate={onSubmit}
        mentionOptions={mentionOptions}
        referencePicker={referencePicker}
        t={t}
      >

        <div className="flex flex-wrap items-center gap-1.5 pt-2">
          {capabilities ? (
            <>
              <span className="inline-flex h-9 items-center gap-1 px-2.5 text-[11px] font-medium text-foreground/90">
                <Box className="size-3.5" />
                {selectedModel && modelName(selectedModel.id, t)}
              </span>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <ConfigPill disabled={disabled}>
                    <Wand2 className="size-3.5" />
                    {selectedMode && modeName(selectedMode, t)}
                    <ChevronDown className="size-3 opacity-60" />
                  </ConfigPill>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-64">
                  <DropdownMenuLabel>{t('config.mode')}</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {availableModes.map(mode => (
                    <DropdownMenuItem key={mode} onClick={() => { onSelectionChange({ modeId: mode }) }} className="flex-col items-start gap-1 py-2.5">
                      <span className="text-sm font-medium">{modeName(mode, t)}</span>
                      <span className="text-xs text-muted-foreground">{modeSummary(mode, t)}</span>
                    </DropdownMenuItem>
                  ))}
                  {unavailableModes.length > 0 && <DropdownMenuSeparator />}
                  {unavailableModes.map(mode => (
                    <DropdownMenuItem key={mode} disabled className="flex-col items-start gap-1 py-2.5 opacity-60">
                      <span className="text-sm font-medium">{modeName(mode, t)}</span>
                      <span className="text-xs text-muted-foreground">
                        {unsupportedModeNotice(mode, capabilities) ?? modeSummary(mode, t)}
                      </span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>

              <Popover>
                <PopoverTrigger asChild>
                  <ConfigPill disabled={disabled}>
                    <Monitor className="size-3.5" />
                    {aspectRatio} {resolutionName(resolution, t)}
                  </ConfigPill>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-80">
                  <p className="mb-3 text-xs font-medium text-muted-foreground">{t('config.aspectRatio')}</p>
                  <div className="grid grid-cols-3 gap-2">
                    {availableAspectRatios.map(ratio => (
                      <button
                        key={ratio}
                        type="button"
                        onClick={() => { onSelectionChange({ aspectRatio: ratio }) }}
                        className={cn(
                          'studio-control studio-control-press studio-hover-surface flex flex-col items-center gap-2 rounded-xl border px-2 py-3 text-xs',
                          aspectRatio === ratio ? 'border-accent-blue bg-accent-blue/10 text-foreground' : 'border-border',
                        )}
                      >
                        <span className={cn('rounded-sm border border-current/40 bg-muted/40', ratio === '9:16' && 'h-7 w-4', ratio === '16:9' && 'h-4 w-7', ratio === '1:1' && 'size-5', ratio === '4:3' && 'h-5 w-6', ratio === '3:4' && 'h-6 w-5', ratio === '21:9' && 'h-3 w-8')} />
                        {ratio}
                      </button>
                    ))}
                  </div>
                  <p className="mb-2 mt-4 text-xs font-medium text-muted-foreground">{t('config.resolution')}</p>
                  <div className="flex flex-wrap gap-2">
                    {availableResolutions.map(item => (
                      <button
                        key={item}
                        type="button"
                        onClick={() => { onSelectionChange({ resolution: item }) }}
                        className={cn(
                          'studio-control studio-control-press studio-hover-surface rounded-full border px-3 py-1.5 text-xs font-medium',
                          resolution === item ? 'border-accent-blue bg-accent-blue/10 text-foreground' : 'border-border',
                        )}
                      >
                        {resolutionName(item, t)}
                      </button>
                    ))}
                    {unavailableResolutions.map(item => (
                      <button
                        key={item}
                        type="button"
                        disabled
                        className="studio-control rounded-full border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground opacity-50"
                        title={t('config.resolution.unsupported')}
                      >
                        {resolutionName(item, t)}
                      </button>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <ConfigPill disabled={disabled} aria-label={t('config.segments.aria', { count: segmentCount })}>
                    {t('config.segments.pill', { count: segmentCount })}
                    <ChevronDown className="size-3 opacity-60" />
                  </ConfigPill>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuLabel>{t('config.segments')}</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {capabilities.segment_counts.map(count => (
                    <DropdownMenuItem key={count} onClick={() => { onSelectionChange({ segmentCount: count }) }}>
                      {t(count === 1 ? 'config.segmentCount.one' : 'config.segmentCount.other', { count })}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>

              <Popover>
                <PopoverTrigger asChild>
                  <ConfigPill disabled={disabled} aria-label={t('config.duration.aria', { duration: secondsName(segmentDurationSec, t) })}>
                    <Clock className="size-3.5" />
                    {t('config.duration.pill', { duration: secondsName(segmentDurationSec, t) })}
                  </ConfigPill>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-72">
                  <p className="mb-3 text-xs font-medium text-muted-foreground">{t('config.duration')}</p>
                  <Slider
                    min={capabilities.min_segment_duration_sec}
                    max={capabilities.max_segment_duration_sec}
                    step={1}
                    aria-label={t('config.duration')}
                    aria-valuetext={t('config.duration.valueText', { seconds: segmentDurationSec })}
                    value={[segmentDurationSec]}
                    onValueChange={([duration]) => {
                      if (duration !== undefined) onSelectionChange({ segmentDurationSec: duration })
                    }}
                  />
                  <div className="mt-3 flex items-center justify-between text-[11px] text-muted-foreground">
                    <span>{secondsName(capabilities.min_segment_duration_sec, t)}</span>
                    <span className="rounded-md border border-border px-2 py-1 text-xs font-medium text-foreground">{secondsName(segmentDurationSec, t)}</span>
                    <span>{secondsName(capabilities.max_segment_duration_sec, t)}</span>
                  </div>
                </PopoverContent>
              </Popover>
              {onAutoExtensionRequestChange && (
                <AutoExtensionPill requested={autoExtensionRequested}
                  disabled={disabled || isGenerating}
                  onChange={onAutoExtensionRequestChange} t={t} />
              )}
              <p role="status" aria-live="polite" className="w-full px-2.5 text-xs text-muted-foreground">
                {t(segmentCount === 1 ? 'config.total.one' : 'config.total.other', {
                  count: segmentCount,
                  duration: secondsName(segmentDurationSec, t),
                  total: secondsName(segmentCount * segmentDurationSec, t),
                })}
              </p>
            </>
          ) : (
            <p role="status" className="min-w-0 flex-1 px-2 text-xs text-muted-foreground">
              {capabilityNotice}
            </p>
          )}

        </div>

        {referenceMissing && value.trim() && (
          <p className="mt-3 text-center text-xs leading-5 text-amber-700 dark:text-amber-400">
            {t('config.referenceRequired', { mode: selectedMode ? modeName(selectedMode, t) : '' })}
          </p>
        )}
      </ChatBar>
    </section>
  )
}
