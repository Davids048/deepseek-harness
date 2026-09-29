/**
 * Port of the reference `dreamverse/routes/health.py` liveness and readiness routes: `GET /health` and `/healthz`
 * report the harness process, and `GET /readyz` reports the generation backend's readiness without GPU counts.
 *
 * @module @dreamverse/browser-server/health-routes
 */
import type { ServerResponse } from 'node:http'
import type { Logger } from '@deepseek-ai/cordis'
import type { DreamverseGeneration } from './dependencies.ts'
import { sendJson } from './http.ts'

/** The reference `service` field of the health and readiness payloads. */
const SERVICE_NAME = 'ltx2-streaming-backend'

/** The `/readyz` detail when the generation backend does not answer. */
export const BACKEND_UNREACHABLE_DETAIL = 'Generation backend is unreachable.'

/**
 * The reference `_utc_now_iso()`: Python `datetime.now(timezone.utc).isoformat()`, which omits the fraction when
 * the microseconds are zero.
 * @returns the current UTC time, such as `2026-09-28T21:28:00.123000+00:00`.
 */
export function utcNowIso(): string {
  const now = new Date()
  const seconds = now.toISOString().slice(0, 19)
  const milliseconds = now.getUTCMilliseconds()
  return `${seconds}${milliseconds === 0 ? '' : `.${String(milliseconds * 1000).padStart(6, '0')}`}+00:00`
}

/**
 * Serve `GET /health` and `GET /healthz`.
 * @param response - the browser response.
 */
export function getHealthz(response: ServerResponse): void {
  sendJson(response, 200, { status: 'ok', service: SERVICE_NAME, ts: utcNowIso() })
}

/**
 * Serve `GET /readyz`: 200 when the generation backend reports ready, otherwise 503 with the backend's detail or
 * the unreachable detail.
 * @param response - the browser response.
 * @param generation - the generation backend client.
 * @param logger - receives the failure of an unreachable backend.
 */
export async function getReadyz(response: ServerResponse, generation: DreamverseGeneration, logger: Logger): Promise<void> {
  let readiness: { ready: boolean; detail: string | null }
  try {
    readiness = await generation.ready()
  } catch (error) {
    logger.warn(error)
    readiness = { ready: false, detail: BACKEND_UNREACHABLE_DETAIL }
  }
  if (readiness.ready) {
    sendJson(response, 200, { status: 'ready', service: SERVICE_NAME, ts: utcNowIso() })
    return
  }
  sendJson(response, 503, { status: 'warming', service: SERVICE_NAME, ts: utcNowIso(), detail: readiness.detail })
}
