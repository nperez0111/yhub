import * as Y from '@y/y'
import * as t from 'lib0/testing'
import * as buffer from 'lib0/buffer'
import * as array from 'lib0/array'
import * as promise from 'lib0/promise'
import * as utils from './utils.js'
import { $updateMessage, $version } from '../src/types.js'
import { redisClockToMs } from '../src/stream.js'

/**
 * Named versions (`/version/v1`): crud over annotations of points in the history of a document,
 * and their cuts in the activity list.
 */

/**
 * @param {string} method
 * @param {string} path
 * @param {any} [body]
 * @param {object} [opts]
 * @param {boolean} [opts.json] send and receive json instead of lib0-any
 */
const request = async (method, path, body, { json = false } = {}) => {
  const response = await fetch(`http://${utils.yhubHost}/api${path}`, {
    method,
    headers: json ? { 'content-type': 'application/json', accept: 'application/json' } : { 'content-type': 'application/octet-stream' },
    body: body === undefined ? undefined : json ? JSON.stringify(body) : /** @type {Uint8Array<ArrayBuffer>} */ (buffer.encodeAny(body))
  })
  const data = new Uint8Array(await response.arrayBuffer())
  const contentType = response.headers.get('content-type') ?? ''
  return {
    status: response.status,
    body: data.byteLength === 0 ? null : contentType.includes('json') ? JSON.parse(new TextDecoder().decode(data)) : contentType.includes('x-lib0any') ? buffer.decodeAny(data) : data
  }
}

/**
 * What a client writes: the client's part of a version.
 *
 * @param {number|undefined} t
 * @param {string} name
 * @param {any} [custom]
 */
const input = (t, name, custom) => ({ type: 'version:v1', ...(t === undefined ? {} : { t }), name, ...(custom === undefined ? {} : { custom }) })

/**
 * Append an update to the document over rest - no socket, so the stream holds no awareness
 * messages unless a test adds them.
 *
 * @param {string} doc - `${org}/${docid}`
 * @param {(ydoc: Y.Doc) => void} f
 */
const edit = async (doc, f) => {
  const ydoc = new Y.Doc()
  f(ydoc)
  t.assert((await request('PATCH', `/ydoc/v1/${doc}`, { update: Y.encodeStateAsUpdate(ydoc) })).status === 200)
}

/**
 * @param {t.TestCase} tc
 */
export const testVersionCrud = async tc => {
  const { org } = await utils.createTestCase(tc)
  const path = `/version/v1/${org}/${tc.testName}-index`
  const before = Date.now()
  /**
   * @type {import('../src/types.js').Version}
   */
  let first
  await t.groupAsync('create: the client supplies name and custom, the server the rest', async () => {
    const created = await request('POST', path, input(1000, 'first', { tags: ['a', 1, null], thumb: new Uint8Array([1, 2]) }))
    t.assert(created.status === 200 && $version.check(created.body))
    first = created.body
    t.compare(first.custom, { tags: ['a', 1, null], thumb: new Uint8Array([1, 2]) })
    t.assert(first.t === 1000 && first.name === 'first' && first.createdBy === 'user1' && first.updatedBy === 'user1' && first.published === false && first.publishedAt === null && first.publishedBy === null)
    t.assert(first.createdAt === first.updatedAt && first.createdAt >= before - 1000 && first.createdAt <= Date.now() + 1000, 'stamped with the (redis) time of the write')
    const createdJson = await request('POST', path, input(3000, 'third'), { json: true })
    t.assert(createdJson.status === 200 && createdJson.body.t === 3000 && createdJson.body.custom === null, 'custom defaults to null')
    t.assert((await request('POST', path, input(2000, 'second'))).status === 200)
  })
  await t.groupAsync('a point is named once', async () => {
    const dup = await request('POST', path, input(1000, 'again'))
    t.assert(dup.status === 409 && dup.body.code === 'version-exists')
  })
  await t.groupAsync('list: ascending, windowed', async () => {
    t.compare((await request('GET', path)).body.versions.map((/** @type {any} */ v) => [v.t, v.name]), [[1000, 'first'], [2000, 'second'], [3000, 'third']])
    t.compare((await request('GET', `${path}?from=1500&to=2500`)).body.versions.map((/** @type {any} */ v) => v.t), [2000])
    const json = (await request('GET', `${path}?to=1000`, undefined, { json: true })).body.versions
    t.compare(json[0].custom, { tags: ['a', 1, null], thumb: buffer.toBase64(new Uint8Array([1, 2])) }, 'binary custom data is base64 in json')
  })
  await t.groupAsync('put replaces an existing version, keeping its creation', async () => {
    await promise.wait(5)
    const replaced = await request('PUT', path, input(1000, 'renamed', 'plain'))
    t.assert(replaced.status === 200)
    t.compare(replaced.body, { ...first, name: 'renamed', custom: 'plain', updatedAt: replaced.body.updatedAt })
    t.assert(replaced.body.updatedAt > first.createdAt)
    t.compare((await request('GET', `${path}?to=1000`)).body.versions, [replaced.body])
  })
  await t.groupAsync('put creates a missing version', async () => {
    const created = await request('PUT', path, input(1500, 'fresh'))
    t.assert(created.status === 200 && created.body.t === 1500 && created.body.createdAt === created.body.updatedAt)
  })
  await t.groupAsync('delete removes only the state the client read', async () => {
    const [read] = (await request('GET', `${path}?from=2000&to=2000`)).body.versions
    t.assert((await request('DELETE', `${path}?t=2000`)).status === 400, 'updatedAt is required')
    // renamed after it was read - the stale delete must not remove the newer version
    const renamed = (await request('PUT', path, input(2000, 'renamed'))).body
    const stale = await request('DELETE', `${path}?t=2000&updatedAt=${read.updatedAt}`)
    t.assert(stale.status === 409 && stale.body.code === 'version-conflict')
    t.compare(stale.body.version, renamed)
    t.assert((await request('DELETE', `${path}?t=2000&updatedAt=${renamed.updatedAt}`)).status === 204)
    t.assert((await request('DELETE', `${path}?t=2000&updatedAt=${renamed.updatedAt}`)).status === 204, 'a version that is gone already: idempotent')
    t.compare((await request('GET', path)).body.versions.map((/** @type {any} */ v) => v.t), [1000, 1500, 3000])
  })
  await t.groupAsync('published: only an explicit value changes it', async () => {
    // this hub grants history.publish - enforcement without it is in permissionsEnforcement.tests.js
    const created = await request('POST', path, { ...input(5000, 'p'), published: true }, { json: true })
    t.assert(created.status === 200 && created.body.published === true)
    // publishing stamps the time and the writer
    const stamp = { publishedAt: created.body.publishedAt, publishedBy: created.body.publishedBy }
    t.compare(stamp, { publishedAt: created.body.createdAt, publishedBy: 'user1' })
    t.assert((await request('GET', `${path}?from=5000&to=5000`)).body.versions[0].published === true)
    const put = await request('PUT', path, input(5000, 'renamed'))
    t.assert(put.status === 200 && put.body.name === 'renamed' && put.body.published === true, 'an omitted published keeps the flag')
    const patched = await request('PATCH', path, { ...input(5000, 'again'), published: true, updatedAt: put.body.updatedAt })
    t.assert(patched.status === 200 && patched.body.published === true)
    t.compare({ publishedAt: patched.body.publishedAt, publishedBy: patched.body.publishedBy }, stamp, 'staying published keeps the stamp')
    const unpublished = await request('PATCH', path, { ...input(5000, 'again'), published: false, updatedAt: patched.body.updatedAt })
    t.assert(unpublished.status === 200 && unpublished.body.published === false)
    t.assert(unpublished.body.publishedAt === null && unpublished.body.publishedBy === null, 'unpublishing clears the stamp')
    const republished = (await request('PUT', path, { ...input(5000, 'p'), published: true })).body
    t.assert(republished.published === true && republished.publishedBy === 'user1' && republished.publishedAt >= stamp.publishedAt, 'publishing again stamps anew')
    t.assert((await request('POST', path, { ...input(5500, 'p'), published: 'yes' }, { json: true })).status === 400)
    t.assert((await request('DELETE', `${path}?t=5000&updatedAt=${(await request('GET', `${path}?from=5000&to=5000`)).body.versions[0].updatedAt}`)).status === 204)
  })
  await t.groupAsync('invalid bodies', async () => {
    t.assert((await request('POST', path, { type: 'version:v1', t: 4000 })).status === 400, 'name is required')
    t.assert((await request('POST', path, { ...input(4000, 'x'), type: 'version:v2' })).status === 400)
    t.assert((await request('POST', path, { ...input(4000, 'x'), note: 'x' })).status === 400, 'client data belongs in custom - unknown keys are refused')
    t.assert((await request('POST', path, { ...input(4000, 'x'), note: 'x' }, { json: true })).status === 400)
    t.assert((await request('PUT', path, { ...input(4000, 'x'), createdAt: 1 })).status === 400, 'the server fields are not writable')
    t.assert((await request('PUT', path, input(undefined, 'x'))).status === 400, 'put needs a point')
    t.assert((await request('POST', path, input(-1, 'x'))).status === 400)
    t.assert((await request('POST', path, input(1.5, 'x'), { json: true })).status === 400)
    const zero = await request('POST', path, input(0, 'x'))
    t.assert(zero.status === 400 && zero.body.code === 'no-history')
  })
  await t.groupAsync('name and custom data share one size bound', async () => {
    const tooLarge = await request('POST', path, input(4000, 'x', 'a'.repeat(64 * 1024)))
    t.assert(tooLarge.status === 413 && tooLarge.body.code === 'version-too-large')
    t.assert((await request('PUT', path, input(4000, 'x', new Uint8Array(64 * 1024)))).status === 413)
    t.assert((await request('POST', path, input(4000, 'a'.repeat(64 * 1024)))).status === 413, 'the name counts')
    t.assert((await request('POST', path, input(4000, 'a'.repeat(32 * 1024), 'a'.repeat(32 * 1024)))).status === 413, 'both together')
    t.assert((await request('POST', path, input(4000, 'a'.repeat(30 * 1024), 'a'.repeat(30 * 1024)))).status === 200)
  })
}

/**
 * Without `t`, a version names the last update on the stream, else the last persisted one - never
 * the server's clock.
 *
 * @param {t.TestCase} tc
 */
export const testVersionDefaultTime = async tc => {
  const { org, yhub, defaultDocRef } = await utils.createTestCase(tc)
  const doc = `${org}/${tc.testName}-index`
  await t.groupAsync('a document without history has nothing to name', async () => {
    const empty = await request('POST', `/version/v1/${doc}`, input(undefined, 'nothing'))
    t.assert(empty.status === 400 && empty.body.code === 'no-history')
  })
  await t.groupAsync('the last update on the stream - awareness is skipped', async () => {
    await edit(doc, ydoc => ydoc.get().setAttr('a', 1))
    t.assert((await request('PATCH', `/ydoc/v1/${doc}`, { awareness: new Uint8Array([0]) })).status === 200)
    const [{ messages }] = await yhub.stream.getMessages([{ docRef: defaultDocRef, clock: '0' }])
    t.assert(!$updateMessage.check(array.last(messages)), 'the last stream message is not an update')
    const expected = redisClockToMs(array.last(messages.filter(m => $updateMessage.check(m))).redisClock)
    const created = await request('POST', `/version/v1/${doc}`, input(undefined, 'latest'))
    t.assert(created.status === 200 && created.body.t === expected)
  })
  await t.groupAsync('without updates on the stream, the last persisted one', async () => {
    const docRef = { ...defaultDocRef, docid: tc.testName + '-persisted' }
    const ydoc = new Y.Doc()
    ydoc.get().setAttr('a', 1)
    await yhub.unsafePersistDoc(docRef, Y.encodeStateAsUpdate(ydoc), { by: 'user1' })
    const [row] = await yhub.persistence.sql`SELECT t FROM yhub_ydoc_v1 WHERE org = ${docRef.org} AND docid = ${docRef.docid} AND branch = ${docRef.branch}`
    const created = await request('POST', `/version/v1/${org}/${docRef.docid}`, input(undefined, 'persisted'))
    t.assert(created.status === 200 && created.body.t === redisClockToMs(row.t))
  })
}

/**
 * The workflow: a version is created from an activity entry's `to`, and the activity then carries
 * it on that entry. Version writes are visible right away - the cached response is keyed by them.
 *
 * @param {t.TestCase} tc
 */
export const testVersionActivity = async tc => {
  const { org } = await utils.createTestCase(tc)
  const doc = `${org}/${tc.testName}-index`
  await edit(doc, ydoc => ydoc.get().setAttr('a', 1))
  // apart by more than a millisecond - group=false still merges changes of the same one
  await promise.wait(20)
  await edit(doc, ydoc => ydoc.get().setAttr('b', 2))
  // group=false: two entries, one per update
  const activityPath = `/activity/v1/${doc}?group=false`
  const before = (await request('GET', activityPath)).body.activity
  t.assert(before.length === 2 && before.every((/** @type {any} */ a) => a.version === undefined))
  const created = (await request('POST', `/version/v1/${doc}`, input(before[0].to, 'first', { note: 'x' }))).body
  const after = (await request('GET', activityPath)).body.activity
  t.compare(after.map((/** @type {any} */ a) => [a.from, a.to, a.version?.name]), [[before[0].from, before[0].to, 'first'], [before[1].from, before[1].to, undefined]])
  t.compare(after[0].version, created, 'the entry carries the whole version')
  t.assert((await request('GET', `${activityPath}&versions=false`)).body.activity.every((/** @type {any} */ a) => a.version === undefined))
  // a version before the first change stands alone, filters never hide it
  const origin = (await request('POST', `/version/v1/${doc}`, input(before[0].from - 1, 'origin'))).body
  t.assert(origin.name === 'origin')
  t.compare((await request('GET', `${activityPath}&by=nobody`)).body.activity.map((/** @type {any} */ a) => [a.to, a.version?.name, a.isEmpty]), [[before[0].from - 1, 'origin', true], [before[0].to, 'first', true]])
  t.compare((await request('GET', activityPath)).body.activity.map((/** @type {any} */ a) => a.isEmpty), [true, undefined, undefined], 'only the entry of a version alone is flagged')
  // a rename is visible right away
  const renamed = (await request('PUT', `/version/v1/${doc}`, input(before[0].to, 'renamed'))).body
  t.assert(renamed.name === 'renamed')
  t.assert((await request('GET', activityPath)).body.activity.find((/** @type {any} */ a) => a.to === before[0].to).version.name === 'renamed')
  t.assert((await request('DELETE', `/version/v1/${doc}?t=${origin.t}&updatedAt=${origin.updatedAt}`)).status === 204)
  t.assert((await request('DELETE', `/version/v1/${doc}?t=${renamed.t}&updatedAt=${renamed.updatedAt}`)).status === 204)
  t.assert((await request('GET', activityPath)).body.activity.every((/** @type {any} */ a) => a.version === undefined), 'a deleted version leaves the activity right away')
}

/**
 * PATCH replaces a version only while it is still the state the client read - its `updatedAt` -
 * so concurrent editors can't silently overwrite each other.
 *
 * @param {t.TestCase} tc
 */
export const testVersionPatch = async tc => {
  const { org, yhub, defaultDocRef } = await utils.createTestCase(tc)
  const path = `/version/v1/${org}/${tc.testName}-index`
  const missing = await request('PATCH', path, { ...input(1000, 'x'), updatedAt: 1 })
  t.assert(missing.status === 404 && missing.body.code === 'version-not-found')
  const created = (await request('POST', path, input(1000, 'first', { n: 1 }))).body
  /**
   * @param {any} read - the version as the client read it
   * @param {string} name
   * @param {any} [custom]
   */
  const patch = (read, name, custom) => request('PATCH', path, { ...input(read.t, name, custom), updatedAt: read.updatedAt })
  const alice = await patch(created, 'alice', { n: 2 })
  t.assert(alice.status === 200)
  t.compare(alice.body, { ...created, name: 'alice', custom: { n: 2 }, updatedAt: alice.body.updatedAt })
  t.assert(alice.body.updatedAt > created.updatedAt, 'every write moves updatedAt forward')
  await t.groupAsync('a stale write is refused with the current version', async () => {
    const bob = await patch(created, 'bob')
    t.assert(bob.status === 409 && bob.body.code === 'version-conflict')
    t.compare(bob.body.version, alice.body)
    const bobJson = await request('PATCH', path, { ...input(1000, 'bob'), updatedAt: created.updatedAt }, { json: true })
    t.assert(bobJson.status === 409 && bobJson.body.version.name === 'alice')
    t.assert((await patch(bob.body.version, 'bob')).status === 200, 'merged onto the current version, the retry succeeds')
  })
  await t.groupAsync('put takes part in the same versioning', async () => {
    const [current] = (await request('GET', `${path}?to=1000`)).body.versions
    const put = (await request('PUT', path, input(1000, 'put'))).body
    t.assert(put.updatedAt > current.updatedAt)
    t.assert((await patch(current, 'stale')).status === 409)
    t.assert((await patch(put, 'fresh')).status === 200)
  })
  await t.groupAsync('updatedAt strictly increases, even for writes within one millisecond', async () => {
    const [current] = await yhub.persistence.retrieveVersions(defaultDocRef, { from: 1000, to: 1000 })
    const custom = /** @type {Uint8Array<ArrayBuffer>} */ (buffer.encodeAny(null))
    // written at a time before the current one - as a write in the same millisecond would be
    const { updated, version } = await yhub.persistence.updateVersion(defaultDocRef, { t: 1000, name: 'past', custom, published: false, at: current.updatedAt, by: 'user1', updatedAt: current.updatedAt })
    t.assert(updated && /** @type {any} */ (version).updatedAt === current.updatedAt + 1)
    const replaced = await yhub.persistence.storeVersion(defaultDocRef, { t: 1000, name: 'past', custom, published: false, at: 1, by: 'user1' }, { replace: true })
    t.assert(/** @type {any} */ (replaced).updatedAt === current.updatedAt + 2)
  })
  await t.groupAsync('the client may not write the server fields', async () => {
    t.assert((await request('PATCH', path, { ...input(1000, 'x'), updatedAt: 1, createdAt: 1 })).status === 400)
    t.assert((await request('PATCH', path, input(1000, 'x'))).status === 400, 'updatedAt is required')
  })
}

/**
 * The activity reads at most `limit` + 1 versions - and computes exactly what an unlimited read
 * would, in both orders.
 *
 * @param {t.TestCase} tc
 */
export const testVersionActivityLimit = async tc => {
  const { org } = await utils.createTestCase(tc)
  const doc = `${org}/${tc.testName}-index`
  // three changes close enough to group into one entry, each named - every version cuts
  for (const key of ['a', 'b', 'c']) {
    await edit(doc, ydoc => ydoc.get().setAttr(key, 1))
    await promise.wait(20)
  }
  const changes = (await request('GET', `/activity/v1/${doc}?group=false`)).body.activity
  t.assert(changes.length === 3)
  for (const change of changes) {
    t.assert((await request('POST', `/version/v1/${doc}`, input(change.to, 'v'))).status === 200)
  }
  for (const order of ['asc', 'desc']) {
    const all = (await request('GET', `/activity/v1/${doc}?order=${order}`)).body.activity
    t.assert(all.length === 3)
    for (let limit = 1; limit <= 4; limit++) {
      t.compare((await request('GET', `/activity/v1/${doc}?order=${order}&limit=${limit}`)).body.activity, all.slice(0, limit), `order=${order} limit=${limit}`)
    }
  }
}

/**
 * A soft deletion keeps the named versions for a restore, a hard one erases them.
 *
 * @param {t.TestCase} tc
 */
export const testVersionDeletedDoc = async tc => {
  const { org, yhub, defaultDocRef } = await utils.createTestCase(tc)
  const path = `/version/v1/${org}/${tc.testName}-index`
  await edit(`${org}/${tc.testName}-index`, ydoc => ydoc.get().setAttr('a', 1))
  const kept = (await request('POST', path, input(1000, 'kept'))).body
  await yhub.deleteDoc(defaultDocRef)
  await t.groupAsync('soft deleted: every method answers 404', async () => {
    for (const res of [
      await request('GET', path),
      await request('POST', path, input(2000, 'x')),
      await request('POST', path, input(undefined, 'x')),
      await request('PUT', path, input(1000, 'x')),
      await request('PATCH', path, { ...input(1000, 'x'), updatedAt: kept.updatedAt }),
      await request('DELETE', `${path}?t=1000&updatedAt=${kept.updatedAt}`)
    ]) {
      t.assert(res.status === 404 && res.body.code === 'doc-deleted')
    }
  })
  await yhub.restoreDoc(defaultDocRef)
  t.compare((await request('GET', path)).body.versions, [kept], 'restored with the document')
  await yhub.deleteDoc(defaultDocRef, { hard: true })
  const rows = await yhub.persistence.sql`SELECT t FROM yhub_ydoc_versions_v1 WHERE org = ${defaultDocRef.org} AND docid = ${defaultDocRef.docid} AND branch = ${defaultDocRef.branch}`
  t.assert(rows.length === 0, 'a hard deletion erases the named versions')
  const straggler = { t: 1000, name: 'late', custom: /** @type {Uint8Array<ArrayBuffer>} */ (buffer.encodeAny(null)), published: false, at: 1, by: 'user1' }
  t.assert(await yhub.persistence.storeVersion(defaultDocRef, straggler) === null, 'the deletion barrier refuses a straggling creation')
  t.assert(await yhub.persistence.storeVersion(defaultDocRef, straggler, { replace: true }) === null, 'and a straggling replacement')
}
