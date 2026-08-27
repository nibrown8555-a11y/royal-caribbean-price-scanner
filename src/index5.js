import express from 'express';
import pg from 'pg';
import zlib from 'zlib';
import { chromium } from 'playwright';

const { Pool } = pg;
const app = express();
const PORT = process.env.PORT || 8080;
const DATABASE_URL = process.env.DATABASE_URL;
const PUSHOVER_USER_KEY = process.env.PUSHOVER_USER_KEY || '';
const PUSHOVER_APP_TOKEN = process.env.PUSHOVER_APP_TOKEN || '';
const ROYAL_CATALOG_URL = process.env.ROYAL_CATALOG_URL || '';
const SCAN_INTERVAL_MINUTES = Number(process.env.SCAN_INTERVAL_MINUTES || 10);
const CRUISE_SHIP = process.env.CRUISE_SHIP || 'Oasis of the Seas';
const SAIL_DATE = process.env.SAIL_DATE || '2027-01-11';
const GUEST_COUNT = Number(process.env.GUEST_COUNT || 2);
const NIGHTS = Number(process.env.CRUISE_NIGHTS || 4);
const PACKAGE_NAME = process.env.PACKAGE_NAME || 'Deluxe Beverage Package';

if (!DATABASE_URL) throw new Error('DATABASE_URL is required');
if (!ROYAL_CATALOG_URL) throw new Error('ROYAL_CATALOG_URL is required');
const pool = new Pool({ connectionString:DATABASE_URL, ssl:false });

function encodedSession(){
  if(process.env.ROYAL_STORAGE_STATE_GZIP_B64)return process.env.ROYAL_STORAGE_STATE_GZIP_B64;
  return Object.entries(process.env).filter(([k,v])=>/^ROYAL_STORAGE_STATE_PART_\d+$/.test(k)&&v).sort(([a],[b])=>a.localeCompare(b,undefined,{numeric:true})).map(([,v])=>v).join('');
}
function storageState(){const e=encodedSession();if(!e)return null;return JSON.parse(zlib.gunzipSync(Buffer.from(e,'base64')).toString('utf8'));}
function sessionSummary(){try{const s=storageState();return{configured:!!s,cookieCount:s?.cookies?.length||0,originCount:s?.origins?.length||0,valid:true,partCount:Object.keys(process.env).filter(k=>/^ROYAL_STORAGE_STATE_PART_\d+$/.test(k)).length};}catch{return{configured:true,cookieCount:0,originCount:0,valid:false,partCount:0};}}

async function initDb(){await pool.query(`create table if not exists scans(id bigserial primary key,checked_at timestamptz not null default now(),ship text not null,sail_date date not null,package_name text not null,price_per_person_per_day numeric(10,2),promo_text text,page_url text,status text not null,raw_text text);create index if not exists scans_lookup_idx on scans(ship,sail_date,package_name,checked_at desc);`);}
async function getLow(){const{rows}=await pool.query('select min(price_per_person_per_day)::float low from scans where ship=$1 and sail_date=$2 and package_name=$3 and price_per_person_per_day is not null',[CRUISE_SHIP,SAIL_DATE,PACKAGE_NAME]);return rows[0]?.low??null;}
async function sendPushover(title,message,priority=0){if(!PUSHOVER_USER_KEY||!PUSHOVER_APP_TOKEN)return false;const body=new URLSearchParams({token:PUSHOVER_APP_TOKEN,user:PUSHOVER_USER_KEY,title,message,priority:String(priority)});const r=await fetch('https://api.pushover.net/1/messages.json',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body});if(!r.ok)throw new Error(`Pushover failed: ${r.status}`);return true;}

function walkProducts(root){
  const out=[]; const seen=new Set();
  function walk(x){
    if(!x||typeof x!=='object')return;
    if(typeof x.title==='string' && (x.lowestAdultPrice!=null || x.msrpAdultPrice!=null || x.productTypeCategory)){
      const key=`${x.id||''}|${x.title}`; if(!seen.has(key)){seen.add(key);out.push(x);}
    }
    if(Array.isArray(x)){for(const v of x)walk(v);} else {for(const v of Object.values(x))walk(v);}
  }
  walk(root); return out;
}
function chooseDeluxe(products){
  const candidates=products.filter(p=>/deluxe beverage package/i.test(p.title||''));
  const standalone=candidates.find(p=>!/royal beach club|open bar day pass|\+/.test((p.title||'').toLowerCase()));
  return standalone || null;
}
function promoText(p){return p?.promoDescription?.displayName || p?.promoDescription?.title || null;}
function log(r){console.log('SCAN_RESULT '+JSON.stringify({...r,ship:CRUISE_SHIP,sailDate:SAIL_DATE,package:PACKAGE_NAME}));}

async function scanOnce(){
  let browser,result; const previousLow=await getLow();
  try{
    const state=storageState(); if(!state){result={ok:false,status:'session_required'};return result;}
    console.log('SESSION_STATE '+JSON.stringify(sessionSummary()));
    browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
    const context=await browser.newContext({storageState:state,locale:'en-US',timezoneId:'America/Chicago',extraHTTPHeaders:{'Accept':'application/json, text/plain, */*','Accept-Language':'en-US,en;q=0.9','Origin':'https://www.royalcaribbean.com','Referer':'https://www.royalcaribbean.com/'}});
    const r=await context.request.get(ROYAL_CATALOG_URL,{timeout:90000});
    const status=r.status(); const ct=(r.headers()['content-type']||''); const body=await r.text();
    console.log('CATALOG_HTTP '+JSON.stringify({status,contentType:ct,length:body.length}));
    if(status!==200){result={ok:false,status:'catalog_http_error',httpStatus:status};return result;}
    let json; try{json=JSON.parse(body);}catch{result={ok:false,status:'catalog_invalid_json'};return result;}
    const products=walkProducts(json);
    const deluxeCandidates=products.filter(p=>/deluxe beverage package/i.test(p.title||'')).map(p=>({title:p.title,id:p.id||null,lowestAdultPrice:p.lowestAdultPrice??null,msrpAdultPrice:p.msrpAdultPrice??null,promo:promoText(p)}));
    console.log('DELUXE_CANDIDATES '+JSON.stringify(deluxeCandidates));
    const product=chooseDeluxe(products);
    if(!product){
      await pool.query(`insert into scans(ship,sail_date,package_name,page_url,status,raw_text) values($1,$2,$3,$4,$5,$6)`,[CRUISE_SHIP,SAIL_DATE,PACKAGE_NAME,ROYAL_CATALOG_URL,'standalone_deluxe_not_found',JSON.stringify(deluxeCandidates).slice(0,12000)]);
      result={ok:false,status:'standalone_deluxe_not_found',candidateCount:deluxeCandidates.length};return result;
    }
    const price=Number(product.lowestAdultPrice);
    if(!Number.isFinite(price)){result={ok:false,status:'price_missing',productTitle:product.title};return result;}
    const promo=promoText(product);
    await pool.query(`insert into scans(ship,sail_date,package_name,price_per_person_per_day,promo_text,page_url,status,raw_text) values($1,$2,$3,$4,$5,$6,$7,$8)`,[CRUISE_SHIP,SAIL_DATE,PACKAGE_NAME,price,promo,ROYAL_CATALOG_URL,'ok',JSON.stringify({id:product.id,title:product.title,lowestAdultPrice:product.lowestAdultPrice,msrpAdultPrice:product.msrpAdultPrice,promoDescription:product.promoDescription}).slice(0,12000)]);
    const isNewLow=previousLow==null||price<previousLow;
    if(isNewLow){const total=price*GUEST_COUNT*NIGHTS;const title=previousLow==null?'🍹 Cruise drink price baseline':'🚨 Royal Caribbean price drop';const msg=`${PACKAGE_NAME}: $${price.toFixed(2)}/person/day for ${CRUISE_SHIP}. ${GUEST_COUNT} guests × ${NIGHTS} nights = $${total.toFixed(2)} before gratuities/taxes.${promo?` ${promo}.`:''}${previousLow==null?'':` Previous low: $${Number(previousLow).toFixed(2)}.`}`;await sendPushover(title,msg,previousLow==null?0:1);}
    result={ok:true,status:'ok',price,previousLow,isNewLow,promoText:promo,productTitle:product.title};return result;
  }catch(e){result={ok:false,status:'error',error:String(e.message||e)};return result;}
  finally{if(browser)await browser.close().catch(()=>{});if(result)log(result);}
}

app.get('/health',async(_q,res)=>{try{await pool.query('select 1');res.json({ok:true});}catch(e){res.status(500).json({ok:false,error:String(e.message||e)});}});
app.get('/session-status',(_q,res)=>res.json({ok:true,session:sessionSummary()}));
app.post('/scan-now',async(_q,res)=>res.json(await scanOnce()));
app.get('/status',async(_q,res)=>{const{rows}=await pool.query(`select checked_at,price_per_person_per_day::float price,promo_text,status from scans where ship=$1 and sail_date=$2 and package_name=$3 order by checked_at desc limit 20`,[CRUISE_SHIP,SAIL_DATE,PACKAGE_NAME]);res.json({ship:CRUISE_SHIP,sailDate:SAIL_DATE,package:PACKAGE_NAME,history:rows});});

await initDb(); app.listen(PORT,()=>console.log(`scanner listening on ${PORT}`)); setTimeout(()=>scanOnce().catch(console.error),15000); setInterval(()=>scanOnce().catch(console.error),SCAN_INTERVAL_MINUTES*60*1000);
