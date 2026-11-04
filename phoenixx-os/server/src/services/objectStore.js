import { config } from '../config.js';

/**
 * Object storage for meeting recordings (S3 or S3-compatible).
 *
 * LiveKit Egress writes the files; this server only reads audio back for
 * transcription, deletes files, and signs short-lived links for playback.
 * Buckets stay private: nobody gets a permanent URL.
 */

const cfg = () => config.recordingStorage;

export const recordingStorageConfigured = () => !!(cfg().bucket && cfg().region && cfg().accessKeyId && cfg().secretAccessKey);

let fake = null;
/** Tests only: { get(key) -> Buffer, del(key), sign(key, opts) -> url }. */
export function setObjectStoreForTests(f) { fake = f || null; }

let client;
async function s3() {
  if (!client) {
    const { S3Client } = await import('@aws-sdk/client-s3');
    client = new S3Client({
      region: cfg().region,
      credentials: { accessKeyId: cfg().accessKeyId, secretAccessKey: cfg().secretAccessKey },
      ...(cfg().endpoint ? { endpoint: cfg().endpoint } : {}),
      forcePathStyle: cfg().forcePathStyle,
    });
  }
  return client;
}

/** Where a meeting's files live: <prefix><tenant>/<meeting>/... */
export const recordingKey = (meeting, ...rest) => `${cfg().prefix}${meeting.tenant_id}/${meeting.id}/${rest.join('/')}`;

/** The upload target LiveKit Egress is given (it uploads with these credentials). */
export function egressUpload() {
  return {
    accessKey: cfg().accessKeyId,
    secret: cfg().secretAccessKey,
    region: cfg().region,
    bucket: cfg().bucket,
    endpoint: cfg().endpoint || '',
    forcePathStyle: cfg().forcePathStyle,
  };
}

export async function getObjectBytes(key) {
  if (fake) return fake.get(key);
  const { GetObjectCommand } = await import('@aws-sdk/client-s3');
  const out = await (await s3()).send(new GetObjectCommand({ Bucket: cfg().bucket, Key: key }));
  return Buffer.from(await out.Body.transformToByteArray());
}

export async function deleteObject(key) {
  if (fake) return fake.del(key);
  const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
  await (await s3()).send(new DeleteObjectCommand({ Bucket: cfg().bucket, Key: key }));
}

/** A private link that works for `seconds` (default one hour). */
export async function signedUrl(key, { seconds = 3600, fileName } = {}) {
  if (fake) return fake.sign(key, { seconds, fileName });
  const { GetObjectCommand } = await import('@aws-sdk/client-s3');
  const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
  const cmd = new GetObjectCommand({
    Bucket: cfg().bucket,
    Key: key,
    ...(fileName ? { ResponseContentDisposition: `inline; filename="${fileName.replace(/["\\\r\n]/g, '')}"` } : {}),
  });
  return getSignedUrl(await s3(), cmd, { expiresIn: seconds });
}
