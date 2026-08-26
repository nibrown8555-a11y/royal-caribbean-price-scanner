import express from 'express';
import pg from 'pg';
import { chromium } from 'playwright';

const { Pool } = pg;
const app = express();
app.use(express.json({limit:'2mb'}));

const PORT = process.env.PORT || 8080;
const DATABASE_URL = process.env.DATABASE_URL;
const PUSHOVER_USER_KEY = process.env.PUSHOVER_USER_KEY;
const PUSHOVER_APP_TOKEN = process.env.PUSHOVER_APP_TOKEN;
const ROYAL_EMAIL = process.env.ROYAL_EMAIL || '';
const ROYAL_PASSWORD = process.env.ROYAL_PASSWORD || '';
const ROYAL_STORAGE_STATE_JSON = process.env.ROYAL_STORAGE_STATE_JSON || '';
const SCAN_INTERVAL_MINUTES = Number(process.env.SCAN_INTERVAL_MINUTES || 10);
const CRUISE_SHIP = process.env.CRUISE_SHIP || 'Oasis of the Seas';
const SAIL_DATE = process.env.SAIL_DATE || '2027-01-11';
const END_DATE = process.env.END_DATE || '2027-01-15';
const GUEST_COUNT = Number(process.env.GUEST_COUNT || 2);
const NIGHTS = Number(process.env.CRUISE_NIGHTS || 4);
const PACKAGE_NAME = process.env.PACKAGE_NAME || 'Deluxe Beverage Package';
const LOGIN_URL = 'https://www.royalcaribbean.com/myaccount/signin';
const BOOKED_URL = process.env.CRUISE_PLANNER_URL || 'https://www.royalcaribbean.com/booked';

if (!DATABASE_URL) throw new Error('DATABASE_URL is required');
const pool = new Pool({ connectionString: DATABASE_URL, ssl: false });

function sessionStateSummary() {
  if (!ROYAL_STORAGE_STATE_JSON) return { configured:false, cookieCount:0, originCount:0, validJson:true };
  try {
    const state = JSON.parse(ROYAL_STORAGE_STATE_JSON);
    return { configured:true, cookieCount:Array.isArray(state?.cookies)?state.cookies.length:0, originCount:Array.isArray(state?.origins)?state.origins.length:0, validJson:true };
  } catch {
    return { configured:true, cookieCount:0, originCount:0, validJson:false };
  }
}

function logScan(result) {
  console.log('SCAN_RESULT ' + JSON.stringify({
    ok: !!result?.ok, status: result?.status || 'unknown', price: result?.price ?? null,
    previousLow: result?.previousLow ?? null, isNewLow: result?.isNewLow ?? null,
    promoText: result?.promoText ?? null, url: result?.url ?? null, error: result?.error ?? null,
    ship: CRUISE_SHIP, sailDate: SAIL_DATE, package: PACKAGE_NAME
  }));
}

async function initDb() {
  await pool.query(`
    create table if not exists scans (
      id bigserial primary key, checked_at timestamptz not null default now(), ship text not null,
      sail_date date not null, package_name text not null, price_per_person_per_day numeric(10,2),
      promo_text text, page_url text, status text not null, raw_text text
    );
    create index if not exists scans_lookup_idx on scans(ship,sail_date,package_name,checked_at desc);
    create table if not exists scanner_events (
      id bigserial primary key, created_at timestamptz not null default now(), event_type text not null,
      message text not null, metadata jsonb not null default '{}'::jsonb
    );
  `);
}

async function sendPushover(title, message, priority=0) {
  if (!PUSHOVER_USER_KEY || !PUSHOVER_APP_TOKEN) return false;
  const body = new URLSearchParams({token:PUSHOVER_APP_TOKEN,user:PUSHOVER_USER_KEY,title,message,priority:String(priority)});
  const r = await fetch('https://api.pushover.net/1/messages.json',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body});
  if(!r.ok) throw new Error(`Pushover failed: ${r.status} ${await r.text()}`);
  return true;
}

async function recordEvent(type,message,metadata={}) {
  await pool.query('insert into scanner_events(event_type,message,metadata) values($1,$2,$3)',[type,message,JSON.stringify(metadata)]);
}

async function getHistoricalLow() {
  const {rows}=await pool.query(`select min(price_per_person_per_day)::float as low from scans where ship=$1 and sail_date=$2 and package_name=$3 and price_per_person_per_day is not null`,[CRUISE_SHIP,SAIL_DATE,PACKAGE_NAME]);
  return rows[0]?.low ?? null;
}

function parsePrice(text) {
  const idx=text.toLowerCase().indexOf(PACKAGE_NAME.toLowerCase());
  const slice=idx>=0?text.slice(idx,idx+7000):text;
  for(const p of [
    /\$\s*([0-9]{2,3}(?:\.[0-9]{2})?)\s*(?:USD)?\s*(?:\/|per)\s*(?:person\s*)?(?:\/|per)?\s*day/i,
    /\$\s*([0-9]{2,3}(?:\.[0-9]{2})?)\s*(?:USD)?[^\n]{0,220}(?:per person per day|pppd)/i,
    /from\s*\$\s*([0-9]{2,3}(?:\.[0-9]{2})?)/i
  ]) { const m=slice.match(p); if(m) return Number(m[1]); }
  return null;
}

async function diagnostics(page,label='LOGIN') {
  const body=(await page.locator('body').innerText().catch(()=>'' )).slice(0,2500).replace(/\s+/g,' ');
  const html=(await page.content().catch(()=>'' )).slice(0,5000).replace(/\s+/g,' ');
  const frames=[];
  for(const f of page.frames()) {
    let title='',inputs=[];
    try{title=await f.title();}catch{}
    try{inputs=await f.locator('input').evaluateAll(els=>els.map(e=>({type:e.type,name:e.name,id:e.id,placeholder:e.placeholder,autocomplete:e.autocomplete})).slice(0,30));}catch{}
    frames.push({url:f.url(),title,inputs});
  }
  console.log(`${label}_BODY ${JSON.stringify(body)}`);
  console.log(`${label}_FRAMES ${JSON.stringify(frames)}`);
  console.log(`${label}_HTML ${JSON.stringify(html)}`);
}

async function fillInFrames(page,selectors,value) {
  for(const f of page.frames()) for(const s of selectors) {
    try{const loc=f.locator(s).first(); if(await loc.count()&&await loc.isVisible({timeout:700})){await loc.fill(value);return true;}}catch{}
  }
  return false;
}
async function clickInFrames(page,selectors) {
  for(const f of page.frames()) for(const s of selectors) {
    try{const loc=f.locator(s).first(); if(await loc.count()&&await loc.isVisible({timeout:700})){await loc.click();return true;}}catch{}
  }
  return false;
}

async function makeContext(browser) {
  let storageState;
  if(ROYAL_STORAGE_STATE_JSON){ try{storageState=JSON.parse(ROYAL_STORAGE_STATE_JSON);}catch{} }
  const context=await browser.newContext({
    storageState,
    userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    locale:'en-US', timezoneId:'America/Chicago', viewport:{width:1440,height:1100},
    extraHTTPHeaders:{'Accept-Language':'en-US,en;q=0.9','Upgrade-Insecure-Requests':'1'}
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator,'webdriver',{get:()=>undefined});
    Object.defineProperty(navigator,'languages',{get:()=>['en-US','en']});
    Object.defineProperty(navigator,'platform',{get:()=> 'Win32'});
  });
  return context;
}

async function looksAuthenticated(page) {
  const text=(await page.locator('body').innerText().catch(()=>'' )).slice(0,50000).toLowerCase();
  return text.includes('manage reservation') || text.includes('sign out') || text.includes('my cruises') || text.includes('cruise planner');
}

async function ensureLoggedIn(page) {
  await page.goto(BOOKED_URL,{waitUntil:'networkidle',timeout:90000}).catch(()=>{});
  await page.waitForTimeout(4000);
  let text=(await page.locator('body').innerText().catch(()=>'' )).slice(0,50000);
  let lower=text.toLowerCase();
  if(await looksAuthenticated(page)) return {ok:true,via:ROYAL_STORAGE_STATE_JSON?'captured_session':'existing_session'};

  if(ROYAL_STORAGE_STATE_JSON) {
    await diagnostics(page,'SESSION_REJECTED');
    return {ok:false,reason:'captured_session_rejected',text};
  }

  if(!ROYAL_EMAIL||!ROYAL_PASSWORD) return {ok:false,reason:'credentials_missing',text};
  await page.goto(LOGIN_URL,{waitUntil:'networkidle',timeout:90000}).catch(()=>{});
  await page.waitForTimeout(7000);

  await clickInFrames(page,['button:has-text("Accept All")','button:has-text("Accept all")','button:has-text("Allow All")','button:has-text("Agree")']).catch(()=>{});
  await page.waitForTimeout(1500);

  text=(await page.locator('body').innerText().catch(()=>'' )).slice(0,50000);
  lower=text.toLowerCase();
  if(await looksAuthenticated(page)) return {ok:true,via:'credential_login'};

  const emailOk=await fillInFrames(page,[
    'input[type="email"]','input[autocomplete="email"]','input[autocomplete="username"]','input[name*="email" i]',
    'input[id*="email" i]','input[placeholder*="email" i]','input[name*="user" i]','input:not([type])'
  ],ROYAL_EMAIL);
  const passOk=await fillInFrames(page,[
    'input[type="password"]','input[autocomplete="current-password"]','input[name*="password" i]',
    'input[id*="password" i]','input[placeholder*="password" i]'
  ],ROYAL_PASSWORD);

  if(!emailOk||!passOk){await diagnostics(page,'LOGIN');return {ok:false,reason:'login_fields_not_found',text};}

  await clickInFrames(page,['button[type="submit"]','button:has-text("Sign In")','button:has-text("Sign in")','button:has-text("Log In")','button:has-text("Continue")','input[type="submit"]']);
  await page.waitForTimeout(9000);

  text=(await page.locator('body').innerText().catch(()=>'' )).slice(0,50000);
  lower=text.toLowerCase();
  if(lower.includes('verification code')||lower.includes('one-time code')||lower.includes('verify your identity')||lower.includes('captcha')||lower.includes('robot')) return {ok:false,reason:'interactive_verification_required',text};
  if(lower.includes('incorrect')||lower.includes('invalid password')||lower.includes('unable to sign in')) return {ok:false,reason:'login_rejected',text};

  await page.goto(BOOKED_URL,{waitUntil:'networkidle',timeout:90000}).catch(()=>{});
  await page.waitForTimeout(5000);
  if(!(await looksAuthenticated(page))){await diagnostics(page,'POSTLOGIN');return {ok:false,reason:'post_login_check_failed',text};}
  return {ok:true,via:'credential_login'};
}

async function scanOnce() {
  const previousLow=await getHistoricalLow();
  let browser,result;
  try {
    browser=await chromium.launch({headless:true,args:['--disable-blink-features=AutomationControlled','--no-sandbox','--disable-dev-shm-usage']});
    const context=await makeContext(browser);
    const page=await context.newPage();
    page.on('console',msg=>{ if(['error','warning'].includes(msg.type())) console.log(`PAGE_${msg.type().toUpperCase()} ${msg.text()}`); });
    page.on('pageerror',err=>console.log(`PAGE_ERROR ${err.message}`));
    const auth=await ensureLoggedIn(page);

    if(!auth.ok){
      const status=auth.reason||'auth_required',url=page.url();
      const txt=auth.text||(await page.locator('body').innerText().catch(()=>''));
      await pool.query(`insert into scans(ship,sail_date,package_name,page_url,status,raw_text) values($1,$2,$3,$4,$5,$6)`,[CRUISE_SHIP,SAIL_DATE,PACKAGE_NAME,url,status,String(txt).slice(0,12000)]);
      await recordEvent(status,`Royal Caribbean login status: ${status}`,{url});
      if(status==='interactive_verification_required'||status==='captured_session_rejected') await sendPushover('⚠️ Royal session needs refresh','Royal Caribbean authentication needs a fresh browser session. Run the one-time capture script and update ROYAL_STORAGE_STATE_JSON in Railway.');
      result={ok:false,status,url};return result;
    }

    console.log(`AUTH_SUCCESS ${JSON.stringify({via:auth.via||'unknown',session:sessionStateSummary()})}`);
    await page.goto(BOOKED_URL,{waitUntil:'networkidle',timeout:90000}).catch(()=>{});
    await page.waitForTimeout(5000);
    const url=page.url();
    const text=(await page.locator('body').innerText().catch(()=>'' )).slice(0,70000);
    const price=parsePrice(text);
    const promoText=text.match(/(?:up to\s+)?\d{1,2}%\s*off[^\n]*/i)?.[0]||null;
    const status=price==null?'parse_failed':'ok';
    await pool.query(`insert into scans(ship,sail_date,package_name,price_per_person_per_day,promo_text,page_url,status,raw_text) values($1,$2,$3,$4,$5,$6,$7,$8)`,[CRUISE_SHIP,SAIL_DATE,PACKAGE_NAME,price,promoText,url,status,text.slice(0,12000)]);
    if(price==null){await diagnostics(page,'BOOKED');await recordEvent('parse_failed','Could not locate Deluxe Beverage Package price',{url});result={ok:false,status,url};return result;}

    const totalBase=price*GUEST_COUNT*NIGHTS;
    const isNewLow=previousLow==null||price<previousLow;
    if(isNewLow){
      const title=previousLow==null?'🍹 Cruise drink price baseline':'🚨 Royal Caribbean price drop';
      const msg=`${PACKAGE_NAME}: $${price.toFixed(2)}/person/day for ${CRUISE_SHIP}. ${GUEST_COUNT} guests × ${NIGHTS} nights = $${totalBase.toFixed(2)} before gratuities/taxes.${previousLow==null?'':` Previous low: $${Number(previousLow).toFixed(2)}.`}`;
      await sendPushover(title,msg,previousLow==null?0:1);
      await recordEvent(previousLow==null?'baseline':'new_low',msg,{price,previousLow});
    }
    result={ok:true,status,price,previousLow,isNewLow,promoText,url};return result;
  } catch(err){
    await recordEvent('scan_error',String(err?.stack||err));
    result={ok:false,status:'error',error:String(err?.message||err)};return result;
  } finally {if(browser)await browser.close().catch(()=>{});if(result)logScan(result);}
}

app.get('/health',async(_req,res)=>{try{await pool.query('select 1');res.json({ok:true,ship:CRUISE_SHIP,sailDate:SAIL_DATE,package:PACKAGE_NAME});}catch(e){res.status(500).json({ok:false,error:String(e.message||e)});}});
app.get('/session-status',(_req,res)=>res.json({ok:true,session:sessionStateSummary()}));
app.post('/test-push',async(_req,res)=>{try{await sendPushover('✅ Royal Caribbean Scanner','Pushover is connected. Your Oasis of the Seas Deluxe Beverage Package scanner is online.');res.json({ok:true});}catch(e){res.status(500).json({ok:false,error:String(e.message||e)});}});
app.post('/scan-now',async(_req,res)=>res.json(await scanOnce()));
app.get('/status',async(_req,res)=>{const{rows}=await pool.query(`select checked_at,price_per_person_per_day::float as price,promo_text,status,page_url from scans where ship=$1 and sail_date=$2 and package_name=$3 order by checked_at desc limit 20`,[CRUISE_SHIP,SAIL_DATE,PACKAGE_NAME]);res.json({ship:CRUISE_SHIP,sailDate:SAIL_DATE,endDate:END_DATE,guests:GUEST_COUNT,package:PACKAGE_NAME,history:rows});});

await initDb();
app.listen(PORT,()=>console.log(`scanner listening on ${PORT}`));
setTimeout(()=>scanOnce().catch(console.error),15000);
setInterval(()=>scanOnce().catch(console.error),SCAN_INTERVAL_MINUTES*60*1000);
