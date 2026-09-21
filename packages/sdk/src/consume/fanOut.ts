import type {
  Envelope,
  MessageData,
  MessageDataShape,
  MessageDefinition,
  MessageSchema,
  Unparsed,
} from '@kyuworks/schemas'
import { envelopeSchema } from '@kyuworks/schemas'
import { KyuError } from '../errors.js'
import { eventScope } from '../eventScope.js'
import { Or, SleepCondition, UserEventCondition, durationToMs } from '../hatchet.js'
import type { DurableContext, Duration, JsonObject, OrCondition } from '../hatchet.js'
import { readRunOutcomes } from './runOutcomes.js'
import type { RunsReader } from './runOutcomes.js'
import { celEquals, decodeMatchedEnvelope, readEnvelopeField } from './waitMatch.js'

export interface WaitForChildrenOptions {
  where: {
    /** Dotted path relative to the reply payload that carries the child's envelope id, e.g. `data.childEnvelopeId`. */
    field: string
    /** The envelope ids `publish()` returned for the children, in publish order. Distinct, 1 to 50. */
    envelopeIds: readonly string[]
  }
  /** Defaults to the handler envelope's tenant, or `'global'`; an explicit value disables the tenant cross-check. */
  scope?: string
  /** Defaults to `'5m'`. */
  lookback?: Extract<Duration, string>
  /** One deadline for the whole set. Each child that has not replied by then is classified from its own engine runs. */
  timeout: Extract<Duration, string>
}

export type ChildOutcome<S extends MessageSchema> =
  | { envelopeId: string; status: 'replied'; envelope: Envelope<MessageData<MessageDefinition<S>>> }
  | { envelopeId: string; status: 'failed'; error?: string }
  | { envelopeId: string; status: 'pending' }

// Proven against the local engine: one registration took 50 children (100
// conditions) and reported all 75 satisfied keys.
export const MAX_FAN_OUT_CHILDREN = 50

function assertChildEnvelopeIds(envelopeIds: readonly string[]): void {
  if (envelopeIds.length === 0) {
    throw new KyuError('waitForChildren: where.envelopeIds must not be empty')
  }
  if (envelopeIds.length > MAX_FAN_OUT_CHILDREN) {
    throw new KyuError(
      `waitForChildren: where.envelopeIds has ${envelopeIds.length} ids, more than the ${MAX_FAN_OUT_CHILDREN}-child cap`,
    )
  }
  const seen = new Set<string>()
  for (const id of envelopeIds) {
    if (!envelopeSchema.shape.id.safeParse(id).success) {
      throw new KyuError(`waitForChildren: where.envelopeIds contains "${id}", not a uuid v7`)
    }
    if (seen.has(id)) {
      throw new KyuError(`waitForChildren: where.envelopeIds contains "${id}" more than once`)
    }
    seen.add(id)
  }
}

// Split from waitForChildMessages so the CEL, scope and lookback math is
// testable without a running engine, mirroring buildWaitForConditions.
export function buildChildConditions(
  handlerEnvelope: Envelope<MessageDataShape>,
  definition: MessageDefinition<MessageSchema>,
  options: WaitForChildrenOptions,
  now: Date,
): OrCondition[] {
  const lookback = options.lookback ?? '5m'
  const scope = options.scope ?? eventScope(handlerEnvelope)
  const considerEventsSince = new Date(now.getTime() - durationToMs(lookback)).toISOString()

  return options.where.envelopeIds.map((envelopeId, index) => {
    const keyMatch = celEquals('waitForChildren', options.where.field, envelopeId)
    const expression = `${keyMatch} && input.version == ${definition.version}`
    const reply = new UserEventCondition(
      definition.name,
      expression,
      `child-${index}`,
      undefined,
      scope,
      considerEventsSince,
    )
    const timeout = new SleepCondition(options.timeout, `timeout-${index}`)
    return Or(reply, timeout)
  })
}

type ChildMatches = Record<string, ReadonlyArray<Unparsed> | undefined>

interface ChildFailure {
  error?: string
}

async function classifyUnreplied(runs: RunsReader, envelopeId: string): Promise<ChildFailure | undefined> {
  const outcomes = await readRunOutcomes(runs, envelopeId)
  const failedOutcomes = outcomes.filter((outcome) => outcome.status === 'failed' || outcome.status === 'cancelled')
  if (failedOutcomes.length === 0) return undefined
  const withError = failedOutcomes.find((outcome) => outcome.error !== undefined)
  const failure: ChildFailure = {}
  if (withError?.error !== undefined) failure.error = withError.error
  return failure
}

// Registers one durable wait holding one Or(reply, timeout) group per child,
// then classifies every child that did not reply from its own engine runs.
export async function waitForChildMessages<S extends MessageSchema>(
  hatchetContext: DurableContext<JsonObject>,
  runs: RunsReader,
  handlerEnvelope: Envelope<MessageDataShape>,
  definition: MessageDefinition<S>,
  options: WaitForChildrenOptions,
): Promise<readonly ChildOutcome<S>[]> {
  assertChildEnvelopeIds(options.where.envelopeIds)

  const now = await hatchetContext.now()
  const groups = buildChildConditions(handlerEnvelope, definition, options, now)

  // Left untyped: the dynamic child-<i>/timeout-<i> keys and the optional
  // CREATE wrapper cannot both be expressed as one structural type without an
  // index signature swallowing CREATE's own, different value type. The
  // engine SDK's own `waitFor` already returns `Record<string, any>`.
  const raw = await hatchetContext.waitFor(groups)
  // Engines before durable eviction return the CREATE map unwrapped.
  const created: ChildMatches = raw['CREATE'] ?? raw

  const hasChildOrTimeoutKey = Object.keys(created).some(
    (key) => key.startsWith('child-') || key.startsWith('timeout-'),
  )
  if (!hasChildOrTimeoutKey) {
    throw new KyuError(`waitForChildren: unexpected engine result shape: ${JSON.stringify(raw)}`)
  }

  // A satisfied Or group still records its sibling timeout key, so a child
  // replied when its own child-<i> key is present — never test timeout-<i>.
  const replied = new Map<number, Envelope<MessageData<MessageDefinition<S>>>>()
  for (const [index, expectedId] of options.where.envelopeIds.entries()) {
    const matches = created[`child-${index}`]
    if (matches !== undefined && matches.length > 0) {
      const envelope = await decodeMatchedEnvelope(
        'waitForChildren',
        definition,
        matches[0],
        handlerEnvelope,
        options.scope,
      )
      // The CEL condition already filtered on this field, but a replay that
      // pairs child-<i> with the wrong engine result would otherwise
      // misattribute a reply to the wrong child; check it again here.
      const actualId = readEnvelopeField(envelope, options.where.field)
      if (actualId !== expectedId) {
        throw new KyuError(
          `waitForChildren: child-${index}'s reply carries envelope id ${JSON.stringify(actualId)} at "${options.where.field}", expected ${expectedId}`,
        )
      }
      replied.set(index, envelope)
    }
  }

  const unrepliedIndexes = options.where.envelopeIds.map((_id, index) => index).filter((index) => !replied.has(index))
  const classifications = await Promise.all(
    unrepliedIndexes.map(async (index): Promise<readonly [number, ChildFailure | undefined]> => {
      const envelopeId = options.where.envelopeIds[index]
      if (envelopeId === undefined) {
        throw new KyuError('waitForChildren: unreachable: envelopeIds index out of range')
      }
      return [index, await classifyUnreplied(runs, envelopeId)]
    }),
  )
  const classified = new Map(classifications)

  return options.where.envelopeIds.map((envelopeId, index) => {
    const repliedEnvelope = replied.get(index)
    if (repliedEnvelope !== undefined) {
      return { envelopeId, status: 'replied', envelope: repliedEnvelope }
    }
    const failure = classified.get(index)
    if (failure !== undefined) {
      const outcome: ChildOutcome<S> = { envelopeId, status: 'failed' }
      if (failure.error !== undefined) outcome.error = failure.error
      return outcome
    }
    return { envelopeId, status: 'pending' }
  })
}
