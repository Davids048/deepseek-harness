/**
 * Port of the reference `prompt_config_router` (`dreamverse/routes/presets.py`): `GET` and `POST
 * /prompt-system-config`, including FastAPI's request-body validation, status codes, and `{"detail": ...}` bodies.
 *
 * @module @dreamverse/browser-server/prompt-config-route
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { PromptRuntimeError, PromptValueError } from '@dreamverse/prompt-enhancer'
import type { DreamversePromptEnhancer, PromptConfigUpdate } from './dependencies.ts'
import { bodyObject, decodeJsonBody, sendInternalServerError, sendJson, type ValidationIssue } from './http.ts'

/** `PromptConfigUpdateRequest` string fields in declaration order, which is also the pydantic error order. */
const STRING_FIELDS = [
  'next_segment_system_prompt',
  'auto_extension_system_prompt',
  'rewrite_window_system_prompt',
  'rewrite_user_system_prompt',
  'ref2va_system_prompt',
  'rewrite_model',
] as const

/** A decimal or exponent number string, the forms pydantic's lax float parsing accepts after trimming. */
const NUMBER_STRING = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i

/**
 * Validate a JSON object body against `PromptConfigUpdateRequest` with pydantic's lax rules.
 * @returns the update with `null` for absent fields, or every validation issue in field order.
 */
function validateUpdate(body: Record<string, unknown>): { update: PromptConfigUpdate } | { issues: ValidationIssue[] } {
  const update: PromptConfigUpdate = {
    next_segment_system_prompt: null,
    auto_extension_system_prompt: null,
    rewrite_window_system_prompt: null,
    rewrite_user_system_prompt: null,
    ref2va_system_prompt: null,
    rewrite_model: null,
    rewrite_temperature: null,
  }
  const issues: ValidationIssue[] = []
  for (const field of STRING_FIELDS) {
    const input = body[field]
    if (input === undefined || input === null) continue
    if (typeof input === 'string') update[field] = input
    else issues.push({ type: 'string_type', loc: ['body', field], msg: 'Input should be a valid string', input })
  }
  const temperature = body.rewrite_temperature
  if (typeof temperature === 'number' || typeof temperature === 'boolean') {
    update.rewrite_temperature = Number(temperature)
  } else if (typeof temperature === 'string') {
    if (NUMBER_STRING.test(temperature.trim())) update.rewrite_temperature = Number(temperature.trim())
    else issues.push({ type: 'float_parsing', loc: ['body', 'rewrite_temperature'], msg: 'Input should be a valid number, unable to parse string as a number', input: temperature })
  } else if (temperature !== undefined && temperature !== null) {
    issues.push({ type: 'float_type', loc: ['body', 'rewrite_temperature'], msg: 'Input should be a valid number', input: temperature })
  }
  return issues.length > 0 ? { issues } : { update }
}

/**
 * Serve `GET /prompt-system-config`.
 * @param response - the browser response.
 * @param enhancer - the prompt enhancer that owns the configuration.
 */
export function getPromptSystemConfig(response: ServerResponse, enhancer: DreamversePromptEnhancer): void {
  sendJson(response, 200, enhancer.getPromptConfig())
}

/**
 * Serve `POST /prompt-system-config`: validate the body, save the prompt configuration, and map
 * `PromptValueError` to 400 and `PromptRuntimeError` to 500 with `detail`.
 * @param request - the browser request.
 * @param response - the browser response.
 * @param enhancer - the prompt enhancer that owns the configuration.
 */
export async function savePromptSystemConfig(
  request: IncomingMessage,
  response: ServerResponse,
  enhancer: DreamversePromptEnhancer,
): Promise<void> {
  const decoded = await decodeJsonBody(request)
  const object = 'issue' in decoded ? decoded : bodyObject(decoded.value)
  if ('issue' in object) {
    sendJson(response, 422, { detail: [object.issue] })
    return
  }
  const validated = validateUpdate(object.body)
  if ('issues' in validated) {
    sendJson(response, 422, { detail: validated.issues })
    return
  }
  try {
    sendJson(response, 200, enhancer.savePromptConfig(validated.update))
  } catch (error) {
    if (error instanceof PromptValueError) sendJson(response, 400, { detail: error.message })
    else if (error instanceof PromptRuntimeError) sendJson(response, 500, { detail: error.message })
    else sendInternalServerError(response)
  }
}
