import type { StandardSchemaV1 } from '@standard-schema/spec'
import { MessageDataError } from './errors.js'

/** Run a Standard Schema at its boundary, throwing `MessageDataError` on issues. */
export function validateStandard<S extends StandardSchemaV1>(
  schema: S,
  value: StandardSchemaV1.InferInput<S>,
): StandardSchemaV1.InferOutput<S> | Promise<StandardSchemaV1.InferOutput<S>> {
  const result = schema['~standard'].validate(value)
  return result instanceof Promise ? result.then(resolveResult) : resolveResult(result)
}

function resolveResult<Output>(result: StandardSchemaV1.Result<Output>): Output {
  if (result.issues === undefined) return result.value
  throw new MessageDataError(result.issues.map((issue) => ({ path: formatPath(issue.path), message: issue.message })))
}

function formatPath(path: StandardSchemaV1.Issue['path']): string {
  if (path === undefined) return ''
  return path.map(pathSegmentKey).map(String).join('.')
}

function pathSegmentKey(segment: PropertyKey | StandardSchemaV1.PathSegment): PropertyKey {
  return isPathSegment(segment) ? segment.key : segment
}

function isPathSegment(segment: PropertyKey | StandardSchemaV1.PathSegment): segment is StandardSchemaV1.PathSegment {
  return Object.prototype.hasOwnProperty.call(segment, 'key')
}
