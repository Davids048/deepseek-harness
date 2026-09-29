/**
 * Reproduce `response.model_dump(mode="json")` of the chat-completion model that a vendor SDK builds from HTTP JSON.
 *
 * The reference keeps that dump as `VendorReply.raw_response`, and rollout diagnostics embed its JSON text. Both SDKs
 * build responses with `construct_type`: a model is constructed without validation, so every declared field appears
 * in declared order, a missing or `null` field becomes `None`, and undeclared keys follow unchanged as extra fields.
 * A union-typed field, including every `Optional` field, is first validated with pydantic's lax rules; only a value
 * that fails validation is constructed, through the SDK discriminator or else the first variant. Model layouts come
 * from `sdk-response-models.ts`, which `scripts/generate_sdk_response_models.py` derives from the installed SDKs.
 * JSON-mode serialization keeps a value that does not match its declared type, except that an `int` field writes a
 * bool as 0 or 1.
 *
 * @module @dreamverse/prompt-enhancer/llm/sdk-response
 */
import {
  PythonFloat, dictGet, isJsonObject, stripWhitespace, toPythonFloat, type JsonObject, type JsonValue,
} from '../utils/python-text.ts'
import { SDK_RESPONSE_MODELS } from './sdk-response-models.ts'

/** A field annotation of an SDK response model. */
export type SdkType =
  | { readonly kind: 'str' | 'int' | 'float' | 'bool' | 'none' }
  | { readonly kind: 'literal'; readonly values: readonly string[] }
  | { readonly kind: 'list'; readonly item: SdkType }
  | { readonly kind: 'dict'; readonly value: SdkType }
  | { readonly kind: 'model'; readonly name: string }
  | {
    readonly kind: 'union'
    readonly variants: readonly SdkType[]
    /** The SDK's `PropertyInfo(discriminator=...)` field and the model constructed for each of its values. */
    readonly discriminator?: { readonly field: string; readonly mapping: Readonly<Record<string, string>> }
  }

/** One model's declared fields in pydantic order as `[name, type, required]`. */
export type SdkModel = readonly (readonly [name: string, type: SdkType, required: boolean])[]

/** Marks a value that pydantic's lax validation rejects. */
const INVALID = Symbol('invalid')
type Validated = JsonValue | typeof INVALID

/** Numeric text that pydantic 2.11 accepts for `int`: digits with single underscores and optional `.0` zeros. */
const PYDANTIC_INT_TEXT = /^([+-]?\d(?:_?\d)*)(?:\.0+)?$/
/** Text that pydantic accepts for `bool`, compared after lowercasing. */
const PYDANTIC_TRUE_TEXT = new Set(['1', 'on', 't', 'true', 'y', 'yes'])
const PYDANTIC_FALSE_TEXT = new Set(['0', 'off', 'f', 'false', 'n', 'no'])
/** Magnitude limit of float inputs that pydantic converts to `int`. */
const PYDANTIC_INT_FLOAT_LIMIT = 2 ** 63

/**
 * Look up a generated model layout.
 * @param name - the generated model name.
 * @returns the declared fields.
 */
function modelLayout(name: string): SdkModel {
  const model = SDK_RESPONSE_MODELS[name]
  if (model === undefined) throw new TypeError(`Unknown SDK response model: ${name}`)
  return model
}

/**
 * Append the keys of `source` that the model does not declare, in input order, as pydantic stores extra fields.
 * @param target - the dump that already holds the declared fields.
 * @param source - the input object.
 * @param model - the model layout.
 * @returns `target`.
 */
function appendExtraFields(target: JsonObject, source: JsonObject, model: SdkModel): JsonObject {
  const declared = new Set(model.map(([name]) => name))
  for (const [key, item] of Object.entries(source)) {
    if (!declared.has(key)) target[key] = item
  }
  return target
}

/** Convert a value like pydantic's lax `int` validation. */
function laxInt(value: JsonValue): Validated {
  if (typeof value === 'boolean') return Number(value)
  if (typeof value === 'number') return Number.isInteger(value) ? value : INVALID
  if (value instanceof PythonFloat) {
    const number = value.value
    if (!Number.isInteger(number) || Math.abs(number) >= PYDANTIC_INT_FLOAT_LIMIT) return INVALID
    return number === 0 ? 0 : number
  }
  if (typeof value !== 'string') return INVALID
  const match = PYDANTIC_INT_TEXT.exec(stripWhitespace(value))
  if (match === null) return INVALID
  const number = Number((match[1] ?? '').replaceAll('_', ''))
  return number === 0 ? 0 : number
}

/** Convert a value like pydantic's lax `float` validation. */
function laxFloat(value: JsonValue): Validated {
  if (value instanceof PythonFloat) return value
  if (typeof value === 'number' || typeof value === 'boolean') return new PythonFloat(Number(value))
  if (typeof value !== 'string') return INVALID
  const number = toPythonFloat(value)
  return number === undefined ? INVALID : new PythonFloat(number)
}

/** Convert a value like pydantic's lax `bool` validation. */
function laxBool(value: JsonValue): Validated {
  if (typeof value === 'boolean') return value
  const number = value instanceof PythonFloat ? value.value : value
  if (typeof number === 'number') return number === 0 ? false : number === 1 ? true : INVALID
  if (typeof number !== 'string') return INVALID
  const text = number.toLowerCase()
  if (PYDANTIC_TRUE_TEXT.has(text)) return true
  return PYDANTIC_FALSE_TEXT.has(text) ? false : INVALID
}

/**
 * Validate a model like pydantic with `extra="allow"`: every present field must validate and every required field
 * must be present.
 * @param value - the input value.
 * @param name - the model name.
 * @returns the model dump, or `INVALID`.
 */
function validateModel(value: JsonValue, name: string): Validated {
  if (!isJsonObject(value)) return INVALID
  const model = modelLayout(name)
  const dump: JsonObject = {}
  for (const [field, type, required] of model) {
    const item = dictGet(value, field)
    if (item === undefined) {
      if (required) return INVALID
      dump[field] = null
      continue
    }
    const validated = validate(item, type)
    if (validated === INVALID) return INVALID
    dump[field] = validated
  }
  return appendExtraFields(dump, value, model)
}

/**
 * Validate a value against a type with pydantic 2.11's lax rules; a union takes its first valid variant.
 * @param value - the input value.
 * @param type - the declared type.
 * @returns the validated value in dump form, or `INVALID`.
 */
function validate(value: JsonValue, type: SdkType): Validated {
  switch (type.kind) {
    case 'str':
      return typeof value === 'string' ? value : INVALID
    case 'int':
      return laxInt(value)
    case 'float':
      return laxFloat(value)
    case 'bool':
      return laxBool(value)
    case 'none':
      return value === null ? null : INVALID
    case 'literal':
      return typeof value === 'string' && type.values.includes(value) ? value : INVALID
    case 'list': {
      if (!Array.isArray(value)) return INVALID
      const items: JsonValue[] = []
      for (const item of value) {
        const validated = validate(item, type.item)
        if (validated === INVALID) return INVALID
        items.push(validated)
      }
      return items
    }
    case 'dict': {
      if (!isJsonObject(value)) return INVALID
      const entries: JsonObject = {}
      for (const [key, item] of Object.entries(value)) {
        const validated = validate(item, type.value)
        if (validated === INVALID) return INVALID
        entries[key] = validated
      }
      return entries
    }
    case 'model':
      return validateModel(value, type.name)
    case 'union':
      for (const variant of type.variants) {
        const validated = validate(value, variant)
        if (validated !== INVALID) return validated
      }
      return INVALID
  }
}

/**
 * Construct a model like the SDKs' `BaseModel.construct`: declared fields in order, `None` for missing or `null`
 * fields, then extra fields.
 * @param value - the input object.
 * @param name - the model name.
 * @returns the model dump.
 */
function constructModel(value: JsonObject, name: string): JsonObject {
  const model = modelLayout(name)
  const dump: JsonObject = {}
  for (const [field, type] of model) {
    const item = dictGet(value, field)
    dump[field] = item === undefined || item === null ? null : construct(item, type)
  }
  return appendExtraFields(dump, value, model)
}

/**
 * Build a value like the SDKs' `construct_type`, which returns a value unchanged when it does not match the type.
 * @param value - the input value.
 * @param type - the declared type.
 * @returns the value in dump form.
 */
function construct(value: JsonValue, type: SdkType): JsonValue {
  switch (type.kind) {
    case 'union': {
      const validated = validate(value, type)
      if (validated !== INVALID) return validated
      const discriminator = type.discriminator
      if (discriminator !== undefined && isJsonObject(value)) {
        const variantValue = dictGet(value, discriminator.field)
        if (typeof variantValue === 'string' && variantValue && Object.hasOwn(discriminator.mapping, variantValue)) {
          return construct(value, { kind: 'model', name: discriminator.mapping[variantValue] ?? '' })
        }
      }
      // Constructing the first variant never fails, so the SDK's variant loop stops there.
      const [firstVariant] = type.variants
      return firstVariant === undefined ? value : construct(value, firstVariant)
    }
    case 'dict':
      if (!isJsonObject(value)) return value
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, construct(item, type.value)]))
    case 'model':
      if (Array.isArray(value)) return value.map(entry => isJsonObject(entry) ? constructModel(entry, type.name) : entry)
      return isJsonObject(value) ? constructModel(value, type.name) : value
    case 'list':
      return Array.isArray(value) ? value.map(entry => construct(entry, type.item)) : value
    case 'float':
      // An int, including a bool, becomes the equal float.
      return typeof value === 'boolean' || typeof value === 'number' ? new PythonFloat(Number(value)) : value
    case 'int':
      // Construction keeps a bool, but the JSON-mode int serializer writes it as 0 or 1 because bool is an int.
      return typeof value === 'boolean' ? Number(value) : value
    case 'str':
    case 'bool':
    case 'none':
    case 'literal':
      return value
  }
}

/**
 * Reproduce the SDK model dump for a decoded response body.
 * @param body - the response JSON decoded with `parsePythonJson`.
 * @param type - the SDK's response type.
 * @returns the value that `response.model_dump(mode="json")` returns in the reference.
 */
export function dumpSdkResponse(body: JsonValue, type: SdkType): JsonValue {
  return construct(body, type)
}
