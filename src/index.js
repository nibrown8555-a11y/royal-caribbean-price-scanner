import express from 'express';
import pg from 'pg';
import { chromium } from 'playwright';

const { Pool } = pg;
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;
const DATABASE_URL = process.env.DATABASE_URL;
const PUSHOVER_USER_KEY = process.env.PUSHOVER_USER_KEY;
const PUSHOVER_APP_TOKEN = process.env.PUSHOVER_APP_TOKEN;
const ROYAL_EMAIL = process.env.ROYAL_EMAIL || '';
const ROYAL_PASSWORD = process.env.ROYAL_PASSWORD || '';
const SCAN_INTERVAL_MINUTES = Number(process.env.SCAN_INTERVAL_MINUTES || 10);
const CRUISE_SHIP = process.env.CRUISE_SHIP || 'Oasis of the Seas';
const SAIL_DATE = process.env.SAIL_DATE || '2027-01-11';
const END_DATE = process.env.END_DATE || '2027-01-15';
const GUEST_COUNT = Number(process.env.GUEST_COUNT || 2);
const NIGHTS = Number(process.env.CRUISE_NIGHTS || 4);
const PACKAGE_NAME = process.env.PACKAGE_NAME || 'Deluxe Beverage Package';
const ROYAL_LOGIN_URL = 'https://www.royalcaribbean.com/myaccount/signin';
const CRUISE_PLANNER_URL = process.env.CRUISE_PLANNER_URL || 'https://www.royalcaribbean.com/booked';

if (!DATABASE_URL) throw new Error('DATABASE_URL is required');
const pool = new Pool({ connectionString: DATABASE_URL, ssl: false });

function logScan(result) {
  console.log(`SCAN_RESULT ${JSON.stringify({
    ok: !!result?.ok,
    status: result?.status || 'unknown',
    price: result?.price ?? null,
    previousLow: result?.previousLow ?? null,
    isNewLow: result?.isNewLow ?? null,
    promoText: result?.promoText ?? null,
    url: result?.url ?? null,
    error: result?.error ?? null,
    ship: CRUISE_SHIP,
    sailDate: SAIL_DATE,
    package: PACKAGE_NAME
  })}`);
}

async function initDb() {
  await pool.query(`
    create table if not exists scans (
      id bigserial primary key,
      checked_at timestamptz not null default now(),
      ship text not null,
      sail_date date not null,
      package_name text not null,
      price_per_person_per_day numeric(10,2),
      promo_text text,
      page_url text,
      status text not null,
      raw_text text
    );
    create index if not exists scans_lookup_idx on scans(ship,sail_date,package_name,checked_at desc);
    create table if not exists scanner_events (
      id bigserial primary key,
      created_at timestamptz not null default now(),
      event_type text not null,
      message text not null,
      metadata jsonb not null default '{}'::jsonb
    );
  `);
}

async function sendPushover(title, message, priority = 0) {
  if (!PUSHOVER_USER_KEY || !PUSHOVER_APP_TOKEN) return false;
  const body = new URLSearchParams({ token: PUSHOVER_APP_TOKEN, user: PUSHOVER_USER_KEY, title, message, priority: String(priority) });
  const r = await fetch('https://api.pushover.net/1/messages.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!r.ok) throw new Error(`Pushover failed: ${r.status} ${await r.text()}`);
  return true;
}

async function recordEvent(type, message, metadata = {}) {
  await pool.query('insert into scanner_events(event_type,message,metadata) values($1,$2,$3)', [type, message, JSON.stringify(metadata)]);
}

async function getHistoricalLow() {
  const { rows } = await pool.query(
    `select min(price_per_person_per_day)::float as low from scans
     where ship=$1 and sail_date=$2 and package_name=$3 and price_per_person_per_day is not null`,
    [CRUISE_SHIP, SAIL_DATE, PACKAGE_NAME]
  );
  return rows[0]?.low ?? null;
}

function parsePriceFromText(text) {
  const idx = text.toLowerCase().indexOf(PACKAGE_NAME.toLowerCase());
  const slice = idx >= 0 ? text.slice(idx, idx + 4000) : text;
  for (const p of [
    /\$\s*([0-9]{2,3}(?:\.[0-9]{2})?)\s*(?:USD)?\s*(?:\/|per)\s*(?:person\s*)?(?:\/|per)?\s*day/i,
    /\$\s*([0-9]{2,3}(?:\.[0-9]{2})?)\s*(?:USD)?[^\n]{0,150}(?:per person per day|pppd)/i,
    /from\s*\$\s*([0-9]{2,3}(?:\.[0-9]{2})?)/i
  ]) {
    const m = slice.match(p);
    if (m) return Number(m[1]);
  }
  return null;
}

async function fillAny(page, selectors, value) {
  for (const selector of selectors) {
    const loc = page.locator(selector).first();
    try {
      if (await loc.count() && await loc.isVisible({ timeout: 1200 })) {
        await loc.fill(value);
        return true;
      }
    } catch {}
  }
  return false;
}

async function clickAny(page, selectors) {
  for (const selector of selectors) {
    const loc = page.locator(selector).first();
    try {
      if (await loc.count() && await loc.isVisible({ timeout: 1200 })) {
        await loc.click();
        return true;
      }
    } catch {}
  }
  return false;
}

async function ensureLoggedIn(page) {
  if (!ROYAL_EMAIL || !ROYAL_PASSWORD) return { ok: false, reason: 'credentials_missing' };

  await page.goto(ROYAL_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(5000);

  let text = (await page.locator('body').innerText().catch(() => '')).slice(0, 50000);
  let lower = text.toLowerCase();
  if (lower.includes('manage reservation') || lower.includes('sign out') || lower.includes('my cruises')) return { ok: true };

  const emailOk = await fillAny(page, [
    'input[type="email"]',
    'input[autocomplete="email"]',
    'input[autocomplete="username"]',
    'input[name*="email" i]',
    'input[id*="email" i]',
    'input[placeholder*="email" i]'
  ], ROYAL_EMAIL);

  const passOk = await fillAny(page, [
    'input[type="password"]',
    'input[autocomplete="current-password"]',
    'input[name*="password" i]',
    'input[id*="password" i]',
    'input[placeholder*="password" i]'
  ], ROYAL_PASSWORD);

  if (!emailOk || !passOk) {
    const inputs = await page.locator('input').evaluateAll(els => els.map(e => ({type:e.type,name:e.name,id:e.id,placeholder:e.placeholder,autocomplete:e.autocomplete})).slice(0,20)).catch(() => []);
    console.log(`LOGIN_INPUTS ${JSON.stringify(inputs)}`);
    return { ok: false, reason: 'login_fields_not_found', text };
  }

  await clickAny(page, [
    'button[type="submit"]',
    'button:has-text("Sign In")',
    'button:has-text("Sign in")',
    'button:has-text("Log In")',
    'button:has-text("Continue")'
  ]);
  await page.waitForTimeout(8000);

  text = (await page.locator('body').innerText().catch(() => '')).slice(0, 50000);
  lower = text.toLowerCase();

  if (lower.includes('verification code') || lower.includes('one-time code') || lower.includes('verify your identity') || lower.includes('captcha') || lower.includes('robot')) {
    return { ok: false, reason: 'interactive_verification_required', text };
  }
  if (lower.includes('incorrect') || lower.includes('invalid password') || lower.includes('unable to sign in') || lower.includes('try again')) {
    return { ok: false, reason: 'login_rejected', text };
  }

  await page.goto(CRUISE_PLANNER_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(7000);
  text = (await page.locator('body').innerText().catch(() => '')).slice(0, 50000);
  lower = text.toLowerCase();

  if (lower.includes('sign in') && !lower.includes('manage reservation')) {
    return { ok: false, reason: 'post_login_check_failed', text };
  }
  return { ok: true };
}

async function scanOnce() {
  const previousLow = await getHistoricalLow();
  let browser;
  let result;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    const auth = await ensureLoggedIn(page);
    if (!auth.ok) {
      const status = auth.reason || 'auth_required';
      const url = page.url();
      const text = auth.text || (await page.locator('body').innerText().catch(() => ''));
      await pool.query(`insert into scans(ship,sail_date,package_name,page_url,status,raw_text) values($1,$2,$3,$4,$5,$6)`,
        [CRUISE_SHIP, SAIL_DATE, PACKAGE_NAME, url, status, String(text).slice(0,12000)]);
      await recordEvent(status, `Royal Caribbean login status: ${status}`, { url });
      if (status === 'interactive_verification_required') {
        await sendPushover('⚠️ Royal login needs verification', 'Royal Caribbean requested a verification step. Open Royal Caribbean and complete sign-in, then we can refresh the scanner session.');
      }
      result = { ok:false, status, url };
      return result;
    }

    const url = page.url();
    const text = (await page.locator('body').innerText()).slice(0,50000);
    const price = parsePriceFromText(text);
    const promoMatch = text.match(/(?:up to\s+)?\d{1,2}%\s*off[^\n]*/i);
    const promoText = promoMatch?.[0] || null;
    const status = price == null ? 'parse_failed' : 'ok';

    await pool.query(`insert into scans(ship,sail_date,package_name,price_per_person_per_day,promo_text,page_url,status,raw_text)
      values($1,$2,$3,$4,$5,$6,$7,$8)`,
      [CRUISE_SHIP, SAIL_DATE, PACKAGE_NAME, price, promoText, url, status, text.slice(0,12000)]);

    if (price == null) {
      await recordEvent('parse_failed', 'Could not locate Deluxe Beverage Package price', { url });
      result = { ok:false, status, url };
      return result;
    }

    const totalBase = price * GUEST_COUNT * NIGHTS;
    const isNewLow = previousLow == null || price < previousLow;
    if (isNewLow) {
      const title = previousLow == null ? '🍹 Cruise drink price baseline' : '🚨 Royal Caribbean price drop';
      const msg = `${PACKAGE_NAME}: $${price.toFixed(2)}/person/day for ${CRUISE_SHIP}. ${GUEST_COUNT} guests × ${NIGHTS} nights = $${totalBase.toFixed(2)} before gratuities/taxes.${previousLow == null ? '' : ` Previous low: $${Number(previousLow).toFixed(2)}.`}`;
      await sendPushover(title, msg, previousLow == null ? 0 : 1);
      await recordEvent(previousLow == null ? 'baseline' : 'new_low', msg, { price, previousLow });
    }

    result = { ok:true, status, price, previousLow, isNewLow, promoText, url };
    return result;
  } catch (err) {
    await recordEvent('scan_error', String(err?.stack || err));
    result = { ok:false, status:'error', error:String(err?.message || err) };
    return result;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (result) logScan(result);
  }
}

app.get('/health', async (_req,res) => {
  try { await pool.query('select 1'); res.json({ ok:true, ship:CRUISE_SHIP, sailDate:SAIL_DATE, package:PACKAGE_NAME }); }
  catch(e) { res.status(500).json({ ok:false, error:String(e.message||e) }); }
});
app.post('/test-push', async (_req,res) => {
  try { await sendPushover('✅ Royal Caribbean Scanner','Pushover is connected. Your Oasis of the Seas Deluxe Beverage Package scanner is online.'); res.json({ok:true}); }
  catch(e){ res.status(500).json({ok:false,error:String(e.message||e)}); }
});
app.post('/scan-now', async (_req,res) => res.json(await scanOnce()));
app.get('/status', async (_req,res) => {
  const {rows}=await pool.query(`select checked_at, price_per_person_per_day::float as price, promo_text, status, page_url from scans
    where ship=$1 and sail_date=$2 and package_name=$3 order by checked_at desc limit 20`,[CRUISE_SHIP,SAIL_DATE,PACKAGE_NAME]);
  res.json({ ship:CRUISE_SHIP,sailDate:SAIL_DATE,endDate:END_DATE,guests:GUEST_COUNT,package:PACKAGE_NAME,history:rows });
});

await initDb();
app.listen(PORT, () => console.log(`scanner listening on ${PORT}`));
setTimeout(() => scanOnce().catch(console.error), 15000);
setInterval(() => scanOnce().catch(console.error), SCAN_INTERVAL_MINUTES * 60 * 1000);
