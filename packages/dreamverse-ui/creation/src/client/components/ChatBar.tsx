import React, { useRef, useState, useCallback, useEffect, useMemo } from 'react'
import ReferencePicker from './assets/ReferencePicker.tsx'
import type { MentionOption } from '@dreamverse/project-controller/client/creationConfig.ts'
import { ArrowUp, X, Loader2 } from 'lucide-react'
import { Button } from '@dreamverse/ui-kit/components/ui/button.tsx'
import LeaveProjectModal, { shouldShowLeaveWarning } from './LeaveProjectModal.tsx'
import AutoExtensionPill from './creation/AutoExtensionPill.tsx'
import LivePromptModePill from './creation/LivePromptModePill.tsx'
import PresetQuickLaunchRail from './creation/PresetQuickLaunchRail.tsx'
import ProjectCreationConfigPills from './creation/ProjectCreationConfigPills.tsx'
import type { ChatBarProps } from '@dreamverse/ui-kit/contracts.ts'
import { cn } from '@dreamverse/ui-kit/utils.ts'

const PROMPT_MAX_LENGTH = 500

type Props = ChatBarProps

/** Display project prompts, connection notices, and departure controls. */
export default function ChatBar({
  children,
  referencePicker,
  mentionOptions = [],
  promptLabel,
  promptDisabled,
  allowEmptyPrompt = false,
  projectStarted = false,
  rewriteMode = true,
  onRewriteModeChange,
  generationRoundBusy = false,
  autoExtensionEnabled = false,
  autoExtensionRequested = false,
  canChooseAutoExtension = false,
  onAutoExtensionRequestChange,
  onStopGeneration,
  isGenerating = false,
  storyPresets = [],
  continuationDraft = '',
  canStartProject = false,
  canSubmitContinuation = false,
  connectionClosed = false,
  projectNotice = '',
  projectResetPending = false,
  onPresetGenerate = () => {},
  onContinuationInput = () => {},
  onContinuationKeydown = () => {},
  onGenerate = () => {},
  onSubmitContinuation = () => {},
  onLeave,
  onStartNewProject = () => {},
  onReconnect,
  projectCreationConfig = null,
  configPillsReadOnly = false,
  onProjectModelChange,
  onProjectModeChange,
  onProjectAspectRatioChange,
  onProjectResolutionChange,
}: Props) {
  const [leaveModalOpen, setLeaveModalOpen] = useState(false)
  const showSpinner = generationRoundBusy
  const isBusy = generationRoundBusy || autoExtensionEnabled || projectResetPending || (!projectStarted && isGenerating)
  // A parent supplying its own control row owns the opt-in pill, so ChatBar only
  // renders it beside the project pills that ChatBar lays out itself.
  const showAutoExtensionPill = Boolean(onAutoExtensionRequestChange) && !isBusy && !children
  const showLivePromptModePill = projectStarted && Boolean(onRewriteModeChange)
  const messagePlaceholder = projectResetPending
    ? 'Starting new project\u2026'
    : isBusy
      ? 'Generating video\u2026'
      : !projectStarted
        ? 'Describe your video or mention elements'
        : rewriteMode ? 'What do you want to edit?' : 'Describe what happens next'
  const actionLabel = !projectStarted ? 'Generate' : rewriteMode ? 'Rewrite rollout' : 'Continue video'

  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [mentionStart, setMentionStart] = useState<number | null>(null)
  const [mentionQuery, setMentionQuery] = useState('')
  const filteredMentions = useMemo(() => mentionOptions.filter(option =>
    `${option.label} ${option.description ?? ''}`.toLowerCase().includes(mentionQuery.toLowerCase())).slice(0, 6), [mentionOptions, mentionQuery])
  function updateMentionState(value: string, cursor: number) {
    const query = value.slice(0, cursor).match(/(?:^|\s)@([^\s]*)$/)?.[1]
    setMentionStart(query === undefined ? null : cursor - query.length - 1)
    setMentionQuery(query ?? '')
  }
  /** Insert a preset mention into the shared prompt without submitting the request. */
  function insertMention(option: MentionOption) {
    if (mentionStart === null) return
    const end = inputRef.current?.selectionStart ?? continuationDraft.length
    const value = `${continuationDraft.slice(0, mentionStart)}@${option.label} ${continuationDraft.slice(end)}`.slice(0, PROMPT_MAX_LENGTH)
    onContinuationInput(value)
    setMentionStart(null)
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  useEffect(() => {
    if (!isBusy && !window.matchMedia('(pointer: coarse)').matches) {
      inputRef.current?.focus()
    }
  }, [isBusy, projectStarted])

  const autoResize = useCallback(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 20
    const maxHeight = lineHeight * 3
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden'
  }, [])

  useEffect(() => {
    autoResize()
  }, [continuationDraft, autoResize])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.nativeEvent.isComposing) return
      const firstMention = filteredMentions[0]
      if (mentionStart !== null && firstMention && (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey))) {
        e.preventDefault()
        insertMention(firstMention)
        return
      }
      if (e.key === 'Escape') setMentionStart(null)
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        if (!projectStarted) {
          if (canStartProject && !isGenerating && (allowEmptyPrompt || continuationDraft.trim())) {
            onGenerate()
          }
        } else {
          onContinuationKeydown(e)
        }
        return
      }
      onContinuationKeydown(e)
    },
    [
      onContinuationKeydown, projectStarted, canStartProject, isGenerating, continuationDraft, onGenerate, allowEmptyPrompt,
      mentionStart, filteredMentions,
    ],
  )

  if (connectionClosed) {
    return (
      <section className="mx-auto flex w-full max-w-2xl shrink-0 flex-col gap-4">
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-border bg-card/80 px-8 py-5 text-center shadow-md backdrop-blur-sm">
          <div className="flex flex-col gap-1">
            <p className="text-sm font-semibold text-foreground">Project disconnected</p>
            <p className="max-w-xs text-xs text-muted-foreground">{projectNotice || (onReconnect ? 'Reconnect to continue this project.' : 'Start a new project to continue.')}</p>
          </div>
          <div className="mt-1 flex items-center gap-2">
            {onReconnect && (
              <Button onClick={onReconnect} size="sm" className="rounded-full px-5">
                Reconnect
              </Button>
            )}
            <Button onClick={onStartNewProject} variant={onReconnect ? 'outline' : 'default'} size="sm" className="rounded-full px-5">
              New Project
            </Button>
            <a href="https://docs.google.com/forms/d/e/1FAIpQLSe5zpO1iD8Ds-Ih-fOLm64qd7YZVvuvAyHuJaAfw1hkRHTe_A/viewform?usp=publish-editor" target="_blank" rel="noopener noreferrer">
              <Button variant="outline" size="sm" className="rounded-full px-5">
                Join Waitlist
              </Button>
            </a>
          </div>
        </div>
      </section>
    )
  }

  return (
    <section className="mx-auto flex w-full max-w-2xl shrink-0 flex-col gap-4">
      {!projectStarted && storyPresets.length > 0 && (
        <PresetQuickLaunchRail storyPresets={storyPresets} disabled={isGenerating} onPresetGenerate={onPresetGenerate} />
      )}

      {projectNotice && (
        <div
          className={cn(
            'rounded-xl px-4 py-2.5 text-center text-xs',
            projectStarted
              ? 'border border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-400'
              : 'border border-rose-500/20 bg-rose-500/10 text-rose-700 dark:text-rose-300',
          )}
        >
          {projectNotice}
        </div>
      )}

      {projectResetPending && projectStarted && (
        <div className="rounded-xl border border-sky-500/20 bg-sky-500/10 px-4 py-2.5 text-center text-xs text-sky-700 dark:text-sky-300">
          Saving received clips before starting a new project.
        </div>
      )}

      <div
        className={cn(
          'flex min-w-0 flex-col gap-2 rounded-4xl border py-2.5 pl-5 pr-2.5 shadow-md backdrop-blur-sm transition-all duration-200',
          isBusy ? 'border-input/60 bg-card/40' : 'border-input bg-card/65',
        )}
      >
        {autoExtensionEnabled && onStopGeneration && (
          <div className="flex flex-wrap items-center gap-3 pr-3 text-xs text-muted-foreground">
            <Button variant="outline" size="sm" onClick={onStopGeneration} disabled={projectResetPending}>
              Stop generation
            </Button>
            <span>Finishes the current round.</span>
          </div>
        )}
        {generationRoundBusy && !autoExtensionEnabled && (
          <p className="pr-3 text-xs text-muted-foreground">Generation finishes before the next prompt.</p>
        )}
        {(showAutoExtensionPill || showLivePromptModePill || (projectStarted && projectCreationConfig)) && (
          <div className="flex flex-wrap items-center gap-1.5">
            {projectStarted && projectCreationConfig && (
              <ProjectCreationConfigPills
                {...projectCreationConfig}
                disabled={isBusy}
                readOnly={configPillsReadOnly}
                onModelChange={onProjectModelChange}
                onModeChange={onProjectModeChange}
                onAspectRatioChange={onProjectAspectRatioChange}
                onResolutionChange={onProjectResolutionChange}
              />
            )}
            {showLivePromptModePill && onRewriteModeChange && (
              <LivePromptModePill rewrite={rewriteMode} disabled={isBusy} onChange={onRewriteModeChange} />
            )}
            {showAutoExtensionPill && (
              <AutoExtensionPill requested={autoExtensionRequested}
                disabled={!canChooseAutoExtension}
                onChange={onAutoExtensionRequestChange} />
            )}
          </div>
        )}
        <div className="relative flex min-w-0 flex-wrap items-center gap-1.5">
          {referencePicker && <ReferencePicker {...referencePicker} />}
          <textarea
            ref={inputRef}
            id="continuation-prompt"
            aria-label={promptLabel ?? (projectStarted ? 'Continuation prompt' : 'Initial prompt')}
            value={continuationDraft}
            onChange={(event) => {
              onContinuationInput(event.target.value)
              updateMentionState(event.target.value, event.target.selectionStart)
            }}
            onKeyDown={handleKeyDown}
            placeholder={messagePlaceholder}
            maxLength={PROMPT_MAX_LENGTH}
            disabled={promptDisabled ?? isBusy}
            rows={1}
            className={cn(
              'min-w-0 flex-1 resize-none bg-transparent text-foreground outline-none placeholder:text-muted-foreground transition-opacity duration-200 scrollbar-thin leading-snug',
              isBusy && 'cursor-not-allowed opacity-50',
            )}
          />
          {mentionStart !== null && filteredMentions.length > 0 && <div className="absolute left-0 top-full z-20 rounded-xl border border-border bg-popover p-2">
            <p className="px-3 text-xs">Mention</p>
            {filteredMentions.map(option => <button type="button" key={option.id} className="block px-3 py-2 text-sm" onMouseDown={(event) => { event.preventDefault(); insertMention(option) }}>{option.label}</button>)}
          </div>}
          {!projectStarted ? (
            <Button
              aria-label={actionLabel}
              title={actionLabel}
              onClick={onGenerate}
              disabled={!canStartProject || isGenerating || (!allowEmptyPrompt && !continuationDraft.trim())}
              size="icon-sm"
              className="shrink-0 rounded-full"
            >
              {showSpinner ? <Loader2 className="size-5 animate-spin" /> : <ArrowUp className="size-5" />}
            </Button>
          ) : (
            <>
              <Button
                aria-label={actionLabel}
                title={actionLabel}
                onClick={onSubmitContinuation}
                disabled={!canSubmitContinuation || autoExtensionEnabled || showSpinner || projectResetPending || !continuationDraft.trim()}
                size="icon-sm"
                className="shrink-0 rounded-full"
              >
                {showSpinner ? <Loader2 className="size-5 animate-spin" /> : <ArrowUp className="size-5" />}
              </Button>
              {onLeave && <Button variant="outline" aria-label="Leave" title="Leave" onClick={() => { if (shouldShowLeaveWarning()) setLeaveModalOpen(true); else onLeave() }} disabled={isGenerating || projectResetPending} size="icon-sm" className="shrink-0 rounded-full">
                <X className="size-5" />
              </Button>}
            </>
          )}
        </div>
        {children}
      </div>
      <p className="px-2 text-center text-[11px] text-muted-foreground">
        LLM powered by{' '}
        <a
          href="https://ifm.ai/k2/"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 font-medium text-foreground/80 transition-colors hover:text-foreground"
        >
          <span>K2-V2</span>
          <img
            src="/k2.png"
            alt=""
            aria-hidden="true"
            width={14}
            height={14}
            className="h-3.5 w-auto opacity-80"
          />
        </a>
      </p>
      <LeaveProjectModal
        open={leaveModalOpen}
        onClose={() => { setLeaveModalOpen(false) }}
        onConfirmLeave={() => { setLeaveModalOpen(false); onLeave?.() }}
      />
    </section>
  )
}
