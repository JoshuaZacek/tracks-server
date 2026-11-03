import { darwinEnabled } from '../../app.ts';
import { defineRoute, type AnyRoute } from '../../http/route.ts';
import { CrsParams, DeparturesQuery, DeparturesResponse, NearbyQuery, NearbyStationList, Station, StationList, StationSearchQuery } from './schemas.ts';
import { findDepartures, getStation, nearbyStations, searchStations } from './service.ts';

export const stationRoutes: AnyRoute[] = [
  defineRoute({
    method: 'get',
    path: '/v1/stations',
    operationId: 'searchStations',
    summary: 'Search stations by name or CRS code',
    description: 'Ranked: exact CRS, then name prefix, then word prefix, then contains.',
    tags: ['Stations'],
    auth: true,
    request: { query: StationSearchQuery },
    response: { status: 200, description: 'Matching stations, best first', schema: StationList },
    async handler({ query, deps }) {
      return { stations: await searchStations(deps.db, query.q, query.limit) };
    },
  }),
  defineRoute({
    method: 'get',
    path: '/v1/stations/nearby',
    operationId: 'nearbyStations',
    summary: 'Stations nearest to a position',
    description: 'The position is used for this lookup only and is not stored.',
    tags: ['Stations'],
    auth: true,
    request: { query: NearbyQuery },
    response: { status: 200, description: 'Nearest stations, closest first', schema: NearbyStationList },
    async handler({ query, deps }) {
      return { stations: await nearbyStations(deps.db, query.lat, query.lon, query.limit) };
    },
  }),
  defineRoute({
    method: 'get',
    path: '/v1/stations/{crs}',
    operationId: 'getStation',
    summary: 'One station',
    tags: ['Stations'],
    auth: true,
    request: { params: CrsParams },
    response: { status: 200, description: 'The station', schema: Station },
    errors: [404],
    handler: ({ params, deps }) => getStation(deps.db, params.crs),
  }),
  defineRoute({
    method: 'get',
    path: '/v1/stations/{crs}/departures',
    operationId: 'listDepartures',
    summary: 'Timetabled departures from a station on a date',
    description:
      'Passenger trains leaving `crs` on `date`, including trains that started the previous day and call after midnight. ' +
      "Paged by `cursor` (`nextCursor` from the previous page). For today's trains each item carries a `live` overlay " +
      'from Darwin (Phase 4; null until then). 503 `schedule_not_loaded` before the first timetable import.',
    tags: ['Stations'],
    auth: true,
    request: { params: CrsParams, query: DeparturesQuery },
    response: { status: 200, description: 'A page of departures', schema: DeparturesResponse },
    errors: [404, 503],
    handler: ({ params, query, deps }) => findDepartures(deps.db, { ...query, from: params.crs }, darwinEnabled(deps) ? deps.lookups : undefined),
  }),
];
