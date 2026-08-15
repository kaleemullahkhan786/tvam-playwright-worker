/**
 * WordPress REST API client for TVAM.
 */

import { config } from './config.js';
import { logger } from './logger.js';

async function request(method, route, body) {
  const url = `${config.apiBaseUrl}${route}`;
  const headers = {
    Accept: 'application/json',
    'X-TVAM-API-Key': config.apiKey,
  };

  const options = { method, headers };

  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);
  const text = await response.text();
  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const message =
      data?.message || data?.code || `HTTP ${response.status} for ${method} ${route}`;
    const error = new Error(message);
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

/**
 * Post job result with retries.
 */
async function postJobResultWithRetry(payload, attempts = 5) {
  let lastError = null;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      return await request('POST', '/job-result', payload);
    } catch (err) {
      lastError = err;
      logger.warn('job-result post failed; retrying', {
        attempt: i,
        error: err.message,
        status: err.status,
      });
      await new Promise((r) => setTimeout(r, 500 * i));
    }
  }
  throw lastError;
}

export const api = {
  async getPendingJobs(limit = config.jobLimit) {
    const qs = new URLSearchParams({ limit: String(limit) });
    logger.info('Polling pending jobs', { limit });
    return request('GET', `/pending-jobs?${qs.toString()}`);
  },

  async postJobResult(payload) {
    logger.info('Posting job result', {
      job_id: payload.job_id,
      status: payload.status,
      error_code: payload.error_code || null,
    });
    return postJobResultWithRetry(payload);
  },

  async postJobStep(jobId, message, level = 'info') {
    try {
      return await request('POST', '/job-step', {
        job_id: jobId,
        message,
        level,
      });
    } catch (err) {
      logger.warn('job-step post failed', { job_id: jobId, error: err.message });
      return null;
    }
  },
};
