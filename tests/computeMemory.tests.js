import * as t from 'lib0/testing'
import * as Y from '@y/y'
import * as promise from 'lib0/promise'
import { spawn } from 'node:child_process'
import { markAsUntransferable } from 'node:worker_threads'
import { createComputePool } from '../src/compute.js'

const createUpdates = (size = 6000) => {
  const doc = new Y.Doc()
  doc.get('test').insert(0, 'x'.repeat(size))
  const first = Y.encodeStateAsUpdate(doc)
  doc.get('test').insert(size, 'y')
  const second = Y.encodeStateAsUpdate(doc)
  doc.destroy()
  return [first, second]
}

/** @param {t.TestCase} _tc */
export const testWorkerInputAndOutputBufferOwnership = async _tc => {
  const pool = createComputePool({ maxThreads: 1 })
  try {
    const [update] = createUpdates()
    const sharedBacking = new Uint8Array(update.byteLength + 1)
    sharedBacking.set(update)
    const updateView = sharedBacking.subarray(0, update.byteLength)
    const emptyStateVector = sharedBacking.subarray(update.byteLength)
    const before = sharedBacking.slice()
    markAsUntransferable(sharedBacking.buffer)

    // The result aliases the worker's cloned input and is transferred back before cleanup. The
    // caller's explicitly nontransferable backing store and both of its views remain reusable.
    for (let i = 0; i < 2; i++) {
      const result = await pool.run({ type: 'computeSyncSteps', update: updateView, sv: emptyStateVector, withSv: false }, [], {})
      t.compare(result.diff, update)
      t.compare(sharedBacking, before)
    }

    // Duplicate inputs and SharedArrayBuffer-backed inputs are safe too. Shared stores are never
    // detached because they are not private structured-clone allocations.
    const duplicateResult = await pool.run({ type: 'mergeUpdates', gc: false, updates: [updateView, updateView] }, [], {})
    t.compare(duplicateResult, update)
    const sab = new SharedArrayBuffer(update.byteLength)
    const sharedUpdate = new Uint8Array(sab)
    sharedUpdate.set(update)
    const sharedUpdateForTask = /** @type {Uint8Array<ArrayBuffer>} */ (/** @type {unknown} */ (sharedUpdate))
    const sharedResult = await pool.run({ type: 'mergeUpdates', gc: false, updates: [sharedUpdateForTask, sharedUpdateForTask] }, [], {})
    t.compare(sharedResult, update)
    t.compare(Array.from(sharedUpdate), Array.from(update))

    // Cleanup also runs after errors without changing caller-owned data or killing the worker.
    const err = await pool.run({ type: 'computeSyncSteps', update: updateView, sv: new Uint8Array([2, 5]), withSv: false }, [], {}).then(() => null, err => err)
    t.assert(err instanceof Error)
    t.compare(sharedBacking, before)
    t.assert(!pool.workers[0].isDead)
  } finally {
    await pool.destroy()
  }
}

/** @param {t.TestCase} _tc */
export const testIdleGcIsThresholdedCancelledAndReusesWorker = async _tc => {
  t.assert(typeof /** @type {{ gc?: () => void }} */ (globalThis).gc === 'function', 'test runner must use --expose-gc')
  const pool = createComputePool({ maxThreads: 1, idleGcThreshold: 5000, idleGcDelay: 40 })
  try {
    const updates = createUpdates()
    await pool.mergeUpdates(true, updates)
    const worker = pool.workers[0]
    await promise.wait(100)
    t.assert(worker.idleGcRuns === 1, 'a large idle task triggered collection')
    await pool.mergeUpdates(true, updates)
    t.assert(pool.workers[0] === worker && !worker.isDead, 'collection kept the warm worker')

    // A small task arriving before the second collection cancels it and does not schedule its own.
    const smallDoc = new Y.Doc()
    smallDoc.get().insert(0, 'small')
    const smallUpdate = Y.encodeStateAsUpdate(smallDoc)
    smallDoc.destroy()
    await pool.run({ type: 'computeSyncSteps', update: smallUpdate, sv: new Uint8Array([0]), withSv: false }, [], {})
    await promise.wait(100)
    t.assert(worker.idleGcRuns === 1, 'new work cancelled pending idle maintenance')
  } finally {
    await pool.destroy()
  }
}

/** @param {t.TestCase} _tc */
export const testIdleGcDisabledOrUnavailable = async _tc => {
  const pool = createComputePool({ maxThreads: 1, idleGcThreshold: 0, idleGcDelay: 1 })
  try {
    await pool.mergeUpdates(true, createUpdates())
    await promise.wait(30)
    t.assert(pool.workers[0].idleGcRuns === 0)
  } finally {
    await pool.destroy()
  }

  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import * as Y from '@y/y'
    import { createComputePool } from '${new URL('../src/compute.js', import.meta.url)}'
    const doc = new Y.Doc(); doc.get().insert(0, 'x'.repeat(6000))
    const first = Y.encodeStateAsUpdate(doc); doc.get().insert(6000, 'y')
    const second = Y.encodeStateAsUpdate(doc); doc.destroy()
    const pool = createComputePool({ maxThreads: 1, idleGcThreshold: 1, idleGcDelay: 1 })
    await pool.mergeUpdates(true, [first, second])
    await new Promise(resolve => setTimeout(resolve, 30))
    process.stdout.write(JSON.stringify({ gc: typeof globalThis.gc, runs: pool.workers[0].idleGcRuns }) + '\\n')
    await pool.destroy()
  `], { env: { ...process.env, NODE_OPTIONS: '', LOG_LEVEL: 'fatal' }, stdio: ['ignore', 'pipe', 'inherit'] })
  let out = ''
  child.stdout.on('data', data => { out += data })
  const exitCode = await promise.create(resolve => child.once('close', resolve))
  t.assert(exitCode === 0)
  t.compare(JSON.parse(out), { gc: 'undefined', runs: 0 })
}

/** @param {t.TestCase} _tc */
export const testIdleRetirementIsOptionalAndDoesNotInterruptQueue = async _tc => {
  const defaultPool = createComputePool({ maxThreads: 1 })
  t.assert(defaultPool.idleTimeout === 0)
  await defaultPool.destroy()

  const pool = createComputePool({ maxThreads: 1, idleTimeout: 20 })
  try {
    const updates = createUpdates()
    const results = await Promise.all(Array.from({ length: 5 }, () => pool.mergeUpdates(true, updates)))
    results.forEach(result => t.compare(result, results[0]))
    const worker = pool.workers[0]
    await promise.create((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('idle worker was not retired')), 2000)
      worker.worker.once('exit', () => { clearTimeout(timeout); resolve() })
    })
    t.compare(pool.stats(), { queued: 0, busy: 0, workers: 0 })
    await pool.mergeUpdates(true, updates)
    t.assert(pool.workers[0] !== worker, 'retired worker was recreated on demand')
  } finally {
    await pool.destroy()
  }
}
