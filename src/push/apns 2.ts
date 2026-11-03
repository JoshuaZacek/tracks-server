import crypto from 'node:crypto';
import http2 from 'node:http2';
import type { ApnsEnvironment } from '../db/types.ts';

/**
 * A small APNs client on Node's built-in HTTP/2 (no dependencies).
 *
 * Apple's push service speaks HTTP/2: each push is one `POST /3/device/<token>`
 * request on a long-lived connection, many in flight at once. Auth is a
 * "provider token": a short JWT signed with the team's .p8 key (ES256), sent
 * as `authorization: bearer …`. Apple wants it reused for 20–60 minutes, so it
 * is cached and re-signed every 50 minutes (or straight away if APNs says it
 * expired).
 */

export const APNS_ORIGINS: Record<ApnsEnvironment, string> = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
};

export interface PushRequest {
  /** Hex device token (alerts), Live Activity update token, or push-to-start token. */
  token: string;
  env: ApnsEnvironment;
  pushType: 'alert' | 'liveactivity';
  topic: string;
  /** 10 = deliver now; 5 = when convenient (doesn't count against the Live Activity budget). */
  priority: 5 | 10;
  payload: object;
  /** Unix seconds after which APNs should stop trying; 0 = deliver once or not at all. */
  expiration?: number;
  /** Replaces an earlier notification with the same id on the device (max 64 bytes). */
  collapseId?: string;
}

export interface PushResult {
  ok: boolean;
  /** HTTP status; 0 when the request never got a response. */
  status: number;
  apnsId: string | null;
  /** APNs' reason string, e.g. "BadDeviceToken". */
  reason: string | null;
  /** The token is no longer valid: forget it. */
  unregistered: boolean;
  /** A temporary problem (throttling, APNs down, network): worth trying again later. */
  retryable: boolean;
}

export interface PushSender {
  send(request: PushRequest): Promise<PushResult>;
  close(): Promise<void>;
}

export interface ApnsCredentials {
  keyId: string;
  teamId: string;
  /** Contents of the .p8 file (PKCS#8 PEM). */
  key: string;
}

const TOKEN_TTL_MS = 50 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
/** Reasons that mean the token itself is bad; anything else with 400 is a bug on our side. */
const BAD_TOKEN_REASONS = new Set(['BadDeviceToken', 'DeviceTokenNotForTopic', 'Unregistered', 'ExpiredToken']);

const b64url = (data: Buffer | string) => Buffer.from(data).toString('base64url');

export class ApnsClient implements PushSender {
  private readonly credentials: ApnsCredentials;
  private readonly privateKey: crypto.KeyObject;
  private readonly origins: Record<ApnsEnvironment, string>;
  private readonly sessions = new Map<ApnsEnvironment, http2.ClientHttp2Session>();
  private providerToken: { jwt: string; at: number } | null = null;

  constructor(credentials: ApnsCredentials, opts: { origins?: Record<ApnsEnvironment, string> } = {}) {
    this.credentials = credentials;
    this.privateKey = crypto.createPrivateKey(credentials.key);
    if (this.privateKey.asymmetricKeyType !== 'ec') throw new Error('APNs key must be the EC (.p8) key from Apple Developer');
    this.origins = opts.origins ?? APNS_ORIGINS;
  }

  /** The cached provider token, re-signed when old (or when APNs rejected it). */
  private jwt(force = false) {
    const now = Date.now();
    if (!force && this.providerToken && now - this.providerToken.at < TOKEN_TTL_MS) return this.providerToken.jwt;
    const header = b64url(JSON.stringify({ alg: 'ES256', kid: this.credentials.keyId }));
    const claims = b64url(JSON.stringify({ iss: this.credentials.teamId, iat: Math.floor(now / 1000) }));
    const signature = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), { key: this.privateKey, dsaEncoding: 'ieee-p1363' });
    this.providerToken = { jwt: `${header}.${claims}.${b64url(signature)}`, at: now };
    return this.providerToken.jwt;
  }

  /** One connection per environment, reopened if it closes. */
  private session(env: ApnsEnvironment) {
    const existing = this.sessions.get(env);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const session = http2.connect(this.origins[env]);
    const forget = () => {
      if (this.sessions.get(env) === session) this.sessions.delete(env);
    };
    session.on('error', forget);
    session.on('close', forget);
    session.on('goaway', forget);
    // An idle connection must not keep the process alive on shutdown.
    session.unref();
    this.sessions.set(env, session);
    return session;
  }

  async send(request: PushRequest): Promise<PushResult> {
    let result = await this.attempt(request, this.jwt());
    if (result.status === 403 && (result.reason === 'ExpiredProviderToken' || result.reason === 'InvalidProviderToken')) {
      result = await this.attempt(request, this.jwt(true));
    }
    return result;
  }

  private attempt(request: PushRequest, jwt: string): Promise<PushResult> {
    return new Promise((resolve) => {
      const failed = (reason: string): PushResult => ({ ok: false, status: 0, apnsId: null, reason, unregistered: false, retryable: true });
      let stream: http2.ClientHttp2Stream;
      try {
        const headers: http2.OutgoingHttpHeaders = {
          ':method': 'POST',
          ':path': `/3/device/${request.token}`,
          authorization: `bearer ${jwt}`,
          'apns-push-type': request.pushType,
          'apns-topic': request.topic,
          'apns-priority': String(request.priority),
          'content-type': 'application/json',
        };
        if (request.expiration !== undefined) headers['apns-expiration'] = String(request.expiration);
        if (request.collapseId) headers['apns-collapse-id'] = request.collapseId;
        stream = this.session(request.env).request(headers);
      } catch (err) {
        resolve(failed(err instanceof Error ? err.message : 'connect failed'));
        return;
      }
      let status = 0;
      let apnsId: string | null = null;
      let body = '';
      stream.setTimeout(REQUEST_TIMEOUT_MS, () => stream.close(http2.constants.NGHTTP2_CANCEL));
      stream.on('response', (h) => {
        status = Number(h[':status']);
        apnsId = typeof h['apns-id'] === 'string' ? h['apns-id'] : null;
      });
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => (body += chunk));
      stream.on('error', (err) => resolve(failed(err.message)));
      stream.on('close', () => {
        if (!status) return resolve(failed('no response'));
        let reason: string | null;
        try {
          reason = body ? ((JSON.parse(body) as { reason?: string }).reason ?? null) : null;
        } catch {
          reason = body.slice(0, 100) || null;
        }
        resolve({
          ok: status === 200,
          status,
          apnsId,
          reason,
          unregistered: status === 410 || (status === 400 && reason !== null && BAD_TOKEN_REASONS.has(reason)),
          retryable: status === 429 || status >= 500,
        });
      });
      stream.end(JSON.stringify(request.payload));
    });
  }

  async close() {
    await Promise.all(
      [...this.sessions.values()].map((s) => new Promise<void>((resolve) => (s.closed ? resolve() : s.close(() => resolve())))),
    );
    this.sessions.clear();
  }
}
