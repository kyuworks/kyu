export interface MessageDataIssue {
  path: string
  message: string
}

export type EnvelopeOptionIssue = MessageDataIssue

abstract class IssueError extends Error {
  readonly issues: ReadonlyArray<MessageDataIssue>

  constructor(kind: string, issues: ReadonlyArray<MessageDataIssue>, options?: { cause: Error }) {
    const summary = issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')
    super(`${kind} failed validation: ${summary}`, options)
    this.name = new.target.name
    this.issues = issues
  }
}

/** A message's `data` failed its Standard Schema at the publish boundary. */
export class MessageDataError extends IssueError {
  constructor(issues: ReadonlyArray<MessageDataIssue>) {
    super('message data', issues)
  }
}

/** `createEnvelope`'s options, combined with the already-validated `data`, failed `envelopeSchema`. */
export class EnvelopeOptionsError extends IssueError {
  constructor(issues: ReadonlyArray<EnvelopeOptionIssue>) {
    super('envelope options', issues)
  }
}

/** `fromEnvelopeMetadata` was given a record that fails `envelopeMetadataSchema`. */
export class EnvelopeMetadataError extends IssueError {
  constructor(issues: ReadonlyArray<EnvelopeOptionIssue>, cause: Error) {
    super('envelope metadata', issues, { cause })
  }
}

/** `defineEvent`/`defineCommand` was called with an invalid name or version. */
export class MessageDefinitionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MessageDefinitionError'
  }
}
