// Global setup for the integration suite. A missing engine is a failure, not
// a skip: a suite that silently skips reports green for code it never ran.
export default function setup(): void {
  if (!process.env['HATCHET_CLIENT_TOKEN']) {
    throw new Error(
      [
        'HATCHET_CLIENT_TOKEN is not set, so the integration suite cannot reach an engine.',
        'Start the local stack and export a token:',
        '  pnpm hatchet:up',
        '  export HATCHET_CLIENT_TOKEN="$(bash infra/hatchet/token.sh)"',
        '  export HATCHET_CLIENT_TLS_STRATEGY=none',
      ].join('\n'),
    )
  }
}
