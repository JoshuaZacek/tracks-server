import { defineRoute, type AnyRoute } from '../../http/route.ts';
import { CreateTripRequest, ReplaceLegRequest, Trip, TripLegParams, TripParams } from './schemas.ts';
import { createTrip, deleteTrip, getTrip, replaceLeg } from './service.ts';

export const tripRoutes: AnyRoute[] = [
  defineRoute({
    method: 'post',
    path: '/v1/trips',
    operationId: 'createTrip',
    summary: 'Link journeys into a trip with changes',
    description:
      'The journeys become the legs of one trip, in the order given, and the server follows each change ("Will I make it?"): ' +
      'every journey and journey list item then carries `trip` and, but for the last leg, `connection`. A `connection` alert ' +
      'is sent when a change becomes at_risk or missed (with the next train that works) and when it is back on. To add a ' +
      "connecting train to a trip, send all its legs plus the new one. 404 when a journey isn't this device's; 422 " +
      '`not_connected` when a leg does not leave from where the one before arrives, or leaves before it is due there.',
    tags: ['Trips'],
    auth: true,
    request: { body: CreateTripRequest },
    response: { status: 201, description: 'The trip', schema: Trip },
    errors: [404, 422],
    handler: ({ body, device, deps }) => createTrip(deps, device, body.journeyIds),
  }),
  defineRoute({
    method: 'get',
    path: '/v1/trips/{id}',
    operationId: 'getTrip',
    summary: 'A trip: each leg with its live status, and each change with alternatives',
    tags: ['Trips'],
    auth: true,
    request: { params: TripParams },
    response: { status: 200, description: 'The trip', schema: Trip },
    errors: [404],
    handler: ({ params, device, deps }) => getTrip(deps, device, params.id),
  }),
  defineRoute({
    method: 'put',
    path: '/v1/trips/{id}/legs/{leg}',
    operationId: 'replaceTripLeg',
    summary: 'Switch a leg to another train',
    description:
      'Saves a journey on the given train between the same stations as leg `leg`, puts it in the trip in place of that leg and ' +
      'deletes the old journey (end its Live Activity on the device). Use it with one of `connections[].alternatives`. ' +
      '404 for an unknown trip or leg, or a train not running; 422 `station_not_on_route` when the train does not call at both ' +
      'stations, `not_connected` when it leaves before the leg before is due.',
    tags: ['Trips'],
    auth: true,
    request: { params: TripLegParams, body: ReplaceLegRequest },
    response: { status: 200, description: 'The trip with the new leg', schema: Trip },
    errors: [404, 422],
    handler: ({ params, body, device, deps }) => replaceLeg(deps, device, params.id, params.leg, body),
  }),
  defineRoute({
    method: 'delete',
    path: '/v1/trips/{id}',
    operationId: 'deleteTrip',
    summary: 'Unlink a trip',
    description: 'Its journeys stay, each on its own.',
    tags: ['Trips'],
    auth: true,
    request: { params: TripParams },
    response: { status: 204, description: 'Unlinked' },
    errors: [404],
    async handler({ params, device, deps }) {
      await deleteTrip(deps, device, params.id);
      return undefined;
    },
  }),
];
