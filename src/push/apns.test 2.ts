import crypto from 'node:crypto';
import http2 from 'node:http2';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApnsClient } from './apns.ts';

/** A stand-in for APNs: plain-text HTTP/2 on localhost, answering with whatever the test sets up. */
const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const p8 = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

interface Seen {
  path: string;
  headers: http2.IncomingHttpHeaders;
  body: unknown;
}
let seen: Seen[] = [];
let respond: (s: Seen) => { status: number; body?: object } = () => ({ status: 200 });

const server = http2.createServer();
server.on('stream', (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
  let body = '';
  stream.setEncoding('utf8');
  stream.on('data', (c: string) => (body += c));
  stream.on('end', () => {
    const s = { path: String(headers[':path']), headers, body: JSON.parse(body) as unknown };
    seen.push(s);
    const r = respond(s);
    stream.respond({ ':status': r.status, 'apns-id': 'A1B2C3D4-0000-0000-0000-000000000001' });
    stream.end(r.body ? JSON.stringify(r.body) : undefined);
  });
});

let client: ApnsClient;
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  client = new ApnsClient({ keyId: 'KEY1234567', teamId: 'TYKCDFU4XA', key: p8 }, { origins: { sandbox: origin, production: origin } });
});
beforeEach(() => {
  seen = [];
  respond = () => ({ status: 200 });
});
afterAll(async () => {
  await client.close();
  await new Promise((resolve) => server.close(resolve));
});

const request = {
  token: 'ab'.repeat(32),
  env: 'sandbox' as const,
  pushType: 'alert' as const,
  topic: 'com.joshuazacek.TrainTracker',
  priority: 10 as const,
  payload: { aps: { alert: { title: 't', body: 'b' } } },
};

describe('ApnsClient', () => {
  it('posts to /3/device/<token> with the APNs headers and a valid ES256 provider token', async () => {
    const result = await client.send({ ...request, collapseId: 'j1:delay', expiration: 123 });
    expect(result).toEqual({ ok: true, status: 200, apnsId: 'A1B2C3D4-0000-0000-0000-000000000001', reason: null, unregistered: false, retryable: false });

    const [s] = seen;
    expect(s!.path).toBe(`/3/device/${request.token}`);
    expect(s!.headers).toMatchObject({
      'apns-push-type': 'alert',
      'apns-topic': 'com.joshuazacek.TrainTracker',
      'apns-priority': '10',
      'apns-collapse-id': 'j1:delay',
      'apns-expiration': '123',
    });
    expect(s!.body).toEqual(request.payload);

    const [header, claims, signature] = String(s!.headers.authorization).replace(/^bearer /, '').split('.');
    expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toEqual({ alg: 'ES256', kid: 'KEY1234567' });
    expect(JSON.parse(Buffer.from(claims!, 'base64url').toString())).toMatchObject({ iss: 'TYKCDFU4XA' });
    const valid = crypto.verify(
      'sha256',
      Buffer.from(`${header}.${claims}`),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature!, 'base64url'),
    );
    expect(valid).toBe(true);
  });

  it('reuses one provider token and one connection across pushes', async () => {
    await Promise.all([client.send(request), client.send(request), client.send(request)]);
    expect(new Set(seen.map((s) => s.headers.authorization)).size).toBe(1);
  });

  it('re-signs the provider token once when APNs says it expired', async () => {
    let calls = 0;
    respond = () => (++calls === 1 ? { status: 403, body: { reason: 'ExpiredProviderToken' } } : { status: 200 });
    const result = await client.send(request);
    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(2);
  });

  it('marks dead tokens as unregistered and throttling as retryable', async () => {
    respond = () => ({ status: 410, body: { reason: 'Unregistered', timestamp: 1 } });
    expect(await client.send(request)).toMatchObject({ ok: false, status: 410, reason: 'Unregistered', unregistered: true, retryable: false });

    respond = () => ({ status: 400, body: { reason: 'BadDeviceToken' } });
    expect(await client.send(request)).toMatchObject({ unregistered: true, retryable: false });

    respond = () => ({ status: 400, body: { reason: 'PayloadTooLarge' } });
    expect(await client.send(request)).toMatchObject({ unregistered: false, retryable: false });

    respond = () => ({ status: 429, body: { reason: 'TooManyRequests' } });
    expect(await client.send(request)).toMatchObject({ unregistered: false, retryable: true });
  });

  it('reports a connection failure as retryable instead of throwing', async () => {
    const dead = new ApnsClient({ keyId: 'K', teamId: 'T', key: p8 }, { origins: { sandbox: 'http://127.0.0.1:1', production: 'http://127.0.0.1:1' } });
    expect(await dead.send(request)).toMatchObject({ ok: false, status: 0, retryable: true });
    await dead.close();
  });

  it('refuses a key that is not an EC .p8 key', () => {
    const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(() => new ApnsClient({ keyId: 'K', teamId: 'T', key: rsa })).toThrow(/EC/);
  });
});
