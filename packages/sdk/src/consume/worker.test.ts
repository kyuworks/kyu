import { describe, expect, it } from 'vitest'
import { CommandHasTwoSubscribersError } from '../errors.js'
import type { CreateWorkerOpts, HatchetClient, Worker } from '../hatchet.js'
import { assertSingleCommandSubscriber, createWorker } from './worker.js'
import type { Subscription } from './subscribe.js'

// The engine's Worker/HatchetClient classes carry private fields, so a plain
// stub cannot satisfy them structurally; a Pick of just the members a test
// calls is comparable to the class type in one direction (the real class has
// those members too), which is enough for a single, unchained `as` cast.
function fakeWorker(overrides: Partial<Pick<Worker, 'start' | 'stop' | 'waitUntilReady'>>): Worker {
  const stub: Pick<Worker, 'start' | 'stop' | 'waitUntilReady'> = {
    start: overrides.start ?? (() => new Promise<void>(() => undefined)),
    stop: overrides.stop ?? (() => Promise.resolve()),
    waitUntilReady: overrides.waitUntilReady ?? (() => Promise.resolve()),
  }
  return stub as Worker
}

interface FakeHatchetClient {
  client: HatchetClient
  workerCallCount: () => number
  capturedWorkerOptions: () => CreateWorkerOpts | undefined
}

// createWorker always calls hatchet.worker(name, opts) with an options
// object, never the engine's bare-number slots shorthand — narrowing the
// stub's own parameter to CreateWorkerOpts keeps the capture typed instead
// of re-widening to the client method's full union.
function fakeHatchetClient(worker: (name: string) => Promise<Worker>): FakeHatchetClient {
  const calls = { count: 0 }
  let options: CreateWorkerOpts | undefined
  const stub: Pick<HatchetClient, 'worker'> = {
    worker: (name: string, workerOptions?: CreateWorkerOpts) => {
      calls.count += 1
      options = workerOptions
      return worker(name)
    },
  }
  return {
    client: stub as HatchetClient,
    workerCallCount: () => calls.count,
    capturedWorkerOptions: () => options,
  }
}

function stubSubscription(name: string, kind: Subscription['kind'], messageName: string): Subscription {
  // The workflow field is never read by assertSingleCommandSubscriber; a
  // stub keeps this unit test free of the engine.
  return { name, kind, messageName, workflow: {} as Subscription['workflow'] }
}

describe('assertSingleCommandSubscriber', () => {
  it('refuses two subscriptions to the same command name', () => {
    const subscriptions = [
      stubSubscription('send-invoice', 'command', 'shop.invoice.send'),
      stubSubscription('send-invoice-again', 'command', 'shop.invoice.send'),
    ]

    expect(() => assertSingleCommandSubscriber(subscriptions)).toThrow(CommandHasTwoSubscribersError)
  })

  it('allows two subscriptions to the same event name', () => {
    const subscriptions = [
      stubSubscription('notify-ops', 'event', 'shop.order.placed'),
      stubSubscription('notify-billing', 'event', 'shop.order.placed'),
    ]

    expect(() => assertSingleCommandSubscriber(subscriptions)).not.toThrow()
  })

  it('allows a single command subscriber', () => {
    const subscriptions = [stubSubscription('send-invoice', 'command', 'shop.invoice.send')]

    expect(() => assertSingleCommandSubscriber(subscriptions)).not.toThrow()
  })
})

describe('createWorker', () => {
  it('refuses two command subscriptions before it touches the client', async () => {
    const { client, workerCallCount } = fakeHatchetClient(() => Promise.resolve(fakeWorker({})))
    const subscriptions = [
      stubSubscription('send-invoice', 'command', 'shop.invoice.send'),
      stubSubscription('send-invoice-again', 'command', 'shop.invoice.send'),
    ]

    await expect(createWorker(client, 'worker', { subscriptions })).rejects.toBeInstanceOf(
      CommandHasTwoSubscribersError,
    )
    expect(workerCallCount()).toBe(0)
  })

  it('defaults handleKill to false so the engine never installs its own SIGTERM/SIGINT handlers', async () => {
    const { client, capturedWorkerOptions } = fakeHatchetClient(() => Promise.resolve(fakeWorker({})))
    const subscription = stubSubscription('notify-ops', 'event', 'shop.order.placed')

    await createWorker(client, 'worker', { subscriptions: [subscription] })

    expect(capturedWorkerOptions()?.handleKill).toBe(false)
  })

  it('passes handleKill through when the caller opts in', async () => {
    const { client, capturedWorkerOptions } = fakeHatchetClient(() => Promise.resolve(fakeWorker({})))
    const subscription = stubSubscription('notify-ops', 'event', 'shop.order.placed')

    await createWorker(client, 'worker', { subscriptions: [subscription], handleKill: true })

    expect(capturedWorkerOptions()?.handleKill).toBe(true)
  })
})

describe('KinesinWorker.waitUntilReady', () => {
  it('rejects with the start error, and never leaves an unhandled rejection', async () => {
    const unhandled: unknown[] = []
    const onUnhandledRejection: NodeJS.UnhandledRejectionListener = (reason) => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandledRejection)

    try {
      const startError = new Error('engine unreachable')
      const { client } = fakeHatchetClient(() =>
        Promise.resolve(
          fakeWorker({
            start: () => Promise.reject(startError),
            waitUntilReady: () => new Promise<void>(() => undefined),
          }),
        ),
      )
      const subscription = stubSubscription('send-invoice', 'command', 'shop.invoice.send')
      const worker = await createWorker(client, 'worker', { subscriptions: [subscription] })

      const started = worker.start()
      // Attached so this test's own rejection tracking does not flag the same
      // promise a second time; production code already attached its own catch.
      void started.catch(() => undefined)

      await expect(worker.waitUntilReady()).rejects.toBe(startError)
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandledRejection)
    }
  })

  it('surfaces a later start() failure even when waitUntilReady() was called first', async () => {
    const startError = new Error('engine unreachable')
    let rejectStart: (error: Error) => void = () => undefined
    const startPromise = new Promise<void>((_resolve, reject) => {
      rejectStart = reject
    })
    const { client } = fakeHatchetClient(() =>
      Promise.resolve(
        fakeWorker({
          start: () => startPromise,
          // Hangs forever: the engine probe this stands in for never
          // resolves once start() has already failed.
          waitUntilReady: () => new Promise<void>(() => undefined),
        }),
      ),
    )
    const subscription = stubSubscription('send-invoice', 'command', 'shop.invoice.send')
    const worker = await createWorker(client, 'worker', { subscriptions: [subscription] })

    const ready = worker.waitUntilReady()
    const started = worker.start()
    void started.catch(() => undefined)
    rejectStart(startError)

    await expect(ready).rejects.toBe(startError)
  })
})
