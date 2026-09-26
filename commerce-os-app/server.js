const http = require('http');
const { URLSearchParams } = require('url');

const PORT = Number(process.env.PORT || 3000);
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_PUBLISHABLE_KEY');
  process.exit(1);
}

function esc(s='') { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function html(message='', ok=false) {
  const msg = message ? `<div class="msg ${ok?'ok':'err'}">${esc(message)}</div>` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Commerce OS</title><style>
  :root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#05090f;color:#f5f7fb;font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:100vh;display:grid;place-items:center;padding:24px}.card{width:min(720px,100%);background:#101821;border:1px solid #2a3949;border-radius:28px;padding:42px;box-shadow:0 30px 80px #0008}.eyebrow{letter-spacing:.18em;text-transform:uppercase;color:#bcff49;font-weight:800;font-size:14px}.title{font-size:46px;line-height:1;margin:10px 0 14px}.sub{color:#9ba8b8;font-size:18px;margin-bottom:28px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}.panel{background:#0a1118;border:1px solid #253443;border-radius:18px;padding:22px}h2{margin:0 0 14px;font-size:20px}label{display:block;font-size:13px;color:#aeb8c5;margin:11px 0 6px}input{width:100%;background:#060b10;color:#fff;border:1px solid #314253;border-radius:12px;padding:13px 14px;font-size:15px}button{width:100%;margin-top:14px;padding:13px 14px;border:0;border-radius:12px;background:#bcff49;color:#0b0f12;font-weight:800;font-size:15px;cursor:pointer}.msg{margin:0 0 22px;padding:12px 14px;border-radius:12px;font-size:14px}.ok{background:#16301d;color:#bff8c8;border:1px solid #2f6f3d}.err{background:#35171b;color:#ffc8cf;border:1px solid #7b3038}.foot{margin-top:18px;color:#748292;font-size:12px;text-align:center}@media(max-width:700px){.grid{grid-template-columns:1fr}.card{padding:26px}.title{font-size:38px}}</style></head><body><main class="card"><div class="eyebrow">Autonomous Etsy Business</div><div class="title">Commerce OS</div><div class="sub">Private operations hub. Sign in or create the operator account.</div>${msg}<div class="grid"><section class="panel"><h2>Sign in</h2><form method="post" action="/signin"><label>Email</label><input type="email" name="email" required autocomplete="email"><label>Password</label><input type="password" name="password" required autocomplete="current-password"><button type="submit">Sign in</button></form></section><section class="panel"><h2>Create account</h2><form method="post" action="/signup"><label>Email</label><input type="email" name="email" required autocomplete="email"><label>Password</label><input type="password" name="password" required minlength="8" autocomplete="new-password"><button type="submit">Create account</button></form></section></div><div class="foot">Commerce OS · external Etsy/Printify writes remain paused until explicitly enabled.</div></main></body></html>`;
}
function appHtml(email='operator') { return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Commerce OS</title><style>body{margin:0;background:#05090f;color:#fff;font-family:system-ui;padding:40px}.wrap{max-width:1100px;margin:auto}.top{display:flex;justify-content:space-between;align-items:center}.pill{padding:7px 10px;border-radius:999px;background:#26301f;color:#c8ff81;font-size:12px}.card{margin-top:28px;background:#101821;border:1px solid #28394b;border-radius:22px;padding:26px}.muted{color:#94a2b4}a{color:#bcff49}</style></head><body><div class="wrap"><div class="top"><div><div style="color:#bcff49;font-weight:800;letter-spacing:.14em;text-transform:uppercase">Commerce OS</div><h1>Operations Hub</h1><div class="muted">Signed in as ${esc(email)}</div></div><div class="pill">EXTERNAL WRITES PAUSED</div></div><div class="card"><h2>Operator account connected</h2><p class="muted">Authentication is working. The next step is wiring the live business record and integrations into this source-controlled app.</p><p><a href="/logout">Sign out</a></p></div></div></body></html>`; }
async function readBody(req){let s='';for await(const c of req){s+=c.toString();if(s.length>20000)throw new Error('request too large');}return new URLSearchParams(s);}
async function sb(path, options={}){const r=await fetch(SUPABASE_URL+path,{...options,headers:{'content-type':'application/json','apikey':SUPABASE_KEY,...(options.headers||{})}});const text=await r.text();let data={};try{data=JSON.parse(text)}catch{data={message:text}}return {ok:r.ok,status:r.status,data};}
function setCookie(res,token,email){res.setHeader('Set-Cookie',[`co_access=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600`,`co_email=${encodeURIComponent(email||'')}; Path=/; Secure; SameSite=Lax; Max-Age=3600`]);}
function cookies(req){const out={};for(const part of String(req.headers.cookie||'').split(';')){const i=part.indexOf('=');if(i>0)out[part.slice(0,i).trim()]=decodeURIComponent(part.slice(i+1));}return out;}
const server=http.createServer(async(req,res)=>{try{
  if(req.url==='/health'){res.writeHead(200,{'content-type':'text/plain'});return res.end('ok');}
  if(req.url==='/logout'){res.setHeader('Set-Cookie',['co_access=; Path=/; Max-Age=0','co_email=; Path=/; Max-Age=0']);res.writeHead(302,{Location:'/'});return res.end();}
  if(req.method==='POST' && (req.url==='/signup'||req.url==='/signin')){
    const body=await readBody(req);const email=String(body.get('email')||'').trim();const password=String(body.get('password')||'');
    if(!email||password.length<8){res.writeHead(400,{'content-type':'text/html; charset=utf-8'});return res.end(html('Enter a valid email and a password of at least 8 characters.'));}
    if(req.url==='/signup'){
      const r=await sb('/auth/v1/signup',{method:'POST',body:JSON.stringify({email,password})});
      if(!r.ok){res.writeHead(400,{'content-type':'text/html; charset=utf-8'});return res.end(html(r.data.msg||r.data.message||r.data.error_description||'Could not create account.'));}
      if(r.data.access_token){setCookie(res,r.data.access_token,email);res.writeHead(302,{Location:'/app'});return res.end();}
      res.writeHead(200,{'content-type':'text/html; charset=utf-8'});return res.end(html('Account created. Check your email for a confirmation link, then sign in.',true));
    }
    const r=await sb('/auth/v1/token?grant_type=password',{method:'POST',body:JSON.stringify({email,password})});
    if(!r.ok||!r.data.access_token){res.writeHead(401,{'content-type':'text/html; charset=utf-8'});return res.end(html(r.data.error_description||r.data.msg||r.data.message||'Sign in failed.'));}
    setCookie(res,r.data.access_token,email);res.writeHead(302,{Location:'/app'});return res.end();
  }
  if(req.url==='/app'){
    const c=cookies(req);if(!c.co_access){res.writeHead(302,{Location:'/'});return res.end();}
    const r=await sb('/auth/v1/user',{headers:{Authorization:`Bearer ${c.co_access}`}});if(!r.ok){res.writeHead(302,{Location:'/'});return res.end();}
    res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});return res.end(appHtml(r.data.email||c.co_email));
  }
  res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});return res.end(html());
}catch(e){console.error(e);res.writeHead(500,{'content-type':'text/html; charset=utf-8'});res.end(html('Server error. Please retry.'));}});
server.listen(PORT,'0.0.0.0',()=>console.log(`Commerce OS listening on ${PORT}`));
