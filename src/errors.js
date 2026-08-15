/**
 * Typed automation error codes.
 */

export const ErrorCodes = Object.freeze({
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  USERNAME_NOT_FOUND: 'USERNAME_NOT_FOUND',
  USERNAME_LOADING_TIMEOUT: 'USERNAME_LOADING_TIMEOUT',
  SCRIPT_NOT_FOUND: 'SCRIPT_NOT_FOUND',
  SELECTOR_NOT_FOUND: 'SELECTOR_NOT_FOUND',
  NETWORK_ERROR: 'NETWORK_ERROR',
  TIMEOUT: 'TIMEOUT',
  ALREADY_GRANTED: 'ALREADY_GRANTED',
  ALREADY_REVOKED: 'ALREADY_REVOKED',
  MODAL_CLOSED: 'MODAL_CLOSED',
  VERIFICATION_FAILED: 'VERIFICATION_FAILED',
  EXPIRY_NOT_VERIFIABLE: 'EXPIRY_NOT_VERIFIABLE',
  EXPIRY_MISMATCH: 'EXPIRY_MISMATCH',
  UNKNOWN: 'UNKNOWN',
});

export class AutomationError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {object} [meta]
   */
  constructor(code, message, meta = {}) {
    super(message);
    this.name = 'AutomationError';
    this.code = code || ErrorCodes.UNKNOWN;
    this.meta = meta;
  }
}
