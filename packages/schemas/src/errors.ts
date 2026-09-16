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
