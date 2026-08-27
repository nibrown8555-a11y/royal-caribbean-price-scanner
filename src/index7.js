import express from 'express';
import pg from 'pg';
import zlib from 'zlib';
import { chromium } from 'playwright';
const { Pool } = pg;
const app=express();
const PORT=process.env.PORT||8080;
const DATABASE_URL=process.env.DATABASE_URL;
const PUSHOVER_USER_KEY=process.env.PUSHOVER_USER_KEY||'';
const PUSHOVER_APP_TOKEN=process.env.PUSHOVER_APP_TOKEN||'';
const PUSHOVER_TEST_ON_START=(process.env.PUSHOVER_TEST_ON_START||'').toLowerCase()==='true';
const ROYAL_CATALOG_URL=process.env.ROYAL_CATALOG_URL||'';
const ROYAL_ACCESS_TOKEN=process.env.ROYAL_ACCESS_TOKEN||'';
const ROYAL_APPKEY=process.env.ROYAL_APPKEY||'';
const ROYAL_ACCOUNT_ID=process.env.ROYAL_ACCOUNT_ID||'';
const ROYAL_CHANNEL=process.env.ROYAL_CHANNEL||'';
const ROYAL_REQ_APP_ID=process.env.ROYAL_REQ_APP_ID||'';
const ROYAL_REQ_APP_VERS=process.env.ROYAL_REQ_APP_VERS||'';
const ROYAL_VDS_ID=process.env.ROYAL_VDS_ID||'';
const SCAN_INTERVAL_MINUTES=Number(process.env.SCAN_INTERVAL_MINUTES||10);
const CRUISE_SHIP=process.env.CRUISE_SHIP||'Oasis of the Seas';
const SAIL_DATE=process.env.SAIL_DATE||'2027-01-11';
const PACKAGE_NAME='Deluxe Beverage Package + Royal Beach Club Open Bar Day Pass';
if(!DATABASE_URL)throw new Error('DATABASE_URL is required');
if(!ROYAL_CATALOG_URL)throw new Error('ROYAL_CATALOG_URL is required');
const pool=new Pool({connectionString:DATABASE_URL,ssl:false});
function encodedSession(){if(process.env.ROYAL_STORAGE_STATE_GZIP_B64)return process.env.ROYAL_STORAGE_STATE_GZIP_B64;return Object.entries(process.env).filter(([k,v])=>/^ROYAL_STORAGE_STATE_PART_\d+$/.test(k)&&v).sort(([a],[b])=>a.localeCompare(b,undefined,{numeric:true})).map(([,v])=>v).join('');}
function storageState(){const e=encodedSession();if(!e)return null;return JSON.parse(zlib.gunzipSync(Buffer.from(e,'base64')).toString('utf8'));}
function sessionSummary(){try{const s=storageState();return{configured:!!s,cookieCount:s?.cookies?.length||0,originCount:s?.origins?.length||0,valid:true,partCount:Object.keys(process.env).filter(k=>/^ROYAL_STORAGE_STATE_PART_\d+$/.test(k)).length,accessTokenConfigured:!!ROYAL_ACCESS_TOKEN,appkeyConfigured:!!ROYAL_APPKEY,accountIdConfigured:!!ROYAL_ACCOUNT_ID,channelConfigured:!!ROYAL_CHANNEL,reqAppIdConfigured:!!ROYAL_REQ_APP_ID,reqAppVersConfigured:!!ROYAL_REQ_APP_VERS,vdsIdConfigured:!!ROYAL_VDS_ID,pushoverUserConfigured:!!PUSHOVER_USER_KEY,pushoverTokenConfigured:!!PUSHOVER_APP_TOKEN};}catch{return{configured:true,valid:false};}}
async function initDb(){await pool.query(`create table if not exists scans(id bigserial primary key,checked_at timestamptz not null default now(),ship text not null,sail_date date not null,package_name text not null,price_per_person_per_day numeric(10,2),promo_text text,page_url text,status text not null,raw_text text);create index if not exists scans_lookup_idx on scans(ship,sail_date,package_name,checked_at desc);`);}
async function getLow(){const{rows}=await pool.query('select min(price_per_person_per_day)::float low from scans where ship=$1 and sail_date=$2 and package_name=$3 and price_per_person_per_day is not null',[CRUISE_SHIP,SAIL_DATE,PACKAGE_NAME]);return rows[0]?.low??null;}
async function sendPushover(title,message,priority=0){if(!PUSHOVER_USER_KEY||!PUSHOVER_APP_TOKEN)throw new Error('Pushover credentials are not configured');const body=new URLSearchParams({token:PUSHOVER_APP_TOKEN,user:PUSHOVER_USER_KEY,title,message,priority:String(priority)});const r=await fetch('https://api.pushover.net/1/messages.json',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body});const text=await r.text();if(!r.ok){let safe=text;try{const parsed=JSON.parse(text);safe=JSON.stringify({status:parsed.status,errors:parsed.errors,request:parsed.request});}catch{}console.log('PUSHOVER_ERROR '+safe.slice(0,1500));throw new Error(`Pushover failed: ${r.status}`);}console.log('PUSHOVER_OK '+JSON.stringify({status:r.status}));return true;}
function walkProducts(root){const out=[],seen=new Set();function walk(x){if(!x||typeof x!=='object')return;if(typeof x.title==='string'&&(x.lowestAdultPrice!=null||x.msrpAdultPrice!=null||x.productTypeCategory)){const key=`${x.id||''}|${x.title}`;if(!seen.has(key)){seen.add(key);out.push(x);}}if(Array.isArray(x)){for(const v of x)walk(v);}else{for(const v of Object.values(x))walk(v);}}walk(root);return out;}
function isBundle(p){const t=(p?.title||'').toLowerCase();return /deluxe beverage package/i.test(t)&&(/royal beach club/.test(t)||/open bar day pass/.test(t));}
function promoText(p){return p?.promoDescription?.displayName||p?.promoDescription?.title||null;}
function snap(p){return{id:p?.id??null,title:p?.title??null,lowestAdultPrice:p?.lowestAdultPrice??null,msrpAdultPrice:p?.msrpAdultPrice??null,promoDescription:p?.promoDescription??null,salesUnit:p?.salesUnit??null,unit:p?.unit??null};}
async function handleBundle(product,{forceNotify=false}={}){const previousLow=await getLow();if(!product){await pool.query(`insert into scans(ship,sail_date,package_name,page_url,status,raw_text) values($1,$2,$3,$4,$5,$6)`,[CRUISE_SHIP,SAIL_DATE,PACKAGE_NAME,ROYAL_CATALOG_URL,'product_not_found','{}']);return{ok:false,status:'product_not_found'};}const price=Number(product.lowestAdultPrice);if(!Number.isFinite(price))return{ok:false,status:'price_missing',productTitle:product.title};const promo=promoText(product);await pool.query(`insert into scans(ship,sail_date,package_name,price_per_person_per_day,promo_text,page_url,status,raw_text) values($1,$2,$3,$4,$5,$6,$7,$8)`,[CRUISE_SHIP,SAIL_DATE,PACKAGE_NAME,price,promo,ROYAL_CATALOG_URL,'ok',JSON.stringify(snap(product)).slice(0,12000)]);const isNewLow=previousLow==null||price<previousLow;if(forceNotify||isNewLow){const title=forceNotify?'Royal Caribbean full test':previousLow==null?'Cruise bundle baseline':'Royal Caribbean price drop';const msg=`Deluxe Beverage Package + Royal Beach Club Open Bar Day Pass: $${price.toFixed(2)}/person/day. MSRP $${Number(product.msrpAdultPrice||0).toFixed(2)}.${promo?` ${promo}.`:''}${forceNotify?' End-to-end test successful.':previousLow==null?'':` Previous low: $${Number(previousLow).toFixed(2)}.`}`;await sendPushover(title,msg,forceNotify?0:(previousLow==null?0:1));}return{ok:true,status:'ok',price,previousLow,isNewLow,forcedNotification:forceNotify,promoText:promo,productTitle:product.title,msrpAdultPrice:product.msrpAdultPrice??null};}
async function scanOnce(options={}){let browser,result;try{const state=storageState();if(!state){result={ok:false,status:'session_required'};return result;}console.log('SESSION_STATE '+JSON.stringify(sessionSummary()));browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});const headers={Accept:'application/json, text/plain, */*','Accept-Language':'en-US,en;q=0.9',Origin:'https://www.royalcaribbean.com',Referer:'https://www.royalcaribbean.com/'};if(ROYAL_ACCESS_TOKEN)headers['Access-Token']=ROYAL_ACCESS_TOKEN;if(ROYAL_APPKEY)headers['Appkey']=ROYAL_APPKEY;if(ROYAL_ACCOUNT_ID)headers['Account-Id']=ROYAL_ACCOUNT_ID;if(ROYAL_CHANNEL)headers['Channel']=ROYAL_CHANNEL;if(ROYAL_REQ_APP_ID)headers['Req-App-Id']=ROYAL_REQ_APP_ID;if(ROYAL_REQ_APP_VERS)headers['Req-App-Vers']=ROYAL_REQ_APP_VERS;if(ROYAL_VDS_ID)headers['Vds-Id']=ROYAL_VDS_ID;const context=await browser.newContext({storageState:state,locale:'en-US',timezoneId:'America/Chicago',extraHTTPHeaders:headers});const r=await context.request.get(ROYAL_CATALOG_URL,{timeout:90000});const status=r.status(),ct=r.headers()['content-type']||'',body=await r.text();console.log('CATALOG_HTTP '+JSON.stringify({status,contentType:ct,length:body.length}));if(status!==200){result={ok:false,status:'catalog_http_error',httpStatus:status};return result;}let json;try{json=JSON.parse(body);}catch{result={ok:false,status:'catalog_invalid_json'};return result;}const product=walkProducts(json).find(isBundle)||null;if(product)console.log('BUNDLE_CANDIDATE '+JSON.stringify(snap(product)));result=await handleBundle(product,options);return result;}catch(e){result={ok:false,status:'error',error:String(e.message||e)};return result;}finally{if(browser)await browser.close().catch(()=>{});if(result)console.log('SCAN_RESULT '+JSON.stringify({...result,ship:CRUISE_SHIP,sailDate:SAIL_DATE}));}}
app.get('/health',async(_q,res)=>{try{await pool.query('select 1');res.json({ok:true});}catch(e){res.status(500).json({ok:false,error:String(e.message||e)});}});
app.get('/session-status',(_q,res)=>res.json({ok:true,session:sessionSummary()}));
app.post('/scan-now',async(_q,res)=>res.json(await scanOnce()));
app.get('/full-test',async(_q,res)=>res.json(await scanOnce({forceNotify:true})));
app.get('/status',async(_q,res)=>{const{rows}=await pool.query(`select checked_at,package_name,price_per_person_per_day::float price,promo_text,status from scans where ship=$1 and sail_date=$2 and package_name=$3 order by checked_at desc limit 50`,[CRUISE_SHIP,SAIL_DATE,PACKAGE_NAME]);res.json({ship:CRUISE_SHIP,sailDate:SAIL_DATE,tracked:PACKAGE_NAME,history:rows});});
await initDb();
app.listen(PORT,()=>console.log(`scanner listening on ${PORT}`));
if(PUSHOVER_TEST_ON_START)setTimeout(()=>scanOnce({forceNotify:true}).catch(e=>console.log('FULL_TEST_FAILED '+String(e.message||e))),5000);
setTimeout(()=>scanOnce().catch(console.error),15000);
setInterval(()=>scanOnce().catch(console.error),SCAN_INTERVAL_MINUTES*60*1000);
