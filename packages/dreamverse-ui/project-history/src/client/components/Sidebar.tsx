import React, { useState, useRef, useCallback, useEffect } from 'react'
import { SidePanelCloseFilled } from '@carbon/icons-react'
import { Plus, Trash2, Clock, Film } from 'lucide-react'

import { Button } from '@dreamverse/ui-kit/components/ui/button.tsx'
import { Badge } from '@dreamverse/ui-kit/components/ui/badge.tsx'
import { cn } from '@dreamverse/ui-kit/utils.ts'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ProjectId } from '@dreamverse/project-controller/client/ids.ts'
import type { SidebarProps } from '@dreamverse/ui-kit/contracts.ts'
import type {} from '../locales.ts'

type ProjectHistoryTranslate = TranslateNS<'dreamverse.projectHistory'>

/** Format a past timestamp as elapsed time, or as a date after one week. */
function formatRelativeTime(timestamp: number, t: ProjectHistoryTranslate): string {
  const diff = Date.now() - timestamp
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return t('time.justNow')
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return t('time.minutes', { count: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('time.hours', { count: hours })
  const days = Math.floor(hours / 24)
  if (days < 7) return t('time.days', { count: days })
  return new Date(timestamp).toLocaleDateString()
}

/** Show the current project and the harness project list with their selection and departure actions. */
export default function Sidebar({
  open = false,
  currentProjectId = null,
  currentProjectLabel = '',
  hasCurrentProject = false,
  connectionClosed = false,
  projectResetPending = false,
  projects = [],
  notice = '',
  onClose = () => {},
  onSelectProject = () => {},
  onDeleteProject = () => {},
  onNewProject = () => {},
  onOpenAssets = () => {},
  t,
}: SidebarProps & { t: ProjectHistoryTranslate }) {
  const previousProjects = currentProjectId ? projects.filter(p => p.project_id !== currentProjectId) : projects

  const [pendingDeleteId, setPendingDeleteId] = useState<ProjectId | null>(null)
  const deleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearPendingDelete = useCallback(() => {
    setPendingDeleteId(null)
    if (deleteTimerRef.current) {
      clearTimeout(deleteTimerRef.current)
      deleteTimerRef.current = null
    }
  }, [])

  useEffect(() => {
    return () => {
      if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current)
    }
  }, [])

  useEffect(() => {
    if (!open) clearPendingDelete()
  }, [open, clearPendingDelete])

  /** Arm deletion on the first click and delete on a second click within three seconds. */
  function handleDeleteClick(e: React.MouseEvent, projectId: ProjectId) {
    e.stopPropagation()
    if (pendingDeleteId === projectId) {
      clearPendingDelete()
      onDeleteProject(projectId)
    } else {
      setPendingDeleteId(projectId)
      if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current)
      deleteTimerRef.current = setTimeout(() => { setPendingDeleteId(null) }, 3000)
    }
  }

  return (
    <>
      <div
        className={cn('fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] transition-opacity duration-200', open ? 'opacity-100' : 'pointer-events-none opacity-0')}
        onClick={onClose}
        aria-hidden="true"
      />

      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex w-[280px] max-w-[calc(100vw-3rem)] flex-col border-r border-border/60 bg-card/95 backdrop-blur-xl transition-transform duration-200 ease-out',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
        aria-label={t('sidebar.label')}
      >
        <div className="flex items-center justify-between px-5 pt-4 pb-2">
          <span className="text-lg font-semibold text-foreground">{t('title')}</span>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label={t('close.label')}>
            <SidePanelCloseFilled size={18} />
          </Button>
        </div>

        <div className="px-4 pb-3">
          <Button
            variant="outline"
            size="sm"
            className="w-full gap-2 rounded-lg font-medium"
            onClick={onNewProject}
            disabled={projectResetPending}
          >
            <Plus className="size-4" />
            {projectResetPending ? t('project.starting') : t('project.new')}
          </Button>
        </div>

        <Button variant="outline" className="mx-4 mb-3" onClick={onOpenAssets}>{t('assets')}</Button>
        {notice && <p role="alert" className="mx-4 mb-3 text-xs text-destructive">{notice}</p>}
        <nav className="flex-1 overflow-y-auto px-3 pb-4">
          {hasCurrentProject && (
            <div className="mb-3">
              <p className="mb-1.5 px-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{t('current')}</p>
              <div className="rounded-xl bg-accent/80 px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <Film className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">{currentProjectLabel || t('project.untitled')}</span>
                </div>
                <div className="mt-1.5 flex items-center gap-1.5">
                  {connectionClosed ? (
                    <Badge variant="secondary" className="rounded-md px-1.5 py-0 text-[10px]">
                      {t('disconnected')}
                    </Badge>
                  ) : (
                    <Badge variant="default" className="rounded-md px-1.5 py-0 text-[10px]">
                      {t('active')}
                    </Badge>
                  )}
                </div>
              </div>
            </div>
          )}

          {previousProjects.length > 0 && (
            <div>
              <p className="mb-1.5 px-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{t('previous')}</p>
              <div className="flex flex-col gap-1">
                {previousProjects.map((project) => {
                  return (
                    <div
                      key={project.project_id}
                      className="group flex items-start gap-2 rounded-xl px-3 py-2.5 transition-colors cursor-pointer hover:bg-accent/40"
                      onClick={() => { onSelectProject(project.project_id) }}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => { if (e.key === 'Enter') onSelectProject(project.project_id) }}
                    >
                      {project.thumbnail_url ? (
                        <img src={project.thumbnail_url} alt="" className="mt-0.5 h-8 w-auto shrink-0 rounded border border-border object-cover" />
                      ) : (
                        <Film className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] font-medium text-foreground">{project.title || t('project.untitled')}</p>
                        <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                          <Clock className="size-3" />
                          <span>{formatRelativeTime(Date.parse(project.updated_at), t)}</span>
                        </div>
                      </div>
                      {pendingDeleteId === project.project_id ? (
                        <button
                          type="button"
                          className="mt-0.5 shrink-0 rounded bg-destructive/15 px-1.5 py-0.5 !text-xs !font-medium text-destructive transition-colors hover:bg-destructive/25"
                          onClick={(e) => { handleDeleteClick(e, project.project_id) }}
                          aria-label={t('delete.confirm.label')}
                        >
                          {t('delete.confirm')}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="mt-0.5 shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                          onClick={(e) => { handleDeleteClick(e, project.project_id) }}
                          aria-label={t('delete.label')}
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {!hasCurrentProject && previousProjects.length === 0 && <p className="px-2 py-4 text-center text-[13px] text-muted-foreground">{t('empty')}</p>}
        </nav>
      </aside>
    </>
  )
}
