/** One store, one tenant: the pages carry no tenant field and the routes never read one from the client. */
export const DEMO_TENANT_ID = '0199a1c0-0000-7000-8000-000000000001'

export type OrderStage = 'placed' | 'invoice-sent' | 'shipped' | 'timed-out'
