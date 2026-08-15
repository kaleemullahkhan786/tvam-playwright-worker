/**
 * Simple structured logger for the worker.
 */

function stamp() {
  return new Date().toISOString();
}

export const logger = {
  info(message, meta) {
    console.log(`[${stamp()}] INFO  ${message}`, meta ? meta : '');
  },
  warn(message, meta) {
    console.warn(`[${stamp()}] WARN  ${message}`, meta ? meta : '');
  },
  error(message, meta) {
    console.error(`[${stamp()}] ERROR ${message}`, meta ? meta : '');
  },
};
