import * as t from 'lib0/testing'
import * as utils from './utils.js'
import * as stream from '../src/stream.js'

/**
 * Older releases stamped `unsafePersistDoc` rows `${ms}-I`, which is not a valid redis stream id.
 *
 * @param {t.TestCase} _tc
 */
export const testSanitizeRedisClock = _tc => {
  t.compare(stream.sanitizeRedisClock('1700000000000-I'), '1700000000000-0')
  t.compare(stream.sanitizeRedisClock('1700000000000-5'), '1700000000000-5')
  t.compare(stream.sanitizeRedisClock('1700000000000'), '1700000000000')
  t.compare(stream.sanitizeRedisClock('0'), '0')
}

/**
 * @param {t.TestCase} _tc
 */
export const testIsSmallerRedisClockLegacySequence = _tc => {
  t.assert(stream.isSmallerRedisClock('5-I', '5-1'))
  t.assert(!stream.isSmallerRedisClock('5-1', '5-I'))
  t.assert(!stream.isSmallerRedisClock('5-I', '5-0') && !stream.isSmallerRedisClock('5-0', '5-I'), '-I compares equal to -0')
  t.assert(stream.isSmallerRedisClock('4-9', '5-I'))
  t.assert(stream.isSmallerRedisClock('5-I', '6-0'))
  t.compare(stream.maxRedisClock('5-I', '5-2'), '5-2')
  t.compare(stream.minRedisClock('5-2', '5-I'), '5-I')
}

/**
 * A legacy `-I` clock that reaches `trimMessages` as `minId` must not crash the trim script. `1` is
 * older than the lifetime window, which forces the script to increment the id.
 *
 * @param {t.TestCase} tc
 */
export const testTrimMessagesLegacyMinId = async tc => {
  const { yhub, defaultDocRef, defaultStream } = await utils.createTestCase(tc)
  const s = yhub.stream
  await s.addMessage(defaultDocRef, { type: 'awareness:v1', update: new Uint8Array([1, 2, 3]) })
  const taskid = /** @type {string} */ ((await s.redis.xRange(s.workerStreamName, '-', '+')).find(e => e.message.compact === defaultStream)?.id)
  t.assert(taskid != null, 'seed produced a pending compact task')
  await s.trimMessages(defaultDocRef, '1-I', 100000, taskid)
  t.assert(await s.redis.xLen(defaultStream) === 1, 'young message survived the trim')
  await utils.waitTasksProcessed(yhub)
}
