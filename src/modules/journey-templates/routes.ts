import { defineRoute, type AnyRoute } from '../../http/route.ts';
import { CreateJourneyTemplateRequest, JourneyTemplate, JourneyTemplateList, JourneyTemplateParams, UpdateJourneyTemplateRequest } from './schemas.ts';
import { createTemplate, deleteTemplate, listTemplates, updateTemplate } from './service.ts';

export const journeyTemplateRoutes: AnyRoute[] = [
  defineRoute({
    method: 'get',
    path: '/v1/journey-templates',
    operationId: 'listJourneyTemplates',
    summary: "This device's regular journeys",
    description: 'Ordered by departTime. `problem` is set when no train matched a date; `nextJourney` is the soonest upcoming journey made from each.',
    tags: ['Regular journeys'],
    auth: true,
    response: { status: 200, description: 'Regular journeys', schema: JourneyTemplateList },
    handler: ({ device, deps }) => listTemplates(deps, device),
  }),
  defineRoute({
    method: 'post',
    path: '/v1/journey-templates',
    operationId: 'createJourneyTemplate',
    summary: 'Repeat a journey on certain weekdays',
    description:
      'The server makes a journey for today (while the time is ahead) and tomorrow on each chosen weekday, on the timetabled ' +
      'train from `fromCrs` calling at `toCrs` nearest `departTime` (within 30 min), and does so straight away for this one. ' +
      'With `journeyId`, that journey is linked and its date counts as made. A journey deleted later is not made again. ' +
      '404 for an unknown station or journey; 422 when fromCrs equals toCrs.',
    tags: ['Regular journeys'],
    auth: true,
    request: { body: CreateJourneyTemplateRequest },
    response: { status: 201, description: 'The regular journey, with its next journey', schema: JourneyTemplate },
    errors: [404, 422],
    handler: ({ body, device, deps }) => createTemplate(deps, device, body),
  }),
  defineRoute({
    method: 'patch',
    path: '/v1/journey-templates/{id}',
    operationId: 'updateJourneyTemplate',
    summary: 'Change a regular journey',
    description: 'New times or days apply to journeys made from now on, not to ones already made. `prefs` is merged like a journey’s.',
    tags: ['Regular journeys'],
    auth: true,
    request: { params: JourneyTemplateParams, body: UpdateJourneyTemplateRequest },
    response: { status: 200, description: 'The updated regular journey', schema: JourneyTemplate },
    errors: [404],
    handler: ({ params, body, device, deps }) => updateTemplate(deps, device, params.id, body),
  }),
  defineRoute({
    method: 'delete',
    path: '/v1/journey-templates/{id}',
    operationId: 'deleteJourneyTemplate',
    summary: 'Stop repeating',
    description: 'Journeys already made stay (their templateId becomes null); delete them separately if wanted.',
    tags: ['Regular journeys'],
    auth: true,
    request: { params: JourneyTemplateParams },
    response: { status: 204, description: 'Deleted' },
    errors: [404],
    async handler({ params, device, deps }) {
      await deleteTemplate(deps, device, params.id);
      return undefined;
    },
  }),
];
