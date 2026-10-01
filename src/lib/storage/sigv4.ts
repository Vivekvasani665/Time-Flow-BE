import { createHash, createHmac } from 'node:crypto';

/**
 * AWS Signature Version 4 query-string signing ("presigned URLs") for
 * S3-compatible object storage such as Cloudflare R2. Only presigning is
 * needed: the browser uploads and plays back through presigned URLs, and the
 * server's own HEAD / ranged GET / DELETE calls use short-lived ones too, so no
 * SDK and no long-lived credential ever leaves this process.
 */

export type PresignInput = {
  method: 'GET' | 'PUT' | 'HEAD' | 'DELETE';
  /** Full object URL, e.g. https://<account>.r2.cloudflarestorage.com/<bucket>/<key>. */
  url: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  expiresInSeconds: number;
  /** Headers the client must send verbatim (lower-case names). `host` is always signed. */
  signedHeaders?: Record<string, string>;
  /** Extra query parameters, e.g. response-content-disposition. */
  query?: Record<string, string>;
  now?: Date;
  service?: string;
};

/** RFC 3986 encoding as SigV4 requires: only A-Z a-z 0-9 - _ . ~ stay literal. */
export function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

const sha256Hex = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const hmac = (key: Buffer | string, value: string) => createHmac('sha256', key).update(value, 'utf8').digest();

function amzDates(now: Date) {
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

export function presignUrl(input: PresignInput): string {
  const service = input.service ?? 's3';
  const url = new URL(input.url);
  const { amzDate, dateStamp } = amzDates(input.now ?? new Date());
  const scope = `${dateStamp}/${input.region}/${service}/aws4_request`;

  const headers: Record<string, string> = { host: url.host };
  for (const [name, value] of Object.entries(input.signedHeaders ?? {})) headers[name.toLowerCase()] = value;
  const headerNames = Object.keys(headers).sort();
  const signedHeaderList = headerNames.join(';');

  const params: Record<string, string> = {
    ...input.query,
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${input.accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(input.expiresInSeconds),
    'X-Amz-SignedHeaders': signedHeaderList,
  };
  const canonicalQuery = Object.entries(params)
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  // Each path segment encoded once; the URL parser may already have escaped some, so decode first.
  const canonicalUri = url.pathname
    .split('/')
    .map((segment) => uriEncode(decodeURIComponent(segment)))
    .join('/');
  const canonicalHeaders = headerNames.map((name) => `${name}:${headers[name].trim().replace(/\s+/g, ' ')}\n`).join('');

  const canonicalRequest = [input.method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaderList, 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  const signingKey = hmac(hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, dateStamp), input.region), service), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

  return `${url.origin}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
