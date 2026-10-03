/**
 * Port of the reference `dreamverse/routes/creation.py`: `GET /creation-capabilities` reports the served model's
 * creation choices, the segment counts, and the asset upload policy for the browser's creation form.
 *
 * @module @dreamverse/project-controller/creation-route
 */
import type { ServerResponse } from 'node:http'
import type { Logger } from '@deepseek-ai/cordis'
import { sendJson } from '@dreamverse/http-routes'
import { lobbyCapabilitiesAsDict } from '@dreamverse/segment-generation'
import type { DreamverseAssetsManager, DreamverseGeneration, ModelFacts } from './dependencies.ts'
import { BACKEND_UNREACHABLE_DETAIL } from './health-routes.ts'

/**
 * Serve `GET /creation-capabilities`; an unreachable generation backend answers 503 with `detail`.
 * @param response - the browser response.
 * @param generation - the generation backend client.
 * @param assets - the asset library.
 * @param logger - receives the failure of an unreachable backend.
 */
export async function getCreationCapabilities(
  response: ServerResponse,
  generation: DreamverseGeneration,
  assets: DreamverseAssetsManager,
  logger: Logger,
): Promise<void> {
  let model: ModelFacts
  try {
    model = await generation.model()
  } catch (error) {
    logger.warn(error)
    sendJson(response, 503, { detail: BACKEND_UNREACHABLE_DETAIL })
    return
  }
  sendJson(response, 200, lobbyCapabilitiesAsDict(model, assets.uploadPolicy()))
}
