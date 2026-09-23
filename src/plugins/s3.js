import * as t from '../types.js'
import * as s from 'lib0/schema'
import * as buffer from 'lib0/buffer'
import * as promise from 'lib0/promise'
import { Client as S3Client } from 'minio'
import { Readable } from 'stream'
import http from 'http'
import https from 'https'
import { logger } from '../logger.js'

const log = logger.child({ module: 's3' })

/**
 * @typedef {{ bucket: string, endPoint: string, port: number, useSSL: boolean, accessKey: string, secretKey: string, enable?: boolean, branches?: true | Array<string>, deleteVersions?: boolean, retryDelay?: number, deleteDelay?: number }} S3Conf
 */

export const $retrievableS3Asset = s.$object({
  type: s.$literal('asset:retrievable:v1'),
  plugin: s.$literal('S3Persistence:v1'),
  // object-store version id of the offloaded object, recorded so a versioned delete can target it
  versionId: s.$string.optional
})

/**
 * @typedef {s.Unwrap<typeof $retrievableS3Asset>} RetrievableS3Asset
 */

const TRANSIENT_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ESOCKETTIMEDOUT'])
const TRANSIENT_RE = /ECONNRESET|socket hang up|EPIPE/i
const S3_PART_SIZE = 5 * 1024 * 1024

/**
 * Transient errors are temporary network failures where retrying the same request is expected to
 * succeed (e.g. a keepalive connection dropped by the server, a momentary timeout, or throttling).
 *
 * @param {unknown} err
 */
const isTransient = (err) => {
  if (!(err instanceof Error)) return false
  const code = /** @type {any} */ (err).code
  const status = /** @type {any} */ (err).statusCode
  return TRANSIENT_CODES.has(code) ||
    TRANSIENT_RE.test(code) ||
    TRANSIENT_RE.test(err.message) ||
    status === 503 ||
    status === 429
}

/**
 * Run `op`, retrying it once after `delay` ms if it failed with a transient error.
 *
 * @template T
 * @param {string} action
 * @param {string} path
 * @param {number} delay
 * @param {() => Promise<T>} op
 * @return {Promise<T>}
 */
const retryTransient = async (action, path, delay, op) => {
  try {
    return await op()
  } catch (e) {
    if (!isTransient(e)) throw e
    log.warn({ err: e, path }, `transient error ${action} object, retrying`)
    await promise.wait(delay)
    return op()
  }
}

/**
 * @implements {t.PersistencePlugin}
 */
export class S3PersistenceV1 {
  /**
   * @param {S3Conf} s3conf
   */
  constructor (s3conf) {
    this.bucket = s3conf.bucket
    this.enable = s3conf.enable ?? true
    this.branches = s3conf.branches ?? true
    this.deleteVersions = s3conf.deleteVersions ?? true
    this.retryDelay = s3conf.retryDelay ?? 1_000
    this.deleteDelay = s3conf.deleteDelay ?? 10_000
    const Agent = s3conf.useSSL ? https.Agent : http.Agent
    this._agent = new Agent({ keepAlive: true, keepAliveMsecs: 30_000 })
    this.s3client = new S3Client({ ...s3conf, transportAgent: this._agent, partSize: S3_PART_SIZE })
  }

  /**
   * @return {'S3Persistence:v1'}
   */
  get pluginid () {
    return 'S3Persistence:v1'
  }

  async init () {
    log.info({ bucket: this.bucket }, 'checking if S3 bucket exists')
    const exists = await this.s3client.bucketExists(this.bucket)
    if (!exists) {
      log.info({ bucket: this.bucket }, 'creating S3 bucket')
      await this.s3client.makeBucket(this.bucket)
      log.info({ bucket: this.bucket }, 'S3 bucket created')
    } else {
      log.info({ bucket: this.bucket }, 'S3 bucket already exists')
    }
  }

  /**
   * @param {t.AssetId} assetId
   * @param {t.Asset} asset
   * @return {Promise<RetrievableS3Asset?>}
   */
  async store (assetId, asset) {
    if (this.enable && (this.branches === true || this.branches.includes(assetId.branch))) {
      const path = t.assetIdToString(assetId)
      const file = Buffer.from(buffer.encodeAny(asset))
      const put = () => this.s3client.putObject(this.bucket, path, Readable.from(file), file.length)
      const res = await retryTransient('storing', path, this.retryDelay, put)
      /** @type {RetrievableS3Asset} */
      const reference = {
        type: 'asset:retrievable:v1',
        plugin: this.pluginid
      }
      if (typeof res.versionId === 'string') {
        reference.versionId = res.versionId
      }
      return reference
    }
    return null
  }

  /**
   * @param {t.AssetId} assetId
   * @param {t.Asset} assetInfo
   * @return {Promise<t.Asset?>}
   */
  async retrieve (assetId, assetInfo) {
    if ($retrievableS3Asset.check(assetInfo)) {
      const path = t.assetIdToString(assetId)
      const get = async () => {
        try {
          const stream = await this.s3client.getObject(this.bucket, path)
          const chunks = []
          for await (const chunk of stream) {
            chunks.push(chunk)
          }
          return Buffer.concat(chunks)
        } catch (e) {
          if (/** @type {any} */ (e)?.code === 'NoSuchKey') return null
          throw e
        }
      }
      const data = await retryTransient('retrieving', path, this.retryDelay, get)
      return data && t.$asset.expect(buffer.decodeAny(data))
    }
    return null
  }

  /**
   * The erase is deferred by `deleteDelay` so that a reader that already resolved the reference
   * can still fetch the object. Keep it at 10 seconds or more - a shorter window races those
   * in-flight reads, which then fail to retrieve a document they were legitimately handed.
   *
   * @param {t.AssetId} assetId
   * @param {t.Asset} assetInfo
   * @return {Promise<boolean>}
   */
  async delete (assetId, assetInfo) {
    if (!$retrievableS3Asset.check(assetInfo)) {
      return false
    }
    const path = t.assetIdToString(assetId)
    const versionId = assetInfo.versionId
    setTimeout(() => {
      // delete at some point later, avoiding issues of clients pulling from stale data
      // @todo it would be nice to implement a worker that finds unused s3 docs and deletes them
      this._erase(path, versionId).catch(err => log.error({ err, path }, 'error deleting object'))
    }, this.deleteDelay)
    return true
  }

  /**
   * Remove the object at `path`, retrying once on a transient error - the erase is deferred and
   * unobserved, so a dropped connection would otherwise orphan the object. With `deleteVersions`
   * (the default) the version recorded on the reference is deleted directly; unrecorded versions
   * and the delete markers plain deletes leave on a versioned bucket are the operator's cleanup,
   * e.g. via bucket lifecycle rules.
   *
   * @param {string} path
   * @param {string} [versionId]
   */
  _erase (path, versionId) {
    return retryTransient('deleting', path, this.retryDelay, () =>
      this.s3client.removeObject(this.bucket, path, this.deleteVersions && versionId != null ? { versionId } : {}))
  }
}
