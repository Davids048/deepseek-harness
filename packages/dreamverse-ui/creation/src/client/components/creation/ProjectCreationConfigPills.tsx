import { Box, ChevronDown, Clock, Monitor, Wand2 } from 'lucide-react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

import ConfigPill from './ConfigPill.tsx'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@dreamverse/ui-kit/components/ui/dropdown-menu.tsx'
import { Popover, PopoverContent, PopoverTrigger } from '@dreamverse/ui-kit/components/ui/popover.tsx'
import {
  ASPECT_RATIOS,
  CREATION_MODELS,
  CREATION_MODES,
  RESOLUTIONS,
  type AspectRatioId,
  type CreationModeId,
  type CreationModelId,
  type ResolutionId,
} from '@dreamverse/project-controller/client/creationConfig.ts'
import { modeName, modeSummary, modelName, modelSummary, resolutionName, secondsName } from '../../creationChoiceText.ts'
import { cn } from '@dreamverse/ui-kit/utils.ts'
import type { ProjectCreationConfig } from '@dreamverse/ui-kit/contracts.ts'

export type { ProjectCreationConfig }

interface ProjectCreationConfigPillsProps extends ProjectCreationConfig {
  disabled?: boolean
  readOnly?: boolean
  onModelChange?: ((modelId: CreationModelId) => void) | undefined
  onModeChange?: ((modeId: CreationModeId) => void) | undefined
  onAspectRatioChange?: ((aspectRatio: AspectRatioId) => void) | undefined
  onResolutionChange?: ((resolution: ResolutionId) => void) | undefined
  t: TranslateNS<'dreamverse.creation'>
}

/** Display a project's creation settings with optional editing controls. */
export default function ProjectCreationConfigPills({
  modelId,
  modeId,
  aspectRatio,
  resolution,
  segmentDurationSec,
  segmentCount,
  disabled = false,
  readOnly = false,
  onModelChange,
  onModeChange,
  onAspectRatioChange,
  onResolutionChange,
  t,
}: ProjectCreationConfigPillsProps) {
  const selectedModel = CREATION_MODELS.find(model => model.id === modelId) ?? CREATION_MODELS[0]
  const selectedMode = CREATION_MODES.find(mode => mode === modeId) ?? CREATION_MODES[0]
  const isInteractive = !readOnly && !disabled

  const pillClassName = cn(
    'h-9 min-h-9 px-2 text-[11px]',
    !isInteractive && 'pointer-events-none opacity-70',
  )

  if (readOnly) {
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        <ConfigPill disabled className={pillClassName} aria-label={t('config.model')}>
          <Box className="size-3" />
          {selectedModel && modelName(selectedModel.id, t)}
        </ConfigPill>
        <ConfigPill disabled className={pillClassName} aria-label={t('config.mode')}>
          <Wand2 className="size-3" />
          {selectedMode && modeName(selectedMode, t)}
        </ConfigPill>
        <ConfigPill disabled className={pillClassName} aria-label={t('config.aspectRatioResolution')}>
          <Monitor className="size-3" />
          {aspectRatio} {resolutionName(resolution, t)}
        </ConfigPill>
        <ConfigPill disabled className={pillClassName} aria-label={t('config.segments')}>
          {t(segmentCount === 1 ? 'config.segmentCount.one' : 'config.segmentCount.other', { count: segmentCount })}
        </ConfigPill>
        <ConfigPill disabled className={pillClassName} aria-label={t('config.duration')}>
          <Clock className="size-3" />
          {t('config.duration.pill', { duration: secondsName(segmentDurationSec, t) })}
        </ConfigPill>
      </div>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <ConfigPill disabled={disabled} className={pillClassName} aria-label={t('config.model')}>
            <Box className="size-3" />
            {selectedModel && modelName(selectedModel.id, t)}
            <ChevronDown className="size-2.5 opacity-60" />
          </ConfigPill>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72">
          <DropdownMenuLabel>{t('config.model')}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {CREATION_MODELS.map(model => (
            <DropdownMenuItem key={model.id} onClick={() => onModelChange?.(model.id)} className="flex-col items-start gap-1 py-2.5">
              <span className="flex items-center gap-2 text-sm font-medium">
                {modelName(model.id, t)}
                {model.badge === 'new' && <span className="rounded-full bg-accent-blue/15 px-1.5 py-0.5 text-[10px] text-accent-blue">{t('model.badge.new')}</span>}
              </span>
              <span className="text-xs text-muted-foreground">{modelSummary(model.id, t)}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <ConfigPill disabled={disabled} className={pillClassName} aria-label={t('config.mode')}>
            <Wand2 className="size-3" />
            {selectedMode && modeName(selectedMode, t)}
            <ChevronDown className="size-2.5 opacity-60" />
          </ConfigPill>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel>{t('config.mode')}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {CREATION_MODES.map(mode => (
            <DropdownMenuItem key={mode} onClick={() => onModeChange?.(mode)} className="flex-col items-start gap-1 py-2.5">
              <span className="text-sm font-medium">{modeName(mode, t)}</span>
              <span className="text-xs text-muted-foreground">{modeSummary(mode, t)}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <Popover>
        <PopoverTrigger asChild>
          <ConfigPill disabled={disabled} className={pillClassName} aria-label={t('config.aspectRatioResolution')}>
            <Monitor className="size-3" />
            {aspectRatio} {resolutionName(resolution, t)}
          </ConfigPill>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80">
          <p className="mb-3 text-xs font-medium text-muted-foreground">{t('config.aspectRatio')}</p>
          <div className="grid grid-cols-3 gap-2">
            {ASPECT_RATIOS.map(ratio => (
              <button
                key={ratio}
                type="button"
                onClick={() => onAspectRatioChange?.(ratio)}
                className={cn(
                  'studio-control studio-control-press studio-hover-surface flex flex-col items-center gap-2 rounded-xl border px-2 py-3 text-xs',
                  aspectRatio === ratio ? 'border-accent-blue bg-accent-blue/10 text-foreground' : 'border-border',
                )}
              >
                <span
                  className={cn(
                    'rounded-sm border border-current/40 bg-muted/40',
                    ratio === '9:16' && 'h-7 w-4',
                    ratio === '16:9' && 'h-4 w-7',
                    ratio === '1:1' && 'size-5',
                    ratio === '4:3' && 'h-5 w-6',
                    ratio === '3:4' && 'h-6 w-5',
                    ratio === '21:9' && 'h-3 w-8',
                  )}
                />
                {ratio}
              </button>
            ))}
          </div>
          <p className="mb-2 mt-4 text-xs font-medium text-muted-foreground">{t('config.resolution')}</p>
          <div className="flex flex-wrap gap-2">
            {RESOLUTIONS.map(item => (
              <button
                key={item}
                type="button"
                onClick={() => onResolutionChange?.(item)}
                className={cn(
                  'studio-control studio-control-press studio-hover-surface rounded-full border px-3 py-1.5 text-xs font-medium',
                  resolution === item ? 'border-accent-blue bg-accent-blue/10 text-foreground' : 'border-border',
                )}
              >
                {resolutionName(item, t)}
              </button>
            ))}
          </div>
        </PopoverContent>
      </Popover>

      <ConfigPill disabled className={pillClassName} aria-label={t('config.segments')}>
        {t(segmentCount === 1 ? 'config.segmentCount.one' : 'config.segmentCount.other', { count: segmentCount })}
      </ConfigPill>
      <ConfigPill disabled className={pillClassName} aria-label={t('config.duration')}>
        <Clock className="size-3" />
        {t('config.duration.pill', { duration: secondsName(segmentDurationSec, t) })}
      </ConfigPill>
    </div>
  )
}
