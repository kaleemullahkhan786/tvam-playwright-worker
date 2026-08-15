/**
 * TradingView session validation.
 */

import { AutomationError, ErrorCodes } from './errors.js';
import { logger } from './logger.js';

/**
 * @param {import('playwright').Page} page
 * @param {string} screenshotsDir
 * @returns {Promise<void>}
 */
export async function assertLoggedIn(page, screenshotsDir) {
  await page.goto('https://www.tradingview.com/', {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });

  await page.waitForTimeout(1500);

  const url = page.url();
  if (/accounts\/signin|accounts\/login|#signin/i.test(url)) {
    await capture(page, screenshotsDir, 'session-expired-redirect');
    throw new AutomationError(
      ErrorCodes.SESSION_EXPIRED,
      'Redirected to TradingView sign-in page.'
    );
  }

  const signIn = page.getByRole('button', { name: /sign in/i }).or(
    page.getByRole('link', { name: /sign in/i })
  );
  if (await signIn.first().isVisible().catch(() => false)) {
    // Sign-in visible in header usually means logged out.
    const avatar = page.locator('[data-name="header-user-menu-button"], button[aria-label*="Open user menu" i], [class*="avatar"]').first();
    const hasAvatar = await avatar.isVisible().catch(() => false);
    if (!hasAvatar) {
      await capture(page, screenshotsDir, 'session-expired-signin');
      throw new AutomationError(
        ErrorCodes.SESSION_EXPIRED,
        'Sign-in control visible and account avatar missing.'
      );
    }
  }

  const avatarCandidates = [
    page.locator('[data-name="header-user-menu-button"]').first(),
    page.getByRole('button', { name: /open user menu|account menu|user menu/i }).first(),
    page.locator('button[aria-label*="user" i]').first(),
  ];

  let foundAvatar = false;
  for (const locator of avatarCandidates) {
    if (await locator.isVisible().catch(() => false)) {
      foundAvatar = true;
      break;
    }
  }

  if (!foundAvatar) {
    // Soft warning: some layouts hide avatar; URL check already passed.
    logger.warn('Account avatar not clearly detected; continuing with caution.');
  }

  logger.info('TradingView session appears valid.');
}

async function capture(page, dir, label) {
  try {
    const fs = await import('node:fs');
    const path = await import('node:path');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${label}-${Date.now()}.png`);
    await page.screenshot({ path: file, fullPage: true });
    logger.warn('Screenshot saved', { file });
  } catch (err) {
    logger.warn('Failed to capture screenshot', { error: err.message });
  }
}
