import express from 'express';
import pg from 'pg';
import { chromium } from 'playwright';

const { Pool } = pg;
const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3000;
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
const ROYAL_STORAGE_STATE_JSON = process.env.ROYAL_STORAGE_STATE_JSON || '';
const CRUISE_PLANNER_URL = process.env.CRUISE_PLANNER_URL || 'https://www.royalcaribbean.com/booked';

if (!DATABASE_URL) throw new Error('DATABASE_URL is required');
const pool = new Pool({ connectionString: DATABASE_URL, ssl: false });

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
    create index if not exists scans_lookup_idx
      on scans (ship, sail_date, package_name, checked_at desc);

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
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
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
  const packageIdx = text.toLowerCase().indexOf(PACKAGE_NAME.toLowerCase());
  const slice = packageIdx >= 0 ? text.slice(packageIdx, packageIdx + 3500) : text;
  for (const p of [
    /\$\s*([0-9]{2,3}(?:\.[0-9]{2})?)\s*(?:USD)?\s*(?:\/|per)\s*(?:person\s*)?(?:\/|per)?\s*day/i,
    /\$\s*([0-9]{2,3}(?:\.[0-9]{2})?)\s*(?:USD)?[^\n]{0,120}(?:per person per day|pppd)/i,
    /from\s*\$\s*([0-9]{2,3}(?:\.[0-9]{2})?)/i,
  ]) {
    const m = slice.match(p); if (m) return Number(m[1]);
  }
  return null;
}

async function fillFirst(page, selectors, value) {
  for (const selector of selectors) {
    const loc = page.locator(selector).first();
    if (await loc.count()) {
      try { if (await loc.isVisible({ timeout: 1000 })) { await loc.fill(value); return true; } } catch {}
    }
  }
  return false;
}

async function clickFirst(page, selectors) {
  for (const selector of selectors) {
    const loc = page.locator(selector).first();
    if (await loc.count()) {
      try { if (await loc.isVisible({ timeout: 1000 })) { await loc.click(); return true; } } catch {}
    }
  }
  return false;
}

async function ensureLoggedIn(page) {
  await page.goto(CRUISE_PLANNER_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(5000);
  let text = (await page.locator('body').innerText()).slice(0, 50000);
  const lower = text.toLowerCase();
  if (lower.includes(PACKAGE_NAME.toLowerCase()) || lower.includes('my cruises') || lower.includes('cruise planner')) return { ok: true };

  if (!ROYAL_EMAIL || !ROYAL_PASSWORD) return { ok: false, reason: 'credentials_missing' };

  await clickFirst(page, [
    'a:has-text("Sign in")','button:has-text("Sign in")','a:has-text("Log in")','button:has-text("Log in")'
  ]).catch(() => {});
  await page.waitForTimeout(1500);

  const emailOk = await fillFirst(page, [
    'input[type="email"]','input[name*="email" i]','input[id*="email" i]','input[autocomplete="username"]'
  ], ROYAL_EMAIL);
  const passOk = await fillFirst(page, [
    'input[type="password"]','input[name*="password" i]','input[id*="password" i]','input[autocomplete="current-password"]'
  ], ROYAL_PASSWORD);

  if (!emailOk || !passOk) {
    text = (await page.locator('body').innerText()).slice(0, 50000);
    return { ok: false, reason: 'login_fields_not_found', text };
  }

  await clickFirst(page, [
    'button[type="submit"]','button:has-text("Sign in")','button:has-text("Log in")'
  ]);
  await page.waitForTimeout(8000);

  text = (await page.locator('body').innerText()).slice(0, 50000);
  const l2 = text.toLowerCase();
  if (l2.includes('verification code') || l2.includes('one-time code') || l2.includes('captcha') || l2.includes('verify your identity')) {
    return { ok: false, reason: 'interactive_verification_required', text };
  }
  if (l2.includes('incorrect') || l2.includes('invalid password') || l2.includes('unable to sign in')) {
    return { ok: false, reason: 'login_rejected', text };
  }

  await page.goto(CRUISE_PLANNER_URL, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
  await page.waitForTimeout(6000);
  text = (await page.locator('body').innerText()).slice(0, 50000);
  return { ok: !text.toLowerCase().includes('sign in'), reason: 'post_login_check', text };
}

async function scanOnce() {
  const previousLow = await getHistoricalLow();
  let browser;
  try {
    let storageState;
    if (ROYAL_STORAGE_STATE_JSON) storageState = JSON.parse(ROYAL_STORAGE_STATE_JSON);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ storageState });
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
        await sendPushover('⚠️ Royal login needs verification', 'Royal Caribbean requested a verification step. Open the app/site and complete sign-in once, then we can refresh the scanner session.');
      }
      return { ok:false, status, url };
    }

    await page.waitForTimeout(3000);
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
      return { ok:false, status, url };
    }

    const totalBase = price * GUEST_COUNT * NIGHTS;
    const isNewLow = previousLow == null || price < previousLow;
    if (isNewLow) {
      const title = previousLow == null ? '🍹 Cruise drink price baseline' : '🚨 Royal Caribbean price drop';
      const msg = `${PACKAGE_NAME}: $${price.toFixed(2)}/person/day for ${CRUISE_SHIP}. ${GUEST_COUNT} guests × ${NIGHTS} nights = $${totalBase.toFixed(2)} before gratuities/taxes.${previousLow == null ? '' : ` Previous low: $${Number(previousLow).toFixed(2)}.`}`;
      await sendPushover(title, msg, previousLow == null ? 0 : 1);
      await recordEvent(previousLow == null ? 'baseline' : 'new_low', msg, { price, previousLow });
    }

    return { ok:true, status, price, previousLow, isNewLow, promoText, url };
  } catch (err) {
    await recordEvent('scan_error', String(err?.stack || err));
    return { ok:false, status:'error', error:String(err?.message || err) };
  } finally { if (browser) await browser.close().catch(() => {}); }
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
