export interface MessageDataIssue {
  path: string
  message: string
}

/** A message's `data` failed its Standard Schema at the publish boundary. */
export class MessageDataError extends Error {
  readonly issues: ReadonlyArray<MessageDataIssue>

  constructor(issues: ReadonlyArray<MessageDataIssue>) {
    const summary = issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')
    super(`message data failed validation: ${summary}`)
    this.name = 'MessageDataError'
    this.issues = issues
  }
}

export interface EnvelopeOptionIssue {
  path: string
  message: string
}

/** `createEnvelope`'s options, combined with the already-validated `data`, failed `envelopeSchema`. */
export class EnvelopeOptionsError extends Error {
  readonly issues: ReadonlyArray<EnvelopeOptionIssue>

  constructor(issues: ReadonlyArray<EnvelopeOptionIssue>) {
    const summary = issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')
    super(`envelope options failed validation: ${summary}`)
    this.name = 'EnvelopeOptionsError'
    this.issues = issues
  }
}

/** `defineEvent`/`defineCommand` was called with an invalid name or version. */
export class MessageDefinitionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MessageDefinitionError'
  }
}
