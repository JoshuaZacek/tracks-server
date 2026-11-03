import { darwinEnabled } from '../../app.ts';
import { defineRoute, type AnyRoute } from '../../http/route.ts';
import { TrainDetails, TrainParams } from './schemas.ts';
import { getTrain } from './service.ts';

export const trainRoutes: AnyRoute[] = [
  defineRoute({
    method: 'get',
    path: '/v1/trains/{uid}/{runDate}',
    operationId: 'getTrain',
    summary: 'A train run: calling points and route',
    description:
      'The timetable for one run of a train after short-term (STP) changes. 404 `train_not_running` when it is cancelled ' +
      'or not a passenger train that day. Calling points carry `live` data once Darwin has the run (Phase 4).',
    tags: ['Trains'],
    auth: true,
    request: { params: TrainParams },
    response: { status: 200, description: 'The train run', schema: TrainDetails },
    errors: [404, 503],
    handler: ({ params, deps }) => getTrain(deps.db, params.uid, params.runDate, darwinEnabled(deps) ? deps.lookups : undefined),
  }),
];
