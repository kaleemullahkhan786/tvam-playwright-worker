/**
 * One-time interactive login to create storageState.json.
 *
 * Run: npm run login
 * Log into TradingView in the opened browser, then press Enter in the terminal.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workerRoot = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(workerRoot, '.env') });

const storageStatePath = path.resolve(
  workerRoot,
  process.env.TVAM_STORAGE_STATE || './storage/storageState.json'
);

async function ask(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function main() {
  const dir = path.dirname(storageStatePath);
  fs.mkdirSync(dir, { recursive: true });

  console.log('Launching browser for TradingView login...');
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();

  await page.goto('https://www.tradingview.com/accounts/signin/', {
    waitUntil: 'domcontentloaded',
  });

  console.log('\n1. Log into the publisher TradingView account in the browser window.');
  console.log('2. Complete 2FA if prompted.');
  console.log('3. Confirm you can open an invite-only script Manage Access page.');
  await ask('\nPress Enter here when login is complete and the session is ready... ');

  await context.storageState({ path: storageStatePath });
  console.log(`Saved storage state to ${storageStatePath}`);

  await browser.close();
  console.log('Done. You can now run: npm start');
}

main().catch((err) => {
  console.error('Login setup failed:', err.message);
  process.exit(1);
});
