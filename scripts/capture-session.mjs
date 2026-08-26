import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const LOGIN_URL = 'https://www.royalcaribbean.com/myaccount/signin';
const BOOKED_URL = 'https://www.royalcaribbean.com/booked';
const OUT = 'royal-storage-state.json';

const rl = readline.createInterface({ input, output });
const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  locale: 'en-US',
});
const page = await context.newPage();

console.log('\nRoyal Caribbean session capture');
console.log('1) A normal browser window will open.');
console.log('2) Sign in to Royal Caribbean yourself.');
console.log('3) Open your booked cruise / Cruise Planner if available.');
console.log('4) Return to this terminal and press Enter.\n');

await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
await rl.question('After you are fully signed in, press Enter here... ');

await page.goto(BOOKED_URL, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
await page.waitForTimeout(5000);

const state = await context.storageState();
await fs.writeFile(OUT, JSON.stringify(state), 'utf8');

console.log(`\nSaved authenticated browser state to: ${OUT}`);
console.log('Treat this file like a password. Do not commit it to GitHub or paste it into chat.');
console.log('Copy its full contents into Railway scanner variable: ROYAL_STORAGE_STATE_JSON');

await browser.close();
rl.close();
