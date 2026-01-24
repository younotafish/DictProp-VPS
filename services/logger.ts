/**
 * Simple logger utility that only logs in development mode.
 * In production, all logs are silenced to keep the console clean.
 */

const isDev = import.meta.env.DEV;

/**
 * Log informational messages (development only)
 */
export const log = (...args: unknown[]): void => {
  if (isDev) console.log(...args);
};

/**
 * Log warning messages (development only)
 */
export const warn = (...args: unknown[]): void => {
  if (isDev) console.warn(...args);
};

/**
 * Log error messages (always shown - errors should be visible in production)
 */
export const error = (...args: unknown[]): void => {
  console.error(...args);
};

/**
 * Log debug messages with a prefix (development only)
 */
export const debug = (prefix: string, ...args: unknown[]): void => {
  if (isDev) console.log(`[${prefix}]`, ...args);
};

export const logger = {
  log,
  warn,
  error,
  debug,
};

export default logger;
