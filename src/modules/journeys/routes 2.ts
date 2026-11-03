import { defineRoute, type AnyRoute } from '../../http/route.ts';
import {
  CreateJourneyRequest,
  Journey,
  JourneyList,
  JourneyListQuery,
  JourneyParams,
  LiveStatus,
  RegisterLiveActivityRequest,
  UpdateJourneyRequest,
} from './schemas.ts';

import {
  createJourney,
  deleteJourney,
  endLiveActivity,
  getJourney,
  getJourneyLive,
  listJourneys,
  registerLiveActivity,
  updateJourney,
} from './service.ts';

export const journeyRoutes: AnyRoute[] = [
  defineRoute({
    method: 'get',
    path: '/v1/journeys',
    operationId: 'listJourneys',
    summary: "This device's saved journeys",
    description:
      '`past`: archived, arrived, or scheduled arrival gone by while the train is not running (a late train stays upcoming until it ' +
      'arrives); newest first. `upcoming`: everything else, soonest first. `nextPollSeconds` says when to refresh while the list is open.',
    tags: ['Journeys'],
    auth: true,
    request: { query: JourneyListQuery },
    response: { status: 200, description: 'Journeys with a live summary each', schema: JourneyList },
    handler: ({ query, device, deps }) => listJourneys(deps, device, query.scope, query.limit),
  }),
  defineRoute({
    method: 'post',
    path: '/v1/journeys',
    operationId: 'createJourney',
    summary: 'Save a journey on a timetabled train',
    description:
      'Checks the train runs on `runDate` and calls at `fromCrs` then `toCrs`, snapshots its calling points and starts tracking. ' +
      'Returns 201 for a new journey, or 200 with the existing one (un-archived) if this device already saved the same trip. ' +
      'Past run dates are accepted while the timetable still covers them (they appear under `past`); otherwise 404 ' +
      '`train_not_running`. 422 `station_not_on_route` if the train does not pick up at `fromCrs` or set down at `toCrs` after it.',
    tags: ['Journeys'],
    auth: true,
    request: { body: CreateJourneyRequest },
    response: { status: 201, description: 'The saved journey (200 if it already existed)', schema: Journey },
    errors: [404, 422, 503],
    async handler({ body, device, deps, setStatus }) {
      const { journey, created } = await createJourney(deps, device, body);
      if (!created) setStatus(200);
      return journey;
    },
  }),
  defineRoute({
    method: 'get',
    path: '/v1/journeys/{id}',
    operationId: 'getJourney',
    summary: 'A saved journey with its current live status',
    tags: ['Journeys'],
    auth: true,
    request: { params: JourneyParams },
    response: { status: 200, description: 'The journey', schema: Journey },
    errors: [404],
    handler: ({ params, device, deps }) => getJourney(deps, device, params.id),
  }),
  defineRoute({
    method: 'patch',
    path: '/v1/journeys/{id}',
    operationId: 'updateJourney',
    summary: 'Change notification overrides or archive a journey',
    tags: ['Journeys'],
    auth: true,
    request: { params: JourneyParams, body: UpdateJourneyRequest },
    response: { status: 200, description: 'The updated journey', schema: Journey },
    errors: [404],
    handler: ({ params, body, device, deps }) => updateJourney(deps, device, params.id, body),
  }),
  defineRoute({
    method: 'delete',
    path: '/v1/journeys/{id}',
    operationId: 'deleteJourney',
    summary: 'Delete a journey and stop tracking it',
    description: 'The server forgets any Live Activity token with it, so end the activity on the device too.',
    tags: ['Journeys'],
    auth: true,
    request: { params: JourneyParams },
    response: { status: 204, description: 'Deleted' },
    errors: [404],
    async handler({ params, device, deps }) {
      await deleteJourney(deps, device, params.id);
      return undefined;
    },
  }),
  defineRoute({
    method: 'get',
    path: '/v1/journeys/{id}/live',
    operationId: 'getJourneyLive',
    summary: 'Just the live status of a journey',
    description:
      'Cheap to poll while the app is open: it reads stored state and never calls upstream. Respect `nextPollSeconds`. ' +
      'Without live data for the run this is the timetable view: state `scheduled`, no service/progress/position.',
    tags: ['Journeys'],
    auth: true,
    request: { params: JourneyParams },
    response: { status: 200, description: 'Live status', schema: LiveStatus },
    errors: [404],
    handler: ({ params, device, deps }) => getJourneyLive(deps, device, params.id),
  }),
  defineRoute({
    method: 'put',
    path: '/v1/journeys/{id}/live-activity',
    operationId: 'registerLiveActivity',
    summary: 'Register the push token of a Live Activity for this journey',
    description:
      'Send the token from `Activity.pushTokenUpdates`, whether the app started the activity or the server did (push-to-start), ' +
      'and again whenever iOS rotates it. The server then pushes `TrainActivityAttributes` content updates (at most one per ' +
      '15 s) and ends the activity on arrival, cancellation or not_found. Re-registering after the activity ended starts pushing again.',
    tags: ['Live Activities'],
    auth: true,
    request: { params: JourneyParams, body: RegisterLiveActivityRequest },
    response: { status: 204, description: 'Registered; the server will push updates to it' },
    errors: [404],
    async handler({ params, body, device, deps }) {
      await registerLiveActivity(deps, device, params.id, body.pushToken);
      return undefined;
    },
  }),
  defineRoute({
    method: 'delete',
    path: '/v1/journeys/{id}/live-activity',
    operationId: 'endLiveActivity',
    summary: 'The user ended the Live Activity; stop pushing to it',
    description: 'The server will not push-to-start another one for this journey. Succeeds even if none was registered.',
    tags: ['Live Activities'],
    auth: true,
    request: { params: JourneyParams },
    response: { status: 204, description: 'Stopped' },
    errors: [404],
    async handler({ params, device, deps }) {
      await endLiveActivity(deps, device, params.id);
      return undefined;
    },
  }),
];
