/**
 * Playwright worker entrypoint.
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';
import { api } from './api.js';
import { config } from './config.js';
import { AutomationError, ErrorCodes } from './errors.js';
import { logger } from './logger.js';
import { assertLoggedIn } from './session.js';
import { grantScriptAccess, revokeScriptAccess } from './tradingview.js';

const runOnce = process.argv.includes('--once');
const deadLetterDir = path.join(config.workerRoot, 'storage', 'dead-letter');
const screenshotsDir = path.join(config.workerRoot, 'storage', 'screenshots');

let shuttingDown = false;
let busy = false;
let pauseForSession = false;
let currentJob = null;
let healthServer = null;

/**
 * Render Web Services require a process bound to $PORT.
 * This endpoint is only a liveness probe — jobs still run via poll loop.
 */
function startHealthServer() {
  const port = Number.parseInt(process.env.PORT || '', 10);
  if (!Number.isFinite(port) || port <= 0) {
    return;
  }

  healthServer = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          busy,
          paused: pauseForSession,
          shuttingDown,
        })
      );
      return;
    }
    res.writeHead(404).end();
  });

  healthServer.listen(port, '0.0.0.0', () => {
    logger.info('Health server listening (Render PORT)', { port });
  });
}

function assertStorageState() {
  if (!fs.existsSync(config.storageStatePath)) {
    throw new Error(
      `Missing storage state at ${config.storageStatePath}. Run "npm run login" first.`
    );
  }
}

function persistDeadLetter(payload) {
  fs.mkdirSync(deadLetterDir, { recursive: true });
  const file = path.join(deadLetterDir, `job-${payload.job_id}-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
  logger.error('Persisted job-result for later replay', { file });
}

/**
 * Replay dead-letter job-result payloads once connectivity returns.
 */
async function replayDeadLetters() {
  if (!fs.existsSync(deadLetterDir)) {
    return;
  }

  const files = fs
    .readdirSync(deadLetterDir)
    .filter((name) => name.endsWith('.json'))
    .sort();

  if (!files.length) {
    return;
  }

  logger.info('Replaying dead-letter result callbacks', { count: files.length });

  for (const name of files) {
    if (shuttingDown) {
      break;
    }

    const file = path.join(deadLetterDir, name);
    let payload;
    try {
      payload = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      logger.warn('Unreadable dead-letter file; removing', { file, error: err.message });
      fs.unlinkSync(file);
      continue;
    }

    try {
      await api.postJobResult(payload);
      fs.unlinkSync(file);
      logger.info('Dead-letter replay succeeded', { file, job_id: payload.job_id });
    } catch (err) {
      // Job already finished / missing — drop the letter.
      if (err.status === 409 || err.status === 404) {
        fs.unlinkSync(file);
        logger.warn('Dead-letter obsolete; removed', {
          file,
          job_id: payload.job_id,
          status: err.status,
        });
        continue;
      }
      logger.warn('Dead-letter replay deferred (connectivity)', {
        file,
        error: err.message,
        status: err.status,
      });
      // Stop trying further letters this cycle if network is down.
      if (!err.status || err.status >= 500 || err.status === 0) {
        break;
      }
    }
  }
}

async function safePostResult(payload) {
  try {
    return await api.postJobResult(payload);
  } catch (err) {
    logger.error('Exhausted job-result retries; writing dead-letter', { error: err.message });
    persistDeadLetter(payload);
    throw err;
  }
}

function isSoftFailureCode(code) {
  return (
    code === ErrorCodes.EXPIRY_NOT_VERIFIABLE ||
    code === ErrorCodes.EXPIRY_MISMATCH ||
    code === 'EXPIRY_NOT_VERIFIABLE' ||
    code === 'EXPIRY_MISMATCH'
  );
}

async function processJob(context, job) {
  const page = await context.newPage();
  const results = [];
  let sessionExpired = false;

  const onStep = async (message, level = 'info') => {
    logger.info(`[job ${job.id}] ${message}`);
    await api.postJobStep(job.id, message, level);
  };

  try {
    const scripts = job.scripts || [];
    if (!scripts.length) {
      await onStep('Job has no scripts to process (empty script list).', 'error');
      return {
        allOk: false,
        sessionExpired: false,
        results: [],
        message: 'Job has no scripts to process. Re-queue Grant with scripts selected.',
        error_code: ErrorCodes.SCRIPT_NOT_FOUND,
      };
    }

    await onStep(
      `Starting ${job.action} for ${job.username} (${scripts.length} script(s))${job.is_test ? ' [TEST]' : ''}…`
    );

    for (const script of scripts) {
      if (shuttingDown) {
        break;
      }

      let attempt = 0;
      let lastError = null;
      let outcome = null;

      while (attempt <= config.workerRetries) {
        try {
          if (job.action === 'grant') {
            outcome = await grantScriptAccess(
              page,
              script,
              job.username,
              job.expiry_date,
              onStep
            );
          } else if (job.action === 'revoke') {
            outcome = await revokeScriptAccess(page, script, job.username, onStep);
          } else {
            throw new AutomationError(ErrorCodes.UNKNOWN, `Unsupported action: ${job.action}`);
          }

          // Soft verification failures must not be treated as success.
          if (outcome?.success === false || isSoftFailureCode(outcome?.error_code)) {
            results.push({
              script_id: script.id,
              success: false,
              status: 'failed',
              error_code: outcome.error_code,
              message: outcome.message || outcome.error_code,
              error: outcome.message || outcome.error_code,
            });
            await onStep(outcome.message || outcome.error_code, 'error');
            lastError = null;
            break;
          }

          results.push({
            script_id: script.id,
            success: true,
            status: 'completed',
            error_code: outcome?.error_code || null,
            message: outcome?.message || 'OK',
          });
          await onStep(`Script "${script.script_name}" OK: ${outcome?.message || 'done'}`, 'success');
          lastError = null;
          break;
        } catch (err) {
          lastError = err;
          const code = err instanceof AutomationError ? err.code : ErrorCodes.UNKNOWN;

          if (code === ErrorCodes.SESSION_EXPIRED) {
            sessionExpired = true;
            results.push({
              script_id: script.id,
              success: false,
              status: 'failed',
              error_code: code,
              message: err.message,
            });
            await onStep(`SESSION_EXPIRED: ${err.message}`, 'error');
            break;
          }

          // Non-transient: retrying will not help.
          const noRetry = [
            ErrorCodes.USERNAME_NOT_FOUND,
            ErrorCodes.SCRIPT_NOT_FOUND,
            ErrorCodes.ALREADY_GRANTED,
            ErrorCodes.ALREADY_REVOKED,
          ];
          if (noRetry.includes(code)) {
            results.push({
              script_id: script.id,
              success: false,
              status: 'failed',
              error_code: code,
              message: err.message,
              error: err.message,
            });
            await onStep(`Script "${script.script_name}" failed: ${err.message}`, 'error');
            lastError = null;
            break;
          }

          attempt += 1;
          logger.warn('Script action failed; retrying', {
            script: script.script_name,
            attempt,
            code,
            error: err.message,
          });
          await onStep(`Attempt ${attempt} failed (${code}): ${err.message}`, 'warn');

          if (attempt <= config.workerRetries) {
            await page.waitForTimeout(1500 * attempt);
          }
        }
      }

      if (lastError && !sessionExpired) {
        const code = lastError instanceof AutomationError ? lastError.code : ErrorCodes.UNKNOWN;
        results.push({
          script_id: script.id,
          success: false,
          status: 'failed',
          error_code: code,
          message: lastError.message,
          error: lastError.message,
        });
        await onStep(`Script "${script.script_name}" failed: ${lastError.message}`, 'error');
      }

      if (sessionExpired) {
        break;
      }
    }
  } finally {
    await page.close().catch(() => {});
  }

  const unfinishedDueToShutdown = shuttingDown && (job.scripts || []).length > results.length;
  const allOk =
    !sessionExpired &&
    !unfinishedDueToShutdown &&
    results.length > 0 &&
    results.every((r) => r.success);

  const attempts = Number(job.attempts || 1);
  const maxAttempts = Number(job.max_attempts || 3);

  if (sessionExpired) {
    await safePostResult({
      job_id: job.id,
      status: 'failed',
      message: 'TradingView session expired.',
      error: 'SESSION_EXPIRED',
      error_code: ErrorCodes.SESSION_EXPIRED,
      retry: true,
      results,
    });
    return { allOk: false, sessionExpired: true, results };
  }

  if (unfinishedDueToShutdown) {
    await safePostResult({
      job_id: job.id,
      status: 'failed',
      message: 'Worker shutting down; requeue remaining scripts.',
      error: 'WORKER_SHUTDOWN',
      error_code: 'NETWORK_ERROR',
      retry: true,
      results,
    });
    return { allOk: false, sessionExpired: false, results };
  }

  const nonRetryable = results.some((r) =>
    [
      ErrorCodes.EXPIRY_NOT_VERIFIABLE,
      ErrorCodes.EXPIRY_MISMATCH,
      ErrorCodes.USERNAME_NOT_FOUND,
      'EXPIRY_NOT_VERIFIABLE',
      'EXPIRY_MISMATCH',
      'USERNAME_NOT_FOUND',
    ].includes(r.error_code)
  );

  const canRetry = !allOk && !nonRetryable && attempts < maxAttempts;

  await safePostResult({
    job_id: job.id,
    status: allOk ? 'completed' : 'failed',
    message: allOk
      ? `Processed ${results.length} script(s) successfully.`
      : `Completed with errors (${results.filter((r) => r.success).length}/${results.length} ok).`,
    error: results
      .filter((r) => !r.success)
      .map((r) => `${r.script_id}:${r.error_code || 'FAILED'}`)
      .join(' | '),
    error_code: allOk ? null : results.find((r) => !r.success)?.error_code || ErrorCodes.UNKNOWN,
    retry: canRetry,
    results,
  });

  return { allOk, sessionExpired: false, results };
}

async function pollOnce(browser) {
  if (pauseForSession || shuttingDown) {
    return;
  }

  // Replay any dead-lettered results before claiming new work.
  await replayDeadLetters();

  // Validate session before claiming jobs so we don't burn attempts.
  const probeContext = await browser.newContext({
    storageState: config.storageStatePath,
    viewport: { width: 1440, height: 900 },
  });
  const probePage = await probeContext.newPage();

  try {
    await assertLoggedIn(probePage, screenshotsDir);
  } catch (err) {
    const code = err instanceof AutomationError ? err.code : ErrorCodes.UNKNOWN;
    if (code === ErrorCodes.SESSION_EXPIRED) {
      pauseForSession = true;
      logger.error('SESSION_EXPIRED — worker paused. Run npm run login, then restart.');
      return;
    }
    throw err;
  } finally {
    await probePage.close().catch(() => {});
    await probeContext.close().catch(() => {});
  }

  if (shuttingDown) {
    return;
  }

  const payload = await api.getPendingJobs(config.jobLimit);
  const jobs = payload?.jobs || [];

  if (!jobs.length) {
    logger.info('No pending jobs.');
    return;
  }

  logger.info(`Claimed ${jobs.length} job(s).`);

  for (const job of jobs) {
    if (shuttingDown || pauseForSession) {
      try {
        await safePostResult({
          job_id: job.id,
          status: 'failed',
          message: pauseForSession
            ? 'Session expired before job started.'
            : 'Worker shutting down before job started.',
          error: pauseForSession ? 'SESSION_EXPIRED' : 'WORKER_SHUTDOWN',
          error_code: pauseForSession ? ErrorCodes.SESSION_EXPIRED : ErrorCodes.NETWORK_ERROR,
          retry: true,
          results: [],
        });
      } catch (err) {
        logger.error('Failed to requeue claimed job on pause/shutdown', {
          job_id: job.id,
          error: err.message,
        });
      }
      continue;
    }

    busy = true;
    currentJob = job;

    const context = await browser.newContext({
      storageState: config.storageStatePath,
      viewport: { width: 1440, height: 900 },
    });

    try {
      logger.info('Processing job', {
        id: job.id,
        action: job.action,
        username: job.username,
        scripts: (job.scripts || []).map((s) => s.script_name),
      });

      const outcome = await processJob(context, job);
      if (outcome.sessionExpired) {
        pauseForSession = true;
        logger.error('SESSION_EXPIRED during job — pausing worker.');
      }
    } catch (err) {
      logger.error('Job processing crashed', { job_id: job.id, error: err.message });
      try {
        const attempts = Number(job.attempts || 1);
        const maxAttempts = Number(job.max_attempts || 3);
        await safePostResult({
          job_id: job.id,
          status: 'failed',
          message: 'Worker crashed while processing job.',
          error: err.message,
          error_code: ErrorCodes.UNKNOWN,
          retry: attempts < maxAttempts,
          results: [],
        });
      } catch (postErr) {
        logger.error('Failed to report crashed job', { error: postErr.message });
      }
    } finally {
      await context.close().catch(() => {});
      busy = false;
      currentJob = null;
    }
  }
}

async function main() {
  assertStorageState();
  fs.mkdirSync(screenshotsDir, { recursive: true });
  fs.mkdirSync(deadLetterDir, { recursive: true });
  startHealthServer();

  logger.info('Starting TVAM Playwright worker', {
    apiBaseUrl: config.apiBaseUrl,
    pollIntervalMs: config.pollIntervalMs,
    headless: config.headless,
  });

  const browser = await chromium.launch({ headless: config.headless });

  const shutdown = async (signal) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info(`Received ${signal}; graceful shutdown...`);

    const waitUntil = Date.now() + 120000;
    while (busy && Date.now() < waitUntil) {
      await new Promise((r) => setTimeout(r, 500));
    }

    if (currentJob) {
      try {
        await safePostResult({
          job_id: currentJob.id,
          status: 'failed',
          message: 'Worker shutdown during job.',
          error: 'WORKER_SHUTDOWN',
          error_code: ErrorCodes.NETWORK_ERROR,
          retry: true,
          results: [],
        });
      } catch (err) {
        logger.error('Shutdown requeue failed', { error: err.message });
      }
    }

    if (healthServer) {
      await new Promise((resolve) => healthServer.close(() => resolve()));
    }
    await browser.close().catch(() => {});
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  if (runOnce) {
    await pollOnce(browser);
    await browser.close();
    return;
  }

  while (!shuttingDown) {
    try {
      if (pauseForSession) {
        logger.warn('Paused for SESSION_EXPIRED. Re-checking session after login refresh...');
        await new Promise((r) => setTimeout(r, 30000));
        const ctx = await browser.newContext({
          storageState: config.storageStatePath,
          viewport: { width: 1440, height: 900 },
        });
        const pg = await ctx.newPage();
        try {
          await assertLoggedIn(pg, screenshotsDir);
          pauseForSession = false;
          logger.info('Session restored; resuming job polling.');
        } catch {
          logger.warn('Session still invalid. Run npm run login if needed.');
        } finally {
          await pg.close().catch(() => {});
          await ctx.close().catch(() => {});
        }
        continue;
      }
      await pollOnce(browser);
    } catch (err) {
      if (err.status === 401) {
        logger.error('Invalid API key (401). Stopping worker.');
        break;
      }
      logger.error('Poll cycle failed', { error: err.message, status: err.status });
      // Still try dead-letter replay on connectivity blips.
      try {
        await replayDeadLetters();
      } catch {
        /* ignore */
      }
      await new Promise((r) => setTimeout(r, Math.min(30000, config.pollIntervalMs * 2)));
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
  }

  await browser.close().catch(() => {});
}

main().catch((err) => {
  logger.error('Fatal worker error', { error: err.message });
  process.exit(1);
});
