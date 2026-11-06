import { z } from 'zod';
import { DateTime, HexToken, Uuid } from '../../http/schemas.ts';

export const NotificationPrefs = z
  .object({
    delays: z.boolean(),
    platforms: z.boolean(),
    cancellations: z.boolean(),
    departure: z.boolean(),
    arrival: z.boolean(),
    delayThresholdMinutes: z.number().int().min(1).max(60).meta({ description: 'Alert when the delay reaches this many minutes' }),
    liveActivity: z.boolean().meta({ description: 'Start a Live Activity automatically 30 minutes before departure (needs pushToStartToken)' }),
    morningSummary: z.boolean().meta({ description: "Regular journeys: a summary of the train's status at the template's summaryTime (kind morning_summary)" }),
    leaveNow: z
      .boolean()
      .meta({ description: 'Journeys with travelMinutes: an alert when it is time to leave for the station, moved later if the train runs late (kind leave_now)' }),
  })
  .meta({ id: 'NotificationPrefs' });

export const DEFAULT_PREFS: z.output<typeof NotificationPrefs> = {
  delays: true,
  platforms: true,
  cancellations: true,
  departure: true,
  arrival: true,
  delayThresholdMinutes: 5,
  liveActivity: true,
  morningSummary: true,
  leaveNow: true,
};

const ApnsEnvironment = z.enum(['sandbox', 'production']).meta({ id: 'ApnsEnvironment' });
const AppVersion = z.string().trim().min(1).max(32).meta({ example: '1.0 (42)' });
const Locale = z.string().trim().min(2).max(35).meta({ example: 'en_GB' });

export const RegisterDeviceRequest = z
  .object({
    appVersion: AppVersion,
    locale: Locale.optional(),
  })
  .meta({ id: 'RegisterDeviceRequest' });

export const RegisterDeviceResponse = z
  .object({
    deviceId: Uuid,
    token: z.string().meta({ description: 'Bearer token for every other call. Shown once: store it in the Keychain.' }),
  })
  .meta({ id: 'RegisterDeviceResponse' });

export const UpdateDeviceRequest = z
  .object({
    apnsToken: HexToken.nullable().optional().meta({ description: 'Remote notification device token; null to unregister' }),
    apnsEnvironment: ApnsEnvironment.optional().meta({ description: 'sandbox for debug builds, production for TestFlight/App Store' }),
    pushToStartToken: HexToken.nullable().optional().meta({ description: 'ActivityKit push-to-start token (iOS 17.2+); null to clear' }),
    appVersion: AppVersion.optional(),
    locale: Locale.nullable().optional(),
    prefs: NotificationPrefs.partial().meta({ id: 'NotificationPrefsUpdate' }).optional(),
  })
  .meta({ id: 'UpdateDeviceRequest' });

export const Device = z
  .object({
    deviceId: Uuid,
    apnsTokenRegistered: z.boolean(),
    apnsEnvironment: ApnsEnvironment,
    pushToStartTokenRegistered: z.boolean(),
    appVersion: z.string(),
    locale: z.string().nullable(),
    prefs: NotificationPrefs,
    createdAt: DateTime,
  })
  .meta({ id: 'Device' });
