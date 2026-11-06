import type { AnyRoute } from './http/route.ts';
import { deviceRoutes } from './modules/devices/routes.ts';
import { journeyTemplateRoutes } from './modules/journey-templates/routes.ts';
import { journeyRoutes } from './modules/journeys/routes.ts';
import { stationRoutes } from './modules/stations/routes.ts';
import { systemRoutes } from './modules/system/routes.ts';
import { trainRoutes } from './modules/trains/routes.ts';
import { tripRoutes } from './modules/trips/routes.ts';

/** Every endpoint. Order matters only where paths overlap: /v1/stations/nearby before /v1/stations/{crs}. */
export const routes: readonly AnyRoute[] = [...systemRoutes, ...deviceRoutes, ...stationRoutes, ...trainRoutes, ...journeyRoutes, ...journeyTemplateRoutes, ...tripRoutes];
