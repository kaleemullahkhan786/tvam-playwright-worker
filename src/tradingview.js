/**
 * TradingView Manage Access UI automation via Playwright.
 */

import fs from 'node:fs';
import path from 'node:path';
import { AutomationError, ErrorCodes } from './errors.js';
import { logger } from './logger.js';
import { config } from './config.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeExpiry(expiryDate) {
  if (!expiryDate) {
    return null;
  }
  const value = String(expiryDate).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

/**
 * Normalize many date display formats to YYYY-MM-DD when possible.
 * @param {string} raw
 * @returns {string|null}
 */
function parseDisplayedDate(raw) {
  if (!raw) {
    return null;
  }
  const text = String(raw).trim();
  const iso = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    return `${iso[1]}-${iso[2]}-${iso[3]}`;
  }
  const slash = text.match(/(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})/);
  if (slash) {
    const a = Number(slash[1]);
    const b = Number(slash[2]);
    const y = slash[3];
    // Prefer MDY when first > 12 is impossible; otherwise assume MDY (US TV locale common).
    let month;
    let day;
    if (a > 12) {
      day = a;
      month = b;
    } else if (b > 12) {
      month = a;
      day = b;
    } else {
      month = a;
      day = b;
    }
    return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  const ts = Date.parse(text);
  if (!Number.isNaN(ts)) {
    const d = new Date(ts);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }
  return null;
}

async function screenshotOnFailure(page, label) {
  try {
    const dir = path.join(config.workerRoot, 'storage', 'screenshots');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${label}-${Date.now()}.png`);
    await page.screenshot({ path: file, fullPage: true });
    logger.warn('Selector/verification failure screenshot', { file });
  } catch (err) {
    logger.warn('Could not write failure screenshot', { error: err.message });
  }
}

/**
 * @param {import('playwright').Page} page
 * @param {import('playwright').Locator[]} candidates
 * @param {string} label
 */
async function clickFirstVisible(page, candidates, label) {
  for (const locator of candidates) {
    const first = locator.first();
    try {
      if (await first.isVisible({ timeout: 2000 })) {
        await first.click({ timeout: 15000 });
        return;
      }
    } catch {
      // try next
    }
  }

  await screenshotOnFailure(page, `selector-${label}`);
  throw new AutomationError(
    ErrorCodes.SELECTOR_NOT_FOUND,
    `Could not find interactive control: ${label}`
  );
}

async function openManageAccess(page) {
  const dialog = page.getByRole('dialog');
  if (await dialog.isVisible().catch(() => false)) {
    return dialog;
  }

  // Cookie / consent banners can block the Manage Access control.
  const consent = page.getByRole('button', { name: /accept all|i agree|allow all|got it|ok/i }).first();
  if (await consent.isVisible().catch(() => false)) {
    await consent.click({ timeout: 5000 }).catch(() => {});
    await sleep(400);
  }

  await clickFirstVisible(
    page,
    [
      page.getByRole('button', { name: /^manage access$/i }),
      page.getByRole('link', { name: /^manage access$/i }),
      page.getByRole('button', { name: /manage access/i }),
      page.getByRole('link', { name: /manage access/i }),
      page.getByText(/^manage access$/i),
      page.locator('a, button').filter({ hasText: /^manage access$/i }),
    ],
    'manage-access'
  );

  const opened = page.getByRole('dialog').first();
  try {
    await opened.waitFor({ state: 'visible', timeout: 15000 });
  } catch {
    await screenshotOnFailure(page, 'manage-access-modal');
    throw new AutomationError(ErrorCodes.MODAL_CLOSED, 'Manage Access dialog did not open.');
  }

  return opened;
}

async function openAddUsers(dialog) {
  const addBtn = dialog.getByRole('button', { name: /add new users|add users/i }).first();
  if (await addBtn.isVisible().catch(() => false)) {
    await addBtn.click({ timeout: 10000 });
  }
}

/**
 * @param {import('playwright').Locator} scope
 * @param {string} username
 */
async function usernameListed(scope, username) {
  const exact = scope.getByText(username, { exact: true });
  return (await exact.count()) > 0 && (await exact.first().isVisible().catch(() => false));
}

async function waitForSearchSettled(dialog, timeoutMs = 12000) {
  const loading = dialog
    .getByText(/loading|searching|please wait/i)
    .or(dialog.locator('[aria-busy="true"], .spinner, [class*="loader" i], [class*="loading" i]'));

  const start = Date.now();
  // If a loader is present, wait until it disappears.
  while (Date.now() - start < timeoutMs) {
    const visible = await loading.first().isVisible().catch(() => false);
    if (!visible) {
      await sleep(350);
      const still = await loading.first().isVisible().catch(() => false);
      if (!still) {
        return 'settled';
      }
    }
    await sleep(250);
  }
  return 'loading_timeout';
}

/**
 * Distinguish: username exists / no results / still loading / network-ish empty state.
 *
 * @param {import('playwright').Locator} dialog
 * @param {string} username
 * @returns {Promise<'exists'|'not_found'|'loading_timeout'|'unknown'>}
 */
async function usernameSuggestionVisible(dialog, username) {
  const candidates = [
    dialog.getByRole('option', { name: username, exact: true }),
    dialog.getByRole('listitem').filter({ hasText: new RegExp(`^\\s*${escapeRegExp(username)}\\s*$`, 'i') }),
    dialog.locator('[role="option"], [role="listbox"] *').filter({
      hasText: new RegExp(`^\\s*${escapeRegExp(username)}\\s*$`, 'i'),
    }),
    dialog.getByText(username, { exact: true }),
  ];

  for (const locator of candidates) {
    const first = locator.first();
    if (await first.isVisible().catch(() => false)) {
      return true;
    }
  }
  return false;
}

async function resolveUsernameSearch(dialog, username) {
  const deadline = Date.now() + 15000;
  let sawExplicitNoResults = false;

  while (Date.now() < deadline) {
    await waitForSearchSettled(dialog, 4000);

    const networkHint = dialog
      .getByText(/network|offline|connection|try again|something went wrong/i)
      .first();
    if (await networkHint.isVisible().catch(() => false)) {
      throw new AutomationError(
        ErrorCodes.NETWORK_ERROR,
        'TradingView search reported a network/connection problem.'
      );
    }

    if (await usernameSuggestionVisible(dialog, username)) {
      return 'exists';
    }

    const noResults = dialog
      .getByText(/no results|not found|couldn.?t find|no users found|nothing found|user does not exist/i)
      .first();
    if (await noResults.isVisible().catch(() => false)) {
      sawExplicitNoResults = true;
      // Keep polling briefly — TV sometimes flashes empty state before results.
      await sleep(500);
      continue;
    }

    await sleep(400);
  }

  if (await usernameSuggestionVisible(dialog, username)) {
    return 'exists';
  }

  return sawExplicitNoResults ? 'not_found' : 'loading_timeout';
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Try to read expiry shown next to a granted username.
 * @returns {Promise<{found: boolean, date: string|null, permanent: boolean, raw: string}>}
 */
async function readListedExpiry(scope, username) {
  const row = scope.locator('div, li, tr, [role="row"]').filter({ hasText: username }).first();
  if (!(await row.isVisible().catch(() => false))) {
    return { found: false, date: null, permanent: false, raw: '' };
  }

  const text = ((await row.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
  if (/no expiration|no expiry|never expires|permanent|unlimited/i.test(text)) {
    return { found: true, date: null, permanent: true, raw: text };
  }

  const date = parseDisplayedDate(text);
  if (date) {
    return { found: true, date, permanent: false, raw: text };
  }

  // Date input inside the row.
  const dateInput = row.locator('input[type="date"]').first();
  if (await dateInput.count()) {
    const value = await dateInput.inputValue().catch(() => '');
    const normalized = normalizeExpiry(value);
    if (normalized) {
      return { found: true, date: normalized, permanent: false, raw: value };
    }
  }

  return { found: true, date: null, permanent: false, raw: text };
}

/**
 * Verify grant outcome including expiry when requested.
 */
async function verifyGrant(scope, username, requestedExpiry) {
  if (!(await usernameListed(scope, username))) {
    throw new AutomationError(
      ErrorCodes.VERIFICATION_FAILED,
      `Grant clicked but username "${username}" not found in Access Granted list.`
    );
  }

  const wanted = normalizeExpiry(requestedExpiry);
  if (!wanted) {
    // Permanent / unspecified — username presence is enough.
    return { error_code: null, message: 'Granted and verified (username present)' };
  }

  const expiryInfo = await readListedExpiry(scope, username);
  if (!expiryInfo.found) {
    return {
      error_code: ErrorCodes.EXPIRY_NOT_VERIFIABLE,
      message: 'Username present but expiry row could not be inspected.',
      success: false,
    };
  }

  if (expiryInfo.permanent) {
    return {
      error_code: ErrorCodes.EXPIRY_MISMATCH,
      message: `Expected expiry ${wanted} but TradingView shows permanent/no expiration.`,
      success: false,
    };
  }

  if (!expiryInfo.date) {
    return {
      error_code: ErrorCodes.EXPIRY_NOT_VERIFIABLE,
      message: 'Username present but TradingView did not expose a readable expiry date.',
      success: false,
    };
  }

  if (expiryInfo.date !== wanted) {
    return {
      error_code: ErrorCodes.EXPIRY_MISMATCH,
      message: `Expected expiry ${wanted} but found ${expiryInfo.date}.`,
      success: false,
    };
  }

  return {
    error_code: null,
    message: `Granted and verified (username + expiry ${wanted})`,
  };
}

/**
 * Grant access and verify username (+ expiry when requested).
 */
export async function grantScriptAccess(page, script, username, expiryDate, onStep) {
  const step = typeof onStep === 'function' ? onStep : async () => {};

  if (!script?.script_url) {
    throw new AutomationError(
      ErrorCodes.SCRIPT_NOT_FOUND,
      `Script "${script?.script_name || 'unknown'}" has no script_url.`
    );
  }

  logger.info('Granting access', { script: script.script_name, username, expiryDate });
  await step(`Opening script URL for "${script.script_name}"…`);

  try {
    await page.goto(script.script_url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (err) {
    throw new AutomationError(ErrorCodes.NETWORK_ERROR, err.message);
  }

  if (/accounts\/signin|accounts\/login/i.test(page.url())) {
    throw new AutomationError(ErrorCodes.SESSION_EXPIRED, 'Redirected to login while opening script.');
  }

  await sleep(config.actionDelayMs);
  await step('Opening Manage Access…');

  let dialog;
  try {
    dialog = await openManageAccess(page);
  } catch (err) {
    if (err instanceof AutomationError) {
      throw err;
    }
    throw new AutomationError(ErrorCodes.TIMEOUT, err.message);
  }

  if (await usernameListed(dialog, username)) {
    await step(`User already listed — verifying expiry if required…`);
    const verify = await verifyGrant(dialog, username, expiryDate);
    if (verify.success === false) {
      return verify;
    }
    return {
      error_code: ErrorCodes.ALREADY_GRANTED,
      message: verify.message || 'Already granted',
    };
  }

  await openAddUsers(dialog);
  await sleep(500);
  await step(`Searching for username "${username}"…`);

  const userInput = dialog
    .getByRole('textbox', { name: /user|username|search/i })
    .or(dialog.locator('input[type="search"]'))
    .or(dialog.locator('input[placeholder*="user" i]'))
    .first();

  try {
    await userInput.waitFor({ state: 'visible', timeout: 15000 });
  } catch {
    await screenshotOnFailure(page, 'username-input');
    throw new AutomationError(ErrorCodes.SELECTOR_NOT_FOUND, 'Username input not found in Manage Access.');
  }

  await userInput.click({ timeout: 5000 });
  await userInput.fill('');
  // Type so TradingView search listeners fire (fill-only often skips results).
  await userInput.pressSequentially(username, { delay: 40 });
  await userInput.press('Enter').catch(() => {});
  await sleep(700);

  const resolution = await resolveUsernameSearch(dialog, username);
  if (resolution === 'loading_timeout') {
    throw new AutomationError(
      ErrorCodes.USERNAME_LOADING_TIMEOUT,
      `Username search still loading for "${username}".`
    );
  }
  if (resolution === 'not_found') {
    throw new AutomationError(ErrorCodes.USERNAME_NOT_FOUND, `Username not found: ${username}`);
  }

  await step('Username found — selecting…');
  const suggestion = dialog.getByText(username, { exact: true }).first();
  if (await suggestion.isVisible().catch(() => false)) {
    await suggestion.click();
    await sleep(400);
  }

  const expiry = normalizeExpiry(expiryDate);
  if (expiry) {
    await step(`Setting expiry date ${expiry}…`);
    const dateInput = dialog.locator('input[type="date"]').first();
    if (await dateInput.count()) {
      await dateInput.fill(expiry);
    } else {
      // Attempt text-like date fields.
      const alt = dialog.locator('input[placeholder*="date" i], input[name*="expir" i]').first();
      if (await alt.count()) {
        await alt.fill(expiry);
      } else {
        logger.warn('Expiry provided but date input not found; will mark EXPIRY_NOT_VERIFIABLE after add.');
        await step('Expiry control not found in UI — will not claim success without verification.');
      }
    }
  } else {
    await step('Permanent access (no expiry)…');
    const noExpiry = dialog.getByText(/no expiration|no expiry|never expires/i).first();
    if (await noExpiry.isVisible().catch(() => false)) {
      await noExpiry.click();
    }
  }

  await step('Clicking Add access…');
  await clickFirstVisible(
    page,
    [
      dialog.getByRole('button', { name: /^add access$/i }),
      dialog.getByRole('button', { name: /add access|apply|save/i }),
    ],
    'add-access'
  );

  await sleep(config.actionDelayMs);
  await step('Verifying grant in Access list…');

  let verifyScope = page.getByRole('dialog').first();
  if (!(await verifyScope.isVisible().catch(() => false))) {
    verifyScope = await openManageAccess(page);
  }

  const verified = await verifyGrant(verifyScope, username, expiryDate);
  if (verified.success === false) {
    await screenshotOnFailure(page, 'grant-expiry-unverifiable');
    return verified;
  }

  logger.info('Grant verified', { username, script: script.script_name });
  await step(verified.message);
  return verified;
}

/**
 * Revoke access and verify username is gone.
 */
export async function revokeScriptAccess(page, script, username, onStep) {
  const step = typeof onStep === 'function' ? onStep : async () => {};

  if (!script?.script_url) {
    throw new AutomationError(
      ErrorCodes.SCRIPT_NOT_FOUND,
      `Script "${script?.script_name || 'unknown'}" has no script_url.`
    );
  }

  logger.info('Revoking access', { script: script.script_name, username });
  await step(`Opening script URL for "${script.script_name}"…`);

  try {
    await page.goto(script.script_url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (err) {
    throw new AutomationError(ErrorCodes.NETWORK_ERROR, err.message);
  }

  if (/accounts\/signin|accounts\/login/i.test(page.url())) {
    throw new AutomationError(ErrorCodes.SESSION_EXPIRED, 'Redirected to login while opening script.');
  }

  await sleep(config.actionDelayMs);
  await step('Opening Manage Access…');

  const dialog = await openManageAccess(page);

  if (!(await usernameListed(dialog, username))) {
    logger.info('User already revoked / not present', { username, script: script.script_name });
    await step('User not in list — already revoked.');
    return { error_code: ErrorCodes.ALREADY_REVOKED, message: 'Already revoked' };
  }

  await step(`Removing access for "${username}"…`);
  const row = dialog.locator('div, li, tr, [role="row"]').filter({ hasText: username }).first();
  const removeBtn = row
    .getByRole('button', { name: /remove|revoke|delete/i })
    .or(row.locator('button[aria-label*="remove" i], button[title*="remove" i]'))
    .first();

  if (!(await removeBtn.isVisible().catch(() => false))) {
    await screenshotOnFailure(page, 'revoke-button');
    throw new AutomationError(
      ErrorCodes.SELECTOR_NOT_FOUND,
      `Remove control not found for username "${username}".`
    );
  }

  await removeBtn.click({ timeout: 10000 });

  const confirm = page.getByRole('button', { name: /confirm|yes|remove|ok/i }).first();
  if (await confirm.isVisible().catch(() => false)) {
    await confirm.click();
  }

  await sleep(config.actionDelayMs);
  await step('Verifying user removed from list…');

  let verifyScope = page.getByRole('dialog').first();
  if (!(await verifyScope.isVisible().catch(() => false))) {
    verifyScope = await openManageAccess(page);
  }

  if (await usernameListed(verifyScope, username)) {
    await screenshotOnFailure(page, 'revoke-verification-failed');
    throw new AutomationError(
      ErrorCodes.VERIFICATION_FAILED,
      `Revoke clicked but username "${username}" still appears in access list.`
    );
  }

  logger.info('Revoke verified', { username, script: script.script_name });
  await step('Revoke verified.');
  return { error_code: null, message: 'Revoked and verified' };
}
