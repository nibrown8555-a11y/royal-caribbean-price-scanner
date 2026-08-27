import express from 'express';
import pg from 'pg';
import zlib from 'zlib';
import { chromium } from 'playwright';

const { Pool } = pg;
const app = express();
app.use(express.json({limit:'1mb'}));

const PORT = process.env.PORT || 8080;
const DATABASE_URL = process.env.DATABASE_URL;
const PUSHOVER_USER_KEY = process.env.PUSHOVER_USER_KEY || '';
const PUSHOVER_APP_TOKEN = process.env.PUSHOVER_APP_TOKEN || '';
const SCAN_INTERVAL_MINUTES = Number(process.env.SCAN_INTERVAL_MINUTES || 10);
const CRUISE_SHIP = process.env.CRUISE_SHIP || 'Oasis of the Seas';
const SAIL_DATE = process.env.SAIL_DATE || '2027-01-11';
const END_DATE = process.env.END_DATE || '2027-01-15';
const GUEST_COUNT = Number(process.env.GUEST_COUNT || 2);
const NIGHTS = Number(process.env.CRUISE_NIGHTS || 4);
const PACKAGE_NAME = process.env.PACKAGE_NAME || 'Deluxe Beverage Package';
const DIRECT_BEVERAGE_URL = process.env.DIRECT_BEVERAGE_URL || '';

if (!DATABASE_URL) throw new Error('DATABASE_URL is required');
if (!DIRECT_BEVERAGE_URL) throw new Error('DIRECT_BEVERAGE_URL is required');
const pool = new Pool({ connectionString:DATABASE_URL, ssl:false });

function encodedSession(){
  if(process.env.ROYAL_STORAGE_STATE_GZIP_B64) return process.env.ROYAL_STORAGE_STATE_GZIP_B64;
  return Object.entries(process.env)
    .filter(([k,v])=>/^ROYAL_STORAGE_STATE_PART_\d+$/.test(k)&&v)
    .sort(([a],[b])=>a.localeCompare(b,undefined,{numeric:true}))
    .map(([,v])=>v).join('');
}
function storageState(){
  const encoded=encodedSession();
  if(!encoded) return null;
  return JSON.parse(zlib.gunzipSync(Buffer.from(encoded,'base64')).toString('utf8'));
}
function sessionSummary(){
  try{const s=storageState();return{configured:!!s,cookieCount:s?.cookies?.length||0,originCount:s?.origins?.length||0,valid:true,partCount:Object.keys(process.env).filter(k=>/^ROYAL_STORAGE_STATE_PART_\d+$/.test(k)).length};}
  catch{return{configured:true,cookieCount:0,originCount:0,valid:false,partCount:0};}
}
async function initDb(){
  await pool.query(`create table if not exists scans(id bigserial primary key,checked_at timestamptz not null default now(),ship text not null,sail_date date not null,package_name text not null,price_per_person_per_day numeric(10,2),promo_text text,page_url text,status text not null,raw_text text);create index if not exists scans_lookup_idx on scans(ship,sail_date,package_name,checked_at desc);create table if not exists scanner_events(id bigserial primary key,created_at timestamptz not null default now(),event_type text not null,message text not null,metadata jsonb not null default '{}'::jsonb);`);
}
async function sendPushover(title,message,priority=0){
  if(!PUSHOVER_USER_KEY||!PUSHOVER_APP_TOKEN)return false;
  const body=new URLSearchParams({token:PUSHOVER_APP_TOKEN,user:PUSHOVER_USER_KEY,title,message,priority:String(priority)});
  const r=await fetch('https://api.pushover.net/1/messages.json',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body});
  if(!r.ok)throw new Error(`Pushover failed: ${r.status}`);
  return true;
}
async function getLow(){const{rows}=await pool.query('select min(price_per_person_per_day)::float low from scans where ship=$1 and sail_date=$2 and package_name=$3 and price_per_person_per_day is not null',[CRUISE_SHIP,SAIL_DATE,PACKAGE_NAME]);return rows[0]?.low??null;}
function parsePrice(text){
  const lower=text.toLowerCase();
  let idx=lower.indexOf(PACKAGE_NAME.toLowerCase());
  if(idx<0)idx=lower.indexOf('deluxe beverage package');
  const s=idx>=0?text.slice(Math.max(0,idx-1500),idx+12000):text;
  for(const p of [
    /\$\s*([0-9]{2,3}(?:\.[0-9]{2})?)\s*(?:USD)?\s*(?:\/|per)\s*(?:person\s*)?(?:\/|per)?\s*day/i,
    /\$\s*([0-9]{2,3}(?:\.[0-9]{2})?)[^\n]{0,450}(?:per person per day|pppd|per guest per day)/i,
    /(?:salePrice|discountedPrice|price|amount)[^0-9$]{0,70}\$?\s*([0-9]{2,3}(?:\.[0-9]{2})?)/i,
    /from\s*\$\s*([0-9]{2,3}(?:\.[0-9]{2})?)/i
  ]){const m=s.match(p);if(m){const n=Number(m[1]);if(n>=20&&n<=250)return n;}}
  return null;
}
function log(r){console.log('SCAN_RESULT '+JSON.stringify({...r,ship:CRUISE_SHIP,sailDate:SAIL_DATE,package:PACKAGE_NAME}));}

async function scanOnce(){
  let browser,result; const previousLow=await getLow();
  try{
    const state=storageState();
    if(!state){result={ok:false,status:'session_required',price:null};return result;}
    console.log('SESSION_STATE '+JSON.stringify(sessionSummary()));
    browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
    const context=await browser.newContext({storageState:state,locale:'en-US',timezoneId:'America/Chicago',viewport:{width:1440,height:1100}});
    const page=await context.newPage();
    const apiBodies=[];
    page.on('response',async resp=>{
      try{
        const ct=(resp.headers()['content-type']||'').toLowerCase();
        if(!ct.includes('json'))return;
        const url=resp.url();
        if(!/beverage|package|product|planner|catalog|offer|price|cart/i.test(url))return;
        let body='';try{body=(await resp.text()).slice(0,60000);}catch{}
        if(apiBodies.length<80)apiBodies.push({url,body});
      }catch{}
    });

    await page.goto(DIRECT_BEVERAGE_URL,{waitUntil:'domcontentloaded',timeout:90000});
    await page.waitForTimeout(18000);
    const url=page.url();
    const text=(await page.locator('body').innerText().catch(()=>'' )).slice(0,180000);
    const lower=text.toLowerCase();
    console.log('DIRECT_BEVERAGE_PAGE '+JSON.stringify({url,title:await page.title().catch(()=>''),hasDeluxe:lower.includes('deluxe beverage'),isError:/on vacation|don.t let that stop/i.test(lower),textSnippet:text.slice(0,4000)}));

    if(lower.includes('sign in')&&!lower.includes('deluxe beverage')){
      result={ok:false,status:'session_expired',price:null,url};
      await sendPushover('⚠️ Royal session expired','Royal Caribbean scanner needs a fresh one-time login session.');
      return result;
    }

    let price=parsePrice(text);
    const relevant=apiBodies.filter(x=>/deluxe beverage|deluxe.*package/i.test(x.body));
    console.log('DELUXE_API_COUNT '+JSON.stringify({count:relevant.length,totalApiBodies:apiBodies.length}));
    if(price==null){for(const x of relevant){price=parsePrice(x.body);if(price!=null)break;}}

    const promoText=text.match(/(?:up to\s+)?\d{1,2}%\s*off[^\n]*/i)?.[0]||null;
    const status=price==null?'parse_failed':'ok';
    await pool.query(`insert into scans(ship,sail_date,package_name,price_per_person_per_day,promo_text,page_url,status,raw_text) values($1,$2,$3,$4,$5,$6,$7,$8)`,[CRUISE_SHIP,SAIL_DATE,PACKAGE_NAME,price,promoText,url,status,text.slice(0,12000)]);
    if(price==null){result={ok:false,status,price:null,url};return result;}

    const isNewLow=previousLow==null||price<previousLow;
    if(isNewLow){
      const total=price*GUEST_COUNT*NIGHTS;
      const title=previousLow==null?'🍹 Cruise drink price baseline':'🚨 Royal Caribbean price drop';
      const msg=`${PACKAGE_NAME}: $${price.toFixed(2)}/person/day for ${CRUISE_SHIP}. ${GUEST_COUNT} guests × ${NIGHTS} nights = $${total.toFixed(2)} before gratuities/taxes.${previousLow==null?'':` Previous low: $${Number(previousLow).toFixed(2)}.`}`;
      await sendPushover(title,msg,previousLow==null?0:1);
    }
    result={ok:true,status:'ok',price,previousLow,isNewLow,promoText,url};return result;
  }catch(e){result={ok:false,status:'error',price:null,error:String(e.message||e)};return result;}
  finally{if(browser)await browser.close().catch(()=>{});if(result)log(result);}
}

app.get('/health',async(_q,res)=>{try{await pool.query('select 1');res.json({ok:true});}catch(e){res.status(500).json({ok:false,error:String(e.message||e)});}});
app.get('/session-status',(_q,res)=>res.json({ok:true,session:sessionSummary()}));
app.post('/scan-now',async(_q,res)=>res.json(await scanOnce()));
app.get('/status',async(_q,res)=>{const{rows}=await pool.query(`select checked_at,price_per_person_per_day::float price,promo_text,status,page_url from scans where ship=$1 and sail_date=$2 and package_name=$3 order by checked_at desc limit 20`,[CRUISE_SHIP,SAIL_DATE,PACKAGE_NAME]);res.json({ship:CRUISE_SHIP,sailDate:SAIL_DATE,endDate:END_DATE,guests:GUEST_COUNT,package:PACKAGE_NAME,history:rows});});

await initDb();
app.listen(PORT,()=>console.log(`scanner listening on ${PORT}`));
setTimeout(()=>scanOnce().catch(console.error),15000);
setInterval(()=>scanOnce().catch(console.error),SCAN_INTERVAL_MINUTES*60*1000);
