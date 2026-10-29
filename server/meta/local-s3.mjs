import { createHash, createHmac } from 'node:crypto';

// Local development provisioning only; production buckets and IAM are provisioned externally.
export function localS3({ endpoint, region, accessKeyId: access, secretAccessKey: secret }) {
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
    throw new Error('Local S3 bootstrap is loopback-only.');
  const sha = (v) => createHash('sha256').update(v).digest('hex');
  const hmac = (k, v) => createHmac('sha256', k).update(v).digest();
  return async function s3(method, path, body = '') {
    const date = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const short = date.slice(0, 8),
      host = new URL(endpoint).host;
    const headers = { host, 'x-amz-content-sha256': sha(body), 'x-amz-date': date };
    const signed = Object.keys(headers).sort().join(';');
    const url = new URL(path, endpoint);
    const canonical = [
      method,
      url.pathname,
      url.searchParams.toString(),
      Object.keys(headers)
        .sort()
        .map((k) => `${k}:${headers[k]}\n`)
        .join(''),
      signed,
      sha(body),
    ].join('\n');
    const scope = `${short}/${region}/s3/aws4_request`;
    const key = hmac(hmac(hmac(hmac('AWS4' + secret, short), region), 's3'), 'aws4_request');
    headers.Authorization = `AWS4-HMAC-SHA256 Credential=${access}/${scope}, SignedHeaders=${signed}, Signature=${hmac(key, `AWS4-HMAC-SHA256\n${date}\n${scope}\n${sha(canonical)}`).toString('hex')}`;
    return fetch(url, {
      method,
      headers,
      ...(method === 'PUT' ? { body } : {}),
      signal: AbortSignal.timeout(3000),
    });
  };
}
