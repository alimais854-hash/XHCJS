import http from 'node:http';
import {randomBytes,createHash} from 'node:crypto';
import {readFileSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.dirname(fileURLToPath(import.meta.url));
if(existsSync(path.join(root,'.env'))) for(const line of readFileSync(path.join(root,'.env'),'utf8').split(/\r?\n/)){const m=line.match(/^([A-Z_]+)=(.*)$/);if(m&&!process.env[m[1]])process.env[m[1]]=m[2].trim().replace(/^['"]|['"]$/g,'');}
const port=Number(process.env.PORT||3000), previewPort=Number(process.env.PREVIEW_PORT||3001);
const origin=`http://localhost:${port}`, previewOrigin=`http://localhost:${previewPort}`;
const sessions=new Map(), flows=new Map(), previews=new Map();
const nonce=()=>randomBytes(32).toString('base64url');
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
export function validateFiles(files){
 if(!files||Array.isArray(files)||typeof files!=='object'||Object.keys(files).length>50||!Object.keys(files).length)throw fail('المشروع يجب أن يحتوي على 1 إلى 50 ملفًا.');
 let size=0;
 for(const [name,content] of Object.entries(files)){
  if(!/^[a-zA-Z0-9_-][a-zA-Z0-9_./-]*\.(html|css|js|xml)$/.test(name)||name.split('/').some(x=>!x||x==='..'||x==='.')||typeof content!=='string')throw fail('اسم ملف غير صالح: '+name);
  size+=Buffer.byteLength(content);
 }
 if(size>2_000_000)throw fail('الحد الأقصى لحجم المشروع 2 MB.');
 return files;
}
const cookies=req=>Object.fromEntries((req.headers.cookie||'').split(';').map(x=>x.trim().split('=')));
function session(req){const s=sessions.get(cookies(req).cdsession);return s&&s.expires>Date.now()?s:null;}
function json(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
async function body(req){let data='';for await(const chunk of req){data+=chunk;if(Buffer.byteLength(data)>2_200_000)throw fail('الطلب كبير جدًا.',413);}try{return JSON.parse(data);}catch{throw fail('بيانات غير صالحة.');}}
async function gh(token,endpoint,method='GET',data){
 const r=await fetch('https://api.github.com'+endpoint,{method,headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'CodeDock-Local','Content-Type':'application/json'},body:data?JSON.stringify(data):undefined,signal:AbortSignal.timeout(30000)});
 const result=await r.json().catch(()=>({}));if(!r.ok)throw fail(`GitHub (${r.status}): ${result.message||'تعذّر تنفيذ الطلب'}`,r.status);return result;
}
export const app=http.createServer(async(req,res)=>{
 res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
 try{
  if(req.headers.host!==`localhost:${port}`)throw fail('افتح البرنامج من localhost فقط.',403);
  const url=new URL(req.url,origin), route=url.pathname;
  if(req.method==='POST'&&req.headers.origin!==origin)throw fail('مصدر الطلب غير مسموح.',403);
  if(route==='/api/me')return json(res,200,{user:session(req)?.user||null,configured:!!(process.env.GITHUB_CLIENT_ID&&process.env.GITHUB_CLIENT_SECRET)});
  if(route==='/auth/github'){
   if(!process.env.GITHUB_CLIENT_ID||!process.env.GITHUB_CLIENT_SECRET)throw fail('أضف بيانات GitHub OAuth إلى ملف .env ثم أعد تشغيل البرنامج.');
   const state=nonce(), verifier=nonce(), browser=nonce();flows.set(browser,{state,verifier,expires:Date.now()+600000});
   const q=new URLSearchParams({client_id:process.env.GITHUB_CLIENT_ID,redirect_uri:origin+'/auth/callback',scope:'public_repo',state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'});
   res.writeHead(302,{'Set-Cookie':`cdflow=${browser}; HttpOnly; SameSite=Lax; Path=/auth; Max-Age=600`,Location:'https://github.com/login/oauth/authorize?'+q});return res.end();
  }
  if(route==='/auth/callback'){
   const id=cookies(req).cdflow, flow=flows.get(id);flows.delete(id);
   if(!flow||flow.expires<Date.now()||flow.state!==url.searchParams.get('state')||!url.searchParams.get('code'))throw fail('لم يكتمل تسجيل الدخول. حاول مجددًا.',403);
   const response=await fetch('https://github.com/login/oauth/access_token',{method:'POST',headers:{Accept:'application/json','Content-Type':'application/json'},body:JSON.stringify({client_id:process.env.GITHUB_CLIENT_ID,client_secret:process.env.GITHUB_CLIENT_SECRET,code:url.searchParams.get('code'),redirect_uri:origin+'/auth/callback',code_verifier:flow.verifier}),signal:AbortSignal.timeout(30000)});
   const token=await response.json();if(!token.access_token)throw fail('رفض GitHub تسجيل الدخول. حاول مجددًا.',401);
   const u=await gh(token.access_token,'/user'), sid=nonce();sessions.delete(cookies(req).cdsession);
   sessions.set(sid,{token:token.access_token,user:{login:u.login,name:u.name},expires:Date.now()+Math.min(token.expires_in||28800,28800)*1000,publishing:false});
   res.writeHead(302,{'Set-Cookie':[`cdsession=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800`,'cdflow=; HttpOnly; SameSite=Lax; Path=/auth; Max-Age=0'],Location:'/'});return res.end();
  }
  if(route==='/api/logout'&&req.method==='POST'){sessions.delete(cookies(req).cdsession);res.setHeader('Set-Cookie','cdsession=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');return json(res,200,{ok:true});}
  if(route==='/api/preview'&&req.method==='POST'){
   const {files,entry}=await body(req);validateFiles(files);if(!entry?.endsWith('.html')||!Object.hasOwn(files,entry))throw fail('اختر ملف HTML لتشغيله.');
   const id=nonce();previews.set(id,{files,expires:Date.now()+3600000});if(previews.size>100)previews.delete(previews.keys().next().value);
   return json(res,200,{url:previewOrigin+'/'+id+'/'+entry});
  }
  if(route==='/api/publish'&&req.method==='POST'){
   const s=session(req);if(!s)throw fail('سجّل الدخول بحساب GitHub أولًا.',401);if(s.publishing)throw fail('النشر قيد التنفيذ.',409);
   const {files,repo,confirmPublic}=await body(req);validateFiles(files);
   if(!Object.hasOwn(files,'index.html'))throw fail('أضف ملف index.html قبل النشر.');
   if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(repo||''))throw fail('اسم المستودع: حروف إنكليزية وأرقام وشرطة فقط، حتى 80 حرفًا.');
   if(confirmPublic!==true)throw fail('يجب الموافقة على نشر الملفات للعامة.');
   s.publishing=true;let repository;
   try{
    repository=await gh(s.token,'/user/repos','POST',{name:repo,private:false,auto_init:true,description:'Created with CodeDock'});
    const base=`/repos/${s.user.login}/${repo}`,branch=repository.default_branch;
    let ref;for(let i=0;i<5;i++){try{ref=await gh(s.token,base+'/git/ref/heads/'+encodeURIComponent(branch));break;}catch(e){if(e.status!==409&&e.status!==404)throw e;await new Promise(r=>setTimeout(r,1000));}}if(!ref)throw fail('المستودع لم يصبح جاهزًا بعد.');
    const tree=[];for(const [name,content] of Object.entries({...files,'.nojekyll':''})){const blob=await gh(s.token,base+'/git/blobs','POST',{content,encoding:'utf-8'});tree.push({path:name,mode:'100644',type:'blob',sha:blob.sha});}
    const t=await gh(s.token,base+'/git/trees','POST',{tree});
    const commit=await gh(s.token,base+'/git/commits','POST',{message:'Publish website from CodeDock',tree:t.sha,parents:[ref.object.sha]});
    await gh(s.token,base+'/git/refs/heads/'+encodeURIComponent(branch),'PATCH',{sha:commit.sha,force:false});
    const pages=await gh(s.token,base+'/pages','POST',{source:{branch,path:'/'},build_type:'legacy'});
    return json(res,200,{repo:repository.html_url,url:pages.html_url,status:pages.status||'building',repoName:repo});
   }catch(e){return json(res,e.status&&e.status<500?e.status:502,{error:e.message,repo:repository?.html_url,partial:!!repository});}finally{s.publishing=false;}
  }
  if(route==='/api/pages'){
   const s=session(req);if(!s)throw fail('سجّل الدخول مجددًا.',401);const repo=url.searchParams.get('repo');if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(repo||''))throw fail('اسم غير صالح.');
   const p=await gh(s.token,`/repos/${s.user.login}/${repo}/pages`);return json(res,200,{status:p.status,url:p.html_url});
  }
  const allowed={'/':'index.html','/app.js':'app.js','/style.css':'style.css'};if(!allowed[route]||req.method!=='GET')throw fail('غير موجود.',404);
  res.setHeader('Content-Security-Policy',`default-src 'self'; script-src 'self'; style-src 'self'; frame-src ${previewOrigin}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`);
  const name=allowed[route];res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript; charset=utf-8':name.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8');res.end(readFileSync(path.join(root,'public',name)));
 }catch(e){json(res,e.status||500,{error:e.status?e.message:'تعذّر الاتصال. تحقّق من الإنترنت وحاول مجددًا.'});}
});
export const preview=http.createServer((req,res)=>{
 try{
  if(req.headers.host!==`localhost:${previewPort}`){res.writeHead(403);return res.end();}
  const pathname=decodeURIComponent(new URL(req.url,previewOrigin).pathname), parts=pathname.slice(1).split('/'), id=parts.shift(), name=parts.join('/')||'index.html', item=previews.get(id);
  if(!item||item.expires<Date.now()||!Object.hasOwn(item.files,name)){res.writeHead(404);return res.end('Preview expired or file not found. Run again.');}
  const types={html:'text/html',css:'text/css',js:'text/javascript',xml:'application/xml'};
  res.writeHead(200,{'Content-Type':types[name.split('.').pop()]+'; charset=utf-8','Content-Security-Policy':"sandbox allow-scripts allow-forms; object-src 'none'",'Access-Control-Allow-Origin':'*','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});res.end(item.files[name]);
 }catch{res.writeHead(400);res.end('Invalid path');}
});
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 for(const server of [app,preview])server.on('error',e=>{console.error('Unable to start:',e.message);process.exit(1);});
 app.listen(port,'127.0.0.1',()=>console.log(`CodeDock: ${origin}`));preview.listen(previewPort,'127.0.0.1');
 setInterval(()=>{for(const map of [sessions,flows,previews])for(const [k,v]of map)if(v.expires<Date.now())map.delete(k);},60000).unref();
}
