import { MessageDataError } from './errors.js'
import type { JsonObject, JsonValue } from './json.js'

/** Catches what a transform's declared type can lie about: Infinity/NaN, a class instance, a cycle. */
export function normalizeEnvelopeData(data: JsonObject): JsonObject {
  return normalize(data, [], new WeakSet()) as JsonObject
}

function fail(path: ReadonlyArray<string>, message: string): MessageDataError {
  return new MessageDataError([{ path: path.join('.'), message }])
}

function normalize(value: JsonValue, path: ReadonlyArray<string>, seen: WeakSet<object>): JsonValue {
  if (value === null || value === true || value === false) return value
  if (Array.isArray(value)) {
    if (seen.has(value)) throw fail(path, 'circular reference')
    seen.add(value)
    const result = value.map((item, index) => normalize(item, [...path, String(index)], seen))
    seen.delete(value)
    return result
  }
  if (isPlainObject(value)) {
    if (seen.has(value)) throw fail(path, 'circular reference')
    seen.add(value)
    const result: JsonObject = {}
    for (const key of Object.keys(value)) {
      const propertyValue = value[key]
      if (propertyValue !== undefined) result[key] = normalize(propertyValue, [...path, key], seen)
    }
    seen.delete(value)
    return result
  }
  const tag = Object.prototype.toString.call(value)
  if (tag === '[object String]') return value
  if (tag === '[object Number]' && Number.isFinite(value)) return value
  let detail = tag
  if (tag === '[object Number]') detail = 'a non-finite number'
  else if (tag === '[object Object]') detail = 'a class instance'
  throw fail(path, `not JSON-safe: ${detail}`)
}

function isPlainObject(value: JsonValue): value is JsonObject {
  if (Object.prototype.toString.call(value) !== '[object Object]') return false
  return Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null
}
