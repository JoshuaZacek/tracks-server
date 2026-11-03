import { pino, type Logger } from 'pino';
import type { Config } from './config/env.ts';

export type { Logger };

/** JSON logs in production; readable logs when developing in a terminal. */
export function createLogger(config: Pick<Config, 'logLevel' | 'env'>, name: string): Logger {
  const pretty = config.env === 'development' && process.stdout.isTTY;
  return pino({
    name,
    level: config.logLevel,
    redact: { paths: ['req.headers.authorization', 'req.headers.cookie'], censor: '[redacted]' },
    ...(pretty ? { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' } } } : {}),
  });
}
