import type { Logger } from '../types';

let sink: Logger | undefined;

/** Routes Projects warnings to the gateway logger, so they reach `logs/gateway.log` and not only the console. */
export function setProjectsLogger(logger: Logger | undefined): void {
  sink = logger;
}

export function projectsWarn(message: string, data?: Record<string, unknown>): void {
  if (sink) sink.warn(message, data);
  else console.warn(message);
}

export function projectsInfo(message: string, data?: Record<string, unknown>): void {
  if (sink) sink.info(message, data);
  else console.info(message);
}
