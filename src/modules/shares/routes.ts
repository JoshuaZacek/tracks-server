import { defineRoute, type AnyRoute } from '../../http/route.ts';
import { JourneyParams, JourneyShare } from '../journeys/schemas.ts';
import { SharedJourney, SharedParams } from './schemas.ts';
import { createShare, getShared, revokeShares } from './service.ts';

export const shareRoutes: AnyRoute[] = [
  defineRoute({
    method: 'post',
    path: '/v1/journeys/{id}/share',
    operationId: 'shareJourney',
    summary: 'Share a journey: a public link to its live status',
    description:
      'Returns 201 with a new link, or 200 with the one already working. Anyone with the link sees the train, my two stations, times, ' +
      'delay, platform and position (`GET /v1/shared/{token}`, and a page at the link), nothing about the device or its settings. ' +
      'The link works until 6 h after the scheduled arrival, or until `DELETE`. 422 `journey_over` once that time has passed.',
    tags: ['Sharing'],
    auth: true,
    request: { params: JourneyParams },
    response: { status: 201, description: 'The link (200 if it was already shared)', schema: JourneyShare },
    errors: [404, 422],
    async handler({ params, device, deps, setStatus }) {
      const { share, created } = await createShare(deps, device, params.id);
      if (!created) setStatus(200);
      return share;
    },
  }),
  defineRoute({
    method: 'delete',
    path: '/v1/journeys/{id}/share',
    operationId: 'stopSharingJourney',
    summary: 'Stop sharing a journey',
    description: 'Every link to it stops working at once (404). Succeeds when it was not shared.',
    tags: ['Sharing'],
    auth: true,
    request: { params: JourneyParams },
    response: { status: 204, description: 'Stopped' },
    errors: [404],
    async handler({ params, device, deps }) {
      await revokeShares(deps, device, params.id);
      return undefined;
    },
  }),
  defineRoute({
    method: 'get',
    path: '/v1/shared/{token}',
    operationId: 'getSharedJourney',
    summary: 'A shared journey (public)',
    description:
      'No auth: the token is the permission. 404 `share_not_found` for an unknown, revoked or expired link. Rate-limited per client. ' +
      'Poll at `nextPollSeconds`.',
    tags: ['Sharing'],
    auth: false,
    rateLimit: 'shared',
    request: { params: SharedParams },
    response: { status: 200, description: 'The train and my two stations', schema: SharedJourney },
    errors: [404],
    async handler({ params, deps, res }) {
      res.set('Cache-Control', 'no-store');
      return getShared(deps, params.token);
    },
  }),
];
