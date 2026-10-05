/**
 * Browser state the DreamVerse shell shares between its center panel and its left navigator: the open project, the
 * center view, the selected Tool session, the main chat session, and the project ↔ Workspace links read from
 * `/api/vh/workspaces`. Both components live in this one bundle, so a module-level store is enough.
 *
 * The location (project, view, Tool session, navigator list, chat session) is mirrored into the URL hash, for example
 * `#project=<id>&view=cuts&session=<id>`, so a reload restores it. Every change of the open project is published to
 * the other DreamVerse bundles through `publishCurrentProject`.
 *
 * @module @video-harness/ui-shell/store
 */
import { useSyncExternalStore } from 'react'
import { publishCurrentEpisode } from '@video-harness/ui-kit/current-episode.ts'
import { publishCurrentProject } from '@video-harness/ui-kit/current-project.ts'

/** One project as `/api/vh/workspaces` lists it. */
export interface ProjectLink {
  projectId: string
  title: string
  createdAt: string
  /** The project's directory, which is its Workspace's directory. */
  path: string
  /** The recorded Workspace, or null before one was created. */
  workspaceId: string | null
}

/** The `/api/vh/workspaces` answer. */
export interface Links {
  entryPath: string
  projects: ProjectLink[]
  /** Saved agent session → project bindings. */
  bindings: Record<string, string>
}

/** The project list before the links arrive; one instance so selectors return a stable value. */
export const NO_PROJECTS: ProjectLink[] = []

/** What the shell components share. */
export interface ShellState {
  /** The main session, as the center panel last saw it. */
  sessionId: string | undefined
  /** The project open in the center, or null on the entry page. The main session follows it. */
  projectId: string | null
  /** The center view while a project is open. */
  view: 'canvas' | 'cuts'
  /** The Tool session shown in the center instead of the canvas or cuts, or null. */
  toolSession: string | null
  /** Which list the navigator shows under each project. */
  list: 'chat' | 'tool'
  /** The cuts episode selected in the open project, or null before the cuts editor or the URL names one. */
  episode: string | null
  links: Links | null
}

/** The location fields of the URL hash. */
export interface ShellLocation {
  projectId: string | null
  view: 'canvas' | 'cuts'
  toolSession: string | null
  list: 'chat' | 'tool'
  episode: string | null
  sessionId: string | undefined
}

/**
 * Parse the URL hash.
 * @param hash - `location.hash`.
 * @returns the location it names; missing fields take the entry-page values.
 */
export function parseLocation(hash: string): ShellLocation {
  const params = new URLSearchParams(hash.replace(/^#/, ''))
  return {
    projectId: params.get('project'),
    view: params.get('view') === 'cuts' ? 'cuts' : 'canvas',
    toolSession: params.get('tool'),
    list: params.get('list') === 'tool' ? 'tool' : 'chat',
    episode: params.get('ep'),
    sessionId: params.get('session') ?? undefined,
  }
}

/**
 * Format a location as a URL hash; the entry page has no hash.
 * @param location - the location.
 * @returns `#project=…` with the non-default fields, or the empty string.
 */
export function formatLocation(location: ShellLocation): string {
  const params = new URLSearchParams()
  if (location.projectId !== null) {
    params.set('project', location.projectId)
    if (location.view !== 'canvas') params.set('view', location.view)
    if (location.toolSession !== null) params.set('tool', location.toolSession)
    if (location.episode !== null) params.set('ep', location.episode)
  }
  if (location.sessionId !== undefined) params.set('session', location.sessionId)
  if (location.list !== 'chat') params.set('list', location.list)
  const text = params.toString()
  return text === '' ? '' : `#${text}`
}

/** The location the page was loaded with, which the center restores once the client lists are ready. */
export const initialLocation: ShellLocation = parseLocation(window.location.hash)
// The cuts view mounts from this state before the restore runs, so the URL's episode is published right away.
if (initialLocation.projectId !== null && initialLocation.episode !== null) {
  publishCurrentEpisode(initialLocation.projectId, initialLocation.episode)
}

// The main session is unknown until the center panel reports it; the URL's session is a restore target only.
let state: ShellState = { ...initialLocation, sessionId: undefined, links: null }
const listeners = new Set<() => void>()
publishCurrentProject(state.projectId)

/** Whether the next main-session change is a user's session choice, which gets its own browser history entry. */
let sessionChoice = false
/** Whether the shell is applying a location from the URL, which must not add browser history entries. */
let applyingUrl = false
/**
 * Whether the shell state is mirrored into the URL. Until the page-load restore runs, the URL keeps what the user
 * opened or typed (a hash edited during startup included), so the restore reads it.
 */
let mirrorUrl = false

/** Start mirroring the shell state into the URL; the page-load restore calls this before it applies the URL. */
export function startUrlMirror(): void {
  mirrorUrl = true
}

/** Mark the next main-session change as the user's choice, so browser Back returns to the previous session. */
export function markSessionChoice(): void {
  sessionChoice = true
}

/**
 * Run navigation that applies a location the URL already names (reload, Back, Forward, an edited hash), so the hash
 * writes it causes replace the current history entry.
 * @param apply - the navigation; its synchronous part runs inside the scope.
 */
export function applyingLocation(apply: () => void): void {
  applyingUrl = true
  try {
    apply()
  } finally {
    applyingUrl = false
  }
}

/**
 * Merge fields into the shared state, mirror the location into the URL hash, publish a changed open project, and
 * notify subscribers when something changed. A change of project, center view, or Tool session, and a session the
 * user chose, add a browser history entry; other changes (a session the shell opened for a project, the episode, the
 * navigator list) replace the current entry.
 * @param patch - the fields to set.
 */
export function setShell(patch: Partial<ShellState>): void {
  const next = { ...state, ...patch }
  // An episode belongs to its project.
  if (next.projectId !== state.projectId && patch.episode === undefined) next.episode = null
  if ((Object.keys(next) as Array<keyof ShellState>).every(key => Object.is(next[key], state[key]))) return
  const previous = state
  state = next
  const hash = formatLocation(next)
  if (mirrorUrl && (hash !== formatLocation(previous) || hash !== window.location.hash)) {
    const moved = next.projectId !== previous.projectId || next.view !== previous.view || next.toolSession !== previous.toolSession
      || (sessionChoice && next.sessionId !== previous.sessionId)
    const url = `${window.location.pathname}${window.location.search}${hash}`
    if (moved && !applyingUrl && hash !== window.location.hash) window.history.pushState(null, '', url)
    else window.history.replaceState(window.history.state, '', url)
  }
  if (next.sessionId !== previous.sessionId) sessionChoice = false
  if (next.projectId !== previous.projectId) publishCurrentProject(next.projectId)
  for (const listener of listeners) listener()
}

/** @returns the current shared state. */
export function getShell(): ShellState {
  return state
}

/**
 * Select a value of the shared state and re-render when it changes.
 * @param select - the selector.
 * @returns the selected value.
 */
export function useShell<T>(select: (value: ShellState) => T): T {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    () => select(state),
  )
}

/**
 * Fetch `/api/vh/workspaces` into the shared state.
 * @returns the links.
 */
export async function refreshLinks(): Promise<Links> {
  const response = await fetch('/api/vh/workspaces')
  const links = await response.json() as Links
  setShell({ links })
  return links
}

/**
 * GET JSON from a views route.
 * @param path - the route with its query.
 * @returns the parsed answer.
 */
export async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path)
  const parsed: unknown = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error((parsed as { error?: string }).error ?? `HTTP ${String(response.status)}`)
  return parsed as T
}

/**
 * POST JSON to a views route.
 * @param path - the route.
 * @param body - the JSON body.
 * @returns the parsed answer.
 */
export async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const parsed: unknown = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error((parsed as { error?: string }).error ?? `HTTP ${String(response.status)}`)
  return parsed as T
}

/**
 * The project a session works on: its saved binding, else the project whose Workspace holds it.
 * @param links - the links.
 * @param sessionId - the session.
 * @param workspace - the session's Workspace, when known.
 * @returns the project ID, and whether it came only from the Workspace so the binding still has to be saved.
 */
export function projectOfSession(
  links: Links | null,
  sessionId: string | undefined,
  workspace: { workspaceId: string; path: string } | undefined,
): { projectId: string | null; needsBind: boolean } {
  if (links === null || sessionId === undefined) return { projectId: null, needsBind: false }
  const fromWorkspace = workspace === undefined
    ? undefined
    : links.projects.find(p => p.workspaceId === workspace.workspaceId || p.path === workspace.path)?.projectId
  const bound = links.bindings[sessionId]
  if (bound !== undefined) return { projectId: bound, needsBind: false }
  return { projectId: fromWorkspace ?? null, needsBind: fromWorkspace !== undefined }
}
