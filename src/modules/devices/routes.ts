import type { DeviceRow, DeviceUpdate } from '../../db/types.ts';
import { defineRoute, type AnyRoute } from '../../http/route.ts';
import { newDeviceToken } from '../../http/middleware/auth.ts';
import { toUkIso } from '../../time.ts';
import { DEFAULT_PREFS, Device, RegisterDeviceRequest, RegisterDeviceResponse, UpdateDeviceRequest } from './schemas.ts';

function toDevice(row: DeviceRow) {
  return {
    deviceId: row.id,
    apnsTokenRegistered: row.apns_token !== null,
    apnsEnvironment: row.apns_env,
    pushToStartTokenRegistered: row.push_to_start_token !== null,
    appVersion: row.app_version,
    locale: row.locale,
    prefs: { ...DEFAULT_PREFS, ...row.prefs },
    createdAt: toUkIso(row.created_at),
  };
}

export const deviceRoutes: AnyRoute[] = [
  defineRoute({
    method: 'post',
    path: '/v1/devices',
    operationId: 'registerDevice',
    summary: 'Register this app install',
    description:
      'Call once on first launch. Returns the bearer token for every other request; it is shown only once and the server ' +
      'keeps only a hash of it. Rate-limited per IP.',
    tags: ['Devices'],
    auth: false,
    rateLimit: 'registration',
    request: { body: RegisterDeviceRequest },
    response: { status: 201, description: 'Registered', schema: RegisterDeviceResponse },
    async handler({ body, deps }) {
      const { token, hash } = newDeviceToken();
      const row = await deps.db
        .insertInto('devices')
        .values({
          token_hash: hash,
          app_version: body.appVersion,
          locale: body.locale ?? null,
          apns_env: 'production',
          prefs: JSON.stringify(DEFAULT_PREFS),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return { deviceId: row.id, token };
    },
  }),
  defineRoute({
    method: 'get',
    path: '/v1/devices/me',
    operationId: 'getDevice',
    summary: 'This app install',
    tags: ['Devices'],
    auth: true,
    response: { status: 200, description: 'The device', schema: Device },
    handler: ({ device }) => toDevice(device),
  }),
  defineRoute({
    method: 'patch',
    path: '/v1/devices/me',
    operationId: 'updateDevice',
    summary: 'Update push tokens, app version, locale or notification preferences',
    description: 'Only the fields sent are changed; `prefs` is merged into the current preferences.',
    tags: ['Devices'],
    auth: true,
    request: { body: UpdateDeviceRequest },
    response: { status: 200, description: 'The updated device', schema: Device },
    async handler({ body, device, deps }) {
      const changes: DeviceUpdate = {};
      if (body.apnsToken !== undefined) changes.apns_token = body.apnsToken;
      if (body.apnsEnvironment !== undefined) changes.apns_env = body.apnsEnvironment;
      if (body.pushToStartToken !== undefined) changes.push_to_start_token = body.pushToStartToken;
      if (body.appVersion !== undefined) changes.app_version = body.appVersion;
      if (body.locale !== undefined) changes.locale = body.locale;
      if (body.prefs !== undefined) changes.prefs = JSON.stringify({ ...DEFAULT_PREFS, ...device.prefs, ...body.prefs });
      if (Object.keys(changes).length === 0) return toDevice(device);

      const row = await deps.db.updateTable('devices').set(changes).where('id', '=', device.id).returningAll().executeTakeFirstOrThrow();
      return toDevice(row);
    },
  }),
  defineRoute({
    method: 'delete',
    path: '/v1/devices/me',
    operationId: 'deleteDevice',
    summary: 'Delete this app install and all its data',
    description: 'Removes the device, its journeys and Live Activity registrations. The token stops working immediately.',
    tags: ['Devices'],
    auth: true,
    response: { status: 204, description: 'Deleted' },
    async handler({ device, deps }) {
      await deps.db.deleteFrom('devices').where('id', '=', device.id).execute();
      return undefined;
    },
  }),
];
