import * as Y from '@y/y'
import { createComputePool } from '../src/compute.js'

const args = new Map(process.argv.slice(2).map(arg => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=', 2)
  return [key, value]
}))
/**
 * @param {string} name
 * @param {number} fallback
 */
const numberArg = (name, fallback) => {
  const value = Number(args.get(name) ?? fallback)
  if (!Number.isFinite(value) || value < 0) throw new Error(`--${name} must be a non-negative number`)
  return value
}

const mb = 1024 * 1024
const documentMb = numberArg('document-mb', 16)
const workers = numberArg('workers', 3)
const rounds = numberArg('rounds', 3)
const idleGcThreshold = numberArg('idle-gc-threshold', 8 * mb)
const idleGcDelay = numberArg('idle-gc-delay', 250)
const idleWait = numberArg('idle-wait', idleGcDelay + 1000)

if (!Number.isInteger(workers) || workers < 1 || !Number.isInteger(rounds) || rounds < 1) {
  throw new Error('--workers and --rounds must be positive integers')
}

const memory = () => Object.fromEntries(
  Object.entries(process.memoryUsage()).map(([key, value]) => [key, Math.round(value / mb * 10) / 10])
)
/** @param {number} ms */
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const doc = new Y.Doc()
doc.get('benchmark').insert(0, 'x'.repeat(documentMb * mb))
const update = Y.encodeStateAsUpdate(doc)
doc.get('benchmark').insert(documentMb * mb, 'y')
const secondUpdate = Y.encodeStateAsUpdate(doc)
doc.destroy()

const pool = createComputePool({ maxThreads: workers, idleGcThreshold, idleGcDelay })
let peakRss = process.memoryUsage().rss
const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss) }, 10)

try {
  const before = memory()
  const started = performance.now()
  for (let round = 0; round < rounds; round++) {
    await Promise.all(Array.from({ length: workers }, () => pool.mergeUpdates(true, [update, secondUpdate])))
  }
  const afterTasks = memory()
  await sleep(idleWait)
  const afterIdle = memory()
  const elapsedMs = Math.round(performance.now() - started)
  console.log(JSON.stringify({
    config: { documentMb, workers, rounds, idleGcThreshold, idleGcDelay, idleWait },
    inputBytes: update.byteLength + secondUpdate.byteLength,
    elapsedMs,
    peakRssMb: Math.round(peakRss / mb * 10) / 10,
    idleGcRuns: pool.workers.map(worker => worker.idleGcRuns),
    memoryMb: { before, afterTasks, afterIdle }
  }, null, 2))
} finally {
  clearInterval(sampler)
  await pool.destroy()
}
