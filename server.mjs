import http from 'node:http';
import { readFile, writeFile, mkdir, unlink, stat, rm, appendFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { CodexBridge } from './lib/codex.mjs';
import { PresentationHost } from './lib/presentation.mjs';
import { validateMessage, buildPrompt, readerThreadOptions, PAGE_TOOL } from './lib/context.mjs';
import { LocalContext } from './lib/local-context.mjs';
import { archiveReaderHistory } from './lib/history-cleanup.mjs';
import { OcrHost } from './lib/ocr.mjs';

export const ROOT = path.dirname(fileURLToPath(import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm', '.json': 'application/json', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream', '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2' };
const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
const sameToken = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
async function readBody(req, max) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > max) throw new Error('文件或消息过大。'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
function runPS(script, args = [], timeout = 90000) {
  return new Promise((resolve, reject) => {
    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; const timer = setTimeout(() => { proc.kill(); reject(new Error('PPT 转换超时，请先手动另存为 PDF。')); }, timeout);
    proc.stdout.on('data', b => { out += b; }); proc.stderr.on('data', b => { err += b; });
    proc.on('error', e => { clearTimeout(timer); reject(e); });
    proc.on('exit', code => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(err.trim() || '未能转换 PPT。请安装 PowerPoint / LibreOffice，或另存为 PDF 后打开。')); });
  });
}

export async function createReader({ dataDir = path.join(ROOT, 'data'), bridge, port = 0, token = randomBytes(32).toString('hex'), presentationFactory = (input, directory) => new PresentationHost(path.join(ROOT,'render-slides.ps1'),input,directory),ocrFactory=script=>new OcrHost(script) } = {}) {
  const tmpDir = path.join(dataDir, 'tmp'), historyDir = path.join(dataDir, 'history');
  await mkdir(tmpDir, { recursive: true });
  await mkdir(historyDir, { recursive: true });
  bridge ||= new CodexBridge(tmpDir);
  const local=new LocalContext(dataDir);await local.load();
  const sessions=local.sessions,prepared=local.prepared;
  const warmCourses=new Map(),ocrCaches=new Map(),htmlDocuments=new Map(),ocr=ocrFactory(path.join(ROOT,'ocr-pages.ps1'));
  async function closeHtmlDocuments(){await Promise.all([...htmlDocuments.values()].map(file=>unlink(file).catch(()=>{})));htmlDocuments.clear();}
  async function ocrCache(key){if(!ocrCaches.has(key))ocrCaches.set(key,readFile(path.join(dataDir,'ocr',key+'.json'),'utf8').then(JSON.parse).catch(()=>({})));return ocrCaches.get(key);}
  function uploadStatus(key){const source=prepared[key],warm=warmCourses.get(key),valid=warm&&warm.revision===source?.revision;return {ready:!!(local.ready(source)&&valid&&warm.pages.size===source.total&&!active.has(warm.threadId)),cached:local.ready(source),textPages:valid?[...warm.pages].sort((a,b)=>a-b):[],imagePages:[],total:source?.total||0};}
  let cleanupNeeded=false,cleanupPromise=null,historyCleanup=null;
  try{
    const legacy=JSON.parse(await readFile(path.join(dataDir,'sessions.json'),'utf8'));
    cleanupNeeded=Object.values(legacy).some(value=>typeof value==='string'&&/^[0-9a-f-]{36}$/.test(value));
    try{historyCleanup=JSON.parse(await readFile(path.join(dataDir,'history-cleanup.json'),'utf8'));if(historyCleanup.version===1&&!historyCleanup.failed?.length)cleanupNeeded=false;}catch{}
  }catch{}
  async function startBridge(){
    await bridge.start();
    if(cleanupNeeded){
      cleanupPromise||=(async()=>{
        const result=await archiveReaderHistory(bridge,tmpDir);
        historyCleanup={version:1,...result,updatedAt:new Date().toISOString()};
        await local.save('history-cleanup.json',historyCleanup);
      })().catch(()=>{historyCleanup={failed:['retry-on-restart']};}).finally(()=>{cleanupNeeded=false;});
      await cleanupPromise;
    }
  }
  const active = new Map(), preparing = new Set();
  let restartPromise=null,bridgeEpoch=0;
  const isPrepared = item => local.ready(item);
  const pageRequests = new Map();
  bridge.readDocumentPages = async ({threadId,turnId,arguments:args}) => {
    const job=active.get(threadId),pages=args?.pages;
    if(!job || job.preload || (job.turnId && turnId!==job.turnId))throw new Error('当前没有可读取页面的文档问答。');
    if(!Array.isArray(pages)||!pages.length||pages.length>4||pages.some(p=>!Number.isInteger(p)||p<1||p>job.documentPages)||new Set(pages).size!==pages.length)throw new Error('页码无效，每次最多读取当前文档的4页。');
    return new Promise((resolve,reject)=>{
      const id=randomUUID();const timer=setTimeout(()=>{pageRequests.delete(id);reject(new Error('页面读取超时，请重试。'));},90000);
      pageRequests.set(id,{job,pages,resolve,reject,timer});job.send('readPages',{id,pages});
    });
  };
  const presentations = new Map();
  const presentationRoot = path.resolve(tmpDir,'presentations');
  async function closePresentation(id) {
    const item = presentations.get(id); if (!item) return;
    presentations.delete(id); await item.host.close();
    const target = path.resolve(item.directory);
    // Only this app's generated per-document directory may be removed recursively.
    if (path.dirname(target) === presentationRoot && /^[0-9a-f-]{36}$/.test(path.basename(target))) await rm(target,{recursive:true,force:true}).catch(()=>{});
  }
  async function closePresentations() { await Promise.allSettled([...presentations.keys()].map(closePresentation)); }
  let origin;
  async function finish(threadId, event, data) {
    const job = active.get(threadId); if (!job) return;
    if(job.finishing)return job.finishing;
    job.finishing=(async()=>{
    clearTimeout(job.timer);
    if (job.preload && event === 'done' && data.status === 'completed') {
      await local.accept(job.sourceKey,job.preload,job.preloadText).catch(()=>{});
      if(job.preload.kind==='text'){
        const source=prepared[job.sourceKey];let warm=warmCourses.get(job.sourceKey);
        if(!warm||warm.threadId!==threadId||warm.revision!==source.revision)warm={threadId,revision:source.revision,pages:new Set()};
        for(let page=job.preload.start;page<=job.preload.end;page++)warm.pages.add(page);warmCourses.set(job.sourceKey,warm);
      }
    }
    if(!job.preload&&!job.isolated&&job.courseRevision&&event==='done'&&data.status==='completed')warmCourses.set(job.sourceKey,{threadId,revision:job.courseRevision,pages:new Set(Array.from({length:job.documentPages},(_,i)=>i+1))});
    if(!job.preload&&!job.isolated)await local.remember(job.documentKey,job.question,[...job.answers.values()].join('\n\n')).catch(()=>{});
    if (active.get(threadId) !== job) return;
    active.delete(threadId);
    for(const [id,request] of pageRequests)if(request.job===job){clearTimeout(request.timer);request.reject(new Error('文档问答已结束。'));pageRequests.delete(id);}
    void appendFile(path.join(dataDir,'timing.jsonl'),JSON.stringify({time:new Date().toISOString(),model:job.model,scope:job.scope,effort:job.effort,background:!!job.preload,images:job.imageCount,firstTextMs:job.firstTextMs??null,totalMs:Date.now()-job.startedAt,status:data.status||event})+'\n').catch(()=>{});
    job.send(event, data); job.res.end();
    if (job.imagePath) await unlink(job.imagePath).catch(() => {});
    if (job.imagePaths) await Promise.all(job.imagePaths.map(p => unlink(p).catch(() => {})));
    })();
    return job.finishing;
  }
  bridge.on('offline', message => { local.resetWorker();warmCourses.clear();++bridgeEpoch; for (const id of active.keys()) void finish(id, 'failure', { message }); });
  bridge.on('notification', ({ method, params: p = {} }) => {
    const job = active.get(p.threadId); if (!job) return;
    if (p.turnId && job.turnId && p.turnId !== job.turnId) return;
    if (method === 'turn/started') job.turnId = p.turn?.id;
    if (method === 'item/agentMessage/delta') {job.firstTextMs??=Date.now()-job.startedAt;job.answers.set(p.itemId,(job.answers.get(p.itemId)||'')+p.delta);job.send('delta', { itemId: p.itemId, delta: p.delta });}
    if (method === 'item/completed' && p.item?.type === 'agentMessage') {job.answers.set(p.item.id,p.item.text);job.send('message', { itemId: p.item.id, text: p.item.text });}
    if (method === 'error') { if (!p.willRetry) void finish(p.threadId, 'failure', { message: p.error?.message || 'Codex 生成失败。' }); else job.send('status', { message: '连接中断，Codex 正在重试…' }); }
    if (method === 'turn/completed') {
      const turn = p.turn || {};
      void finish(p.threadId, turn.status === 'failed' ? 'failure' : 'done', { status: turn.status, message: turn.error?.message });
    }
    if (method === 'reader/toolBlocked') job.send('status', { message: '已跳过与文档问答无关的工具操作。' });
  });
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' blob: data:; worker-src 'self' blob:; connect-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('Cache-Control', 'no-store');
    let preparationKey = null;
    try {
      if (req.headers.host !== new URL(origin).host) return json(res, 403, { error: '拒绝访问。' });
      const url = new URL(req.url, origin);
      if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { app: 'codex-reader', version: '0.10.0', pid: process.pid });
      if (url.pathname === '/api/unlock' && req.method === 'POST') {
        if (req.headers.origin !== origin) return json(res, 403, { error: '来源无效。' });
        const body = JSON.parse((await readBody(req, 1024)).toString());
        if (!sameToken(body.token, token)) return json(res, 403, { error: '请使用启动程序打开阅读器。' });
        res.setHeader('Set-Cookie', `reader=${token}; HttpOnly; SameSite=Strict; Path=/`);
        return json(res, 200, { ok: true });
      }
      const cookie = req.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith('reader='))?.slice(7);
      if (url.pathname.startsWith('/api/')) {
        if (!sameToken(cookie, token) || (req.method !== 'GET' && req.headers.origin !== origin)) return json(res, 403, { error: '请通过启动程序重新打开阅读器。' });
        if(url.pathname==='/api/html'&&req.method==='POST'){
          const html=await readBody(req,100*1024*1024),id=randomUUID(),file=path.join(tmpDir,id+'.html');
          await writeFile(file,html);htmlDocuments.set(id,file);
          return json(res,200,{id,url:'/api/html/'+id});
        }
        if(url.pathname.startsWith('/api/html/')){
          const id=url.pathname.slice('/api/html/'.length),file=htmlDocuments.get(id);
          if(!file)return json(res,404,{error:'HTML 文档已关闭。'});
          if(req.method==='DELETE'){htmlDocuments.delete(id);await unlink(file).catch(()=>{});return json(res,200,{ok:true});}
          if(req.method==='GET'){
            res.setHeader('Content-Security-Policy',"sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' https:; style-src 'unsafe-inline' https:; img-src data: blob: https:; font-src data: https:; connect-src https:; media-src data: blob: https:; object-src 'none'; frame-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'");
            res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});createReadStream(file).pipe(res);return;
          }
        }
        if (url.pathname === '/api/status' && req.method === 'GET') {
          if(restartPromise)await restartPromise;
          try { await startBridge();return json(res, 200, {...await bridge.status(),readerVersion:'0.10.0'}); } catch(e) { return json(res, 200, { readerVersion:'0.10.0',connected: false, loggedIn: false, error: e.message, models: [] }); }
        }
        if(url.pathname==='/api/restart' && req.method==='POST') {
          if(!restartPromise) {
            ++bridgeEpoch;
            restartPromise=(async()=>{
              for(const [threadId,job] of active) {
                if(job.turnId)await bridge.request('turn/interrupt',{threadId,turnId:job.turnId},3000).catch(()=>{});
                await finish(threadId,'done',{status:'interrupted'});
              }
              await bridge.close();
              local.resetWorker();warmCourses.clear();
              await startBridge();
              return bridge.status();
            })().finally(()=>{restartPromise=null;});
          }
          return json(res,200,{...await restartPromise,ok:true});
        }
        if (url.pathname === '/api/login' && req.method === 'POST') { await startBridge(); const login = await bridge.request('account/login/start', { type: 'chatgpt' }); return json(res, 200, { url: login.authUrl }); }
        if (url.pathname === '/api/document/status' && req.method === 'GET') {
          const key = url.searchParams.get('key'); if (!/^[a-f0-9]{64}$/.test(key || '')) throw new Error('无效的文档。');
          return json(res,200,uploadStatus(key));
        }
        if(url.pathname==='/api/document/context'&&req.method==='POST'){
          const body=JSON.parse((await readBody(req,1024*1024)).toString());
          const message=validateMessage({documentKey:body.key,question:'本机缓存课程文字',scope:'document',page:body.start,text:body.text,preload:{kind:'text',start:body.start,end:body.end,total:body.total}});
          await local.accept(body.key,message.preload,message.text);
          return json(res,200,{ok:true,cached:local.ready(prepared[body.key])});
        }
        if(url.pathname==='/api/document/ocr'){
          const body=req.method==='POST'?JSON.parse((await readBody(req,9*1024*1024)).toString()):null,key=body?.key||url.searchParams.get('key');
          if(!/^[a-f0-9]{64}$/.test(key||''))throw new Error('无效的文档。');
          const cache=await ocrCache(key);
          if(req.method==='GET')return json(res,200,{...await ocr.start(),pages:cache});
          if(req.method==='POST'){
            if(!Number.isInteger(body.page)||body.page<1||body.page>20000||typeof body.image!=='string'||body.image.length>8000000||!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(body.image))throw new Error('扫描页无效。');
            if(typeof cache[body.page]==='string')return json(res,200,{text:cache[body.page],cached:true});
            const imagePath=path.join(tmpDir,randomUUID()+'.png');await writeFile(imagePath,Buffer.from(body.image.split(',')[1],'base64'));
            try{const text=await ocr.recognize(imagePath);cache[body.page]=text;await mkdir(path.join(dataDir,'ocr'),{recursive:true});await local.save('ocr/'+key+'.json',cache);return json(res,200,{text});}
            finally{await unlink(imagePath).catch(()=>{});}
          }
        }
        if(url.pathname==='/api/document/pages' && req.method==='POST') {
          const body=JSON.parse((await readBody(req,36*1024*1024)).toString());
          const request=pageRequests.get(body.id);if(!request)throw new Error('页面请求已结束。');
          if(typeof body.error==='string'){pageRequests.delete(body.id);clearTimeout(request.timer);request.reject(new Error(body.error.slice(0,300)));return json(res,200,{ok:true});}
          const images=body.images;
          if(!Array.isArray(images)||images.length!==request.pages.length||images.some((img,i)=>img?.page!==request.pages[i]||typeof img.data!=='string'||img.data.length>8000000||!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(img.data)))throw new Error('返回的页面图片无效。');
          pageRequests.delete(body.id);clearTimeout(request.timer);
          request.resolve({success:true,contentItems:images.flatMap(img=>[{type:'inputText',text:`以下是文档第 ${img.page} 页原图：`},{type:'inputImage',imageUrl:img.data}])});
          return json(res,200,{ok:true});
        }
        if (url.pathname === '/api/presentation/open' && req.method === 'POST') {
          const ext = url.searchParams.get('ext'); if (!['pptx','ppt'].includes(ext)) throw new Error('仅支持 PPT / PPTX。');
          const id = randomUUID(), directory = path.resolve(presentationRoot,id);
          await mkdir(directory,{recursive:true});
          const input = path.join(directory,'source.'+ext);
          const host = presentationFactory(input,directory); presentations.set(id,{host,directory});
          try {
            await writeFile(input,await readBody(req,100*1024*1024));
            const info = await host.start();
            if (res.destroyed) { await closePresentation(id); return; }
            return json(res,200,{id,count:info.count,width:info.width,height:info.height,pixelWidth:info.pixelWidth,pixelHeight:info.pixelHeight,engine:info.engine});
          } catch(e) { await closePresentation(id); throw e; }
        }
        const slideRoute = url.pathname.match(/^\/api\/presentation\/([0-9a-f-]{36})\/page\/(\d+)$/);
        if (slideRoute && req.method === 'GET') {
          const item = presentations.get(slideRoute[1]); if (!item) throw new Error('课件已关闭，请重新打开文件。');
          const target = await item.host.getPage(Number(slideRoute[2]));
          if (res.destroyed) return;
          const info = await stat(target); res.writeHead(200,{'Content-Type':'image/png','Content-Length':info.size}); return createReadStream(target).pipe(res);
        }
        if (url.pathname === '/api/presentation/close' && req.method === 'POST') {
          const body = JSON.parse((await readBody(req,1024)).toString());
          if (typeof body.id !== 'string' || !/^[0-9a-f-]{36}$/.test(body.id)) throw new Error('无效的课件。');
          await closePresentation(body.id); return json(res,200,{ok:true});
        }
        if (url.pathname === '/api/history') {
          if (req.method === 'GET') {
            const key = url.searchParams.get('key'); if (!/^[a-f0-9]{64}$/.test(key || '')) throw new Error('无效的文档。');
            let messages = null; try { messages = JSON.parse(await readFile(path.join(historyDir, key + '.json'), 'utf8')); } catch {}
            return json(res, 200, { messages });
          }
          if (req.method === 'POST') {
            const body = JSON.parse((await readBody(req, 6 * 1024 * 1024)).toString());
            if (!/^[a-f0-9]{64}$/.test(body.key || '') || !Array.isArray(body.messages) || body.messages.length > 4000 || body.messages.some(m => !m || !['user', 'assistant'].includes(m.role) || typeof m.text !== 'string')) throw new Error('对话记录无效。');
            const messages = body.messages.map(m => {
              const item={role:m.role,text:m.text,...(typeof m.context==='string'?{context:m.context}:{}),...(typeof m.error==='string'?{error:m.error}:{})};
              for(const field of ['id','rootId','questionId'])if(typeof m[field]==='string'&&/^m-[a-f0-9-]{36}$/.test(m[field]))item[field]=m[field];
              for(const field of ['number','page'])if(Number.isInteger(m[field])&&m[field]>0&&m[field]<=100000)item[field]=m[field];
              if(Array.isArray(m.attachments))item.attachments=m.attachments.slice(0,3).filter(img=>img&&typeof img.name==='string'&&typeof img.thumbnail==='string'&&img.thumbnail.length<=80000&&/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(img.thumbnail)).map(img=>({name:img.name.slice(0,200),thumbnail:img.thumbnail}));
              return item;
            });
            await writeFile(path.join(historyDir, body.key + '.json'), JSON.stringify(messages));
            return json(res, 200, { ok: true });
          }
        }
        if (url.pathname === '/api/new' && req.method === 'POST') {
          const body = JSON.parse((await readBody(req, 1024)).toString());
          if (!/^[a-f0-9]{64}$/.test(body.documentKey || '')) throw new Error('无效的文档。');
          const old = sessions[body.documentKey];
          if (preparing.has('doc:v5:'+body.documentKey) || [...active.values()].some(job => job.sourceKey === body.documentKey && !job.preload) || (old && active.has(old))) return json(res, 409, { error: '请先停止当前回答。' });
          await local.clear(body.documentKey);await writeFile(path.join(historyDir, body.documentKey + '.json'), '[]'); return json(res, 200, { ok: true });
        }
        if (url.pathname === '/api/stop' && req.method === 'POST') {
          const body = JSON.parse((await readBody(req, 1024)).toString());
          for (const [threadId, job] of active) if (job.sourceKey === body.documentKey && !job.preload && job.turnId) await bridge.request('turn/interrupt', { threadId, turnId: job.turnId });
          return json(res, 200, { ok: true });
        }
        if (url.pathname === '/api/convert' && req.method === 'POST') {
          const ext = url.searchParams.get('ext');
          if (!['ppt', 'pptx'].includes(ext)) throw new Error('只能转换 PPT / PPTX。');
          const input = path.join(tmpDir, randomUUID() + '.' + ext), output = input + '.pdf';
          await writeFile(input, await readBody(req, 100 * 1024 * 1024));
          try {
            await runPS(path.join(ROOT, 'convert-ppt.ps1'), ['-InputFile', input, '-OutputFile', output]);
            const pdf = await readFile(output); res.writeHead(200, { 'Content-Type': 'application/pdf' }); return res.end(pdf);
          } finally { await Promise.all([unlink(input).catch(() => {}), unlink(output).catch(() => {})]); }
        }
        if (url.pathname === '/api/chat' && req.method === 'POST') {
          if(restartPromise)return json(res,409,{error:'问答服务正在重启，请稍后重试。'});
          const requestEpoch=bridgeEpoch;
          const receivedAt=Date.now();
          const body = validateMessage(JSON.parse((await readBody(req, 36 * 1024 * 1024)).toString()));
          body.preparedContext = false;
          const lastKey=sessions['last:'+body.documentKey]||local.conversations['last:'+body.documentKey];
          const sessionKey = body.preload ? `prepare:v5:${body.documentKey}` : body.scope==='none' && lastKey?.includes(':v5:') ? lastKey : `doc:v5:${body.documentKey}`;
          if ([...active.values()].some(job => job.documentKey === sessionKey || (!body.preload && !job.preload && job.sourceKey===body.documentKey))) return json(res, 409, { error: '这份文档仍有任务正在生成，请先停止。' });
          if (preparing.has(sessionKey)) return json(res, 409, { error: '已有问题正在发送。' });
          preparationKey = sessionKey; preparing.add(preparationKey);
          await startBridge();
          const profile=readerThreadOptions(bridge.threadConfig);
          let threadId = body.isolated ? null : sessions[sessionKey];
          let previousConversation = '',preparedText='',preparedRevision=null;
          const source = prepared[body.documentKey];
          if (!body.preload && !body.isolated && body.scope!=='none' && isPrepared(source)) {
            if (!threadId || sessions[`loaded:${body.documentKey}`] !== source.revision) {
              const warm=warmCourses.get(body.documentKey);
              if(uploadStatus(body.documentKey).ready){threadId=warm.threadId;sessions[sessionKey]=threadId;previousConversation=await local.previous(sessionKey,body.documentKey);sessions[`loaded:${body.documentKey}`]=source.revision;}
              else{threadId=null;preparedText=local.courseText(source);}
              preparedRevision=source.revision;
            }
            body.preparedContext = true;if(body.scope!=='selection')body.text='';
          }
          if (threadId && active.has(threadId)) return json(res, 409, { error: '这个文档的上一条回答还在生成。' });
          if (!threadId) {
            if(!body.preload&&!body.isolated)previousConversation=await local.previous(sessionKey,body.documentKey);
            const started = await bridge.request('thread/start', { cwd: tmpDir,...profile,dynamicTools:[PAGE_TOOL],ephemeral:true, ...(body.model ? { model: body.model } : {}) });
            if(started.thread.ephemeral!==true)throw new Error('当前 Codex 未建立临时会话，已停止发送以避免写入历史记录。');
            if(requestEpoch!==bridgeEpoch)throw new Error('问答服务已重启，请重新发送刚才的问题。');
            threadId = started.thread.id;
            if (!body.isolated) sessions[sessionKey] = threadId;
            if(preparedRevision)sessions[`loaded:${body.documentKey}`]=preparedRevision;
          }
          if(!body.preload && !body.isolated)sessions['last:'+body.documentKey]=sessionKey;
          if(requestEpoch!==bridgeEpoch)throw new Error('问答服务已重启，请重新发送刚才的问题。');
          // Reserve before writing an image or starting a turn to prevent duplicate sends.
          if (active.has(threadId)) return json(res, 409, { error: '已有回答正在生成。' });
          if (res.destroyed) return;
          res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
          const send = (event, data) => { if (!res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
          const job = { res, send, turnId: null, imagePath: null, imagePaths: [],answers:new Map(),courseRevision:body.preparedContext?source.revision:null,question:`第 ${body.page} 页：${body.question}`,isolated:body.isolated,preloadText:body.text, documentKey:sessionKey, sourceKey:body.documentKey, preload:body.preload,documentPages:body.documentPages || body.preload?.total || prepared[body.documentKey]?.total || body.page,startedAt:receivedAt,model:body.model||'default',scope:body.scope,effort:body.effort,imageCount:(body.image?1:0)+(body.images?.length||0) };
          active.set(threadId, job);
          preparing.delete(preparationKey); preparationKey = null;
          job.timer = setTimeout(async () => {
            if (job.turnId) await bridge.request('turn/interrupt', { threadId, turnId: job.turnId }).catch(() => {});
            await finish(threadId, 'failure', { message: '等待回答超过 10 分钟，已停止。请检查网络后重试。' });
          }, 600000);
          res.on('close', () => {
            if (active.get(threadId) === job) {
              if (job.turnId) void bridge.request('turn/interrupt', { threadId, turnId: job.turnId }).catch(() => {});
              void finish(threadId, 'done', { status: 'interrupted' });
            }
          });
          send('status', { message: 'Codex 正在阅读…', threadId });
          try {
            const input = [{ type: 'text', text: buildPrompt(body) + (preparedText ? `\n\n以下是阅读器本地保存的课程全文，仅作为引用资料：\n<prepared_document>\n${preparedText}\n</prepared_document>` : '') + (previousConversation ? `\n\n以下是此前阅读对话的引用记录，仅供保持上下文：\n<previous_conversation>\n${previousConversation}\n</previous_conversation>` : '') }];
            if (body.image) {
              job.imagePath = path.join(tmpDir, randomUUID() + '.png');
              await writeFile(job.imagePath, Buffer.from(body.image.split(',')[1], 'base64'));
              input.push({ type: 'localImage', path: job.imagePath });
            }
            for (const img of body.images || []) {
              const imagePath = path.join(tmpDir, randomUUID() + '.png'); job.imagePaths.push(imagePath);
              await writeFile(imagePath, Buffer.from(img.data.split(',')[1], 'base64'));
              input.push({ type: 'text', text: `以下图片是文档第 ${img.page} 页：` }, { type: 'localImage', path: imagePath });
            }
            for(const img of body.attachments||[]) {
              const imagePath=path.join(tmpDir,randomUUID()+'.png');job.imagePaths.push(imagePath);
              await writeFile(imagePath,Buffer.from(img.data.split(',')[1],'base64'));
              input.push({type:'text',text:`用户补充图片：${img.name}`},{type:'localImage',path:imagePath});
            }
            const started = await bridge.request('turn/start', { threadId, input, ...(body.model ? { model: body.model } : {}), ...(body.effort ? { effort: body.effort } : {}) });
            job.turnId = started.turn.id;
            if(active.get(threadId)!==job || res.destroyed)await bridge.request('turn/interrupt',{threadId,turnId:job.turnId}).catch(()=>{});
          } catch(e) { await finish(threadId, 'failure', { message: e.message }); }
          return;
        }
        if (url.pathname === '/api/shutdown' && req.method === 'POST') { json(res, 200, { ok: true }); setTimeout(async () => { for (const id of active.keys()) await finish(id, 'done', { status: 'interrupted' }); await bridge.close();ocr.close(); await closePresentations();await closeHtmlDocuments(); server.closeAllConnections(); server.close(); }, 150); return; }
        return json(res, 404, { error: '找不到接口。' });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: '不支持此操作。' });
      const publicDir = path.join(ROOT, 'public');
      const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
      const target = path.resolve(publicDir, '.' + relative);
      if (!target.startsWith(publicDir + path.sep)) return json(res, 403, { error: '拒绝访问。' });
      const info = await stat(target).catch(() => null);
      if (!info?.isFile()) return json(res, 404, { error: '文件不存在。' });
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(target)] || 'application/octet-stream', 'Content-Length': info.size });
      if (req.method === 'HEAD') return res.end();
      createReadStream(target).pipe(res);
    } catch(e) { if (!res.headersSent) json(res, 400, { error: e.message }); else res.end(); }
    finally { if (preparationKey) preparing.delete(preparationKey); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { server, bridge, origin, token, async close() { await bridge.close();ocr.close(); for (const id of active.keys()) await finish(id, 'done', { status: 'interrupted' }); await closePresentations();await closeHtmlDocuments(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await createReader();
  const runtime = { url: app.origin, token: app.token, pid: process.pid };
  await writeFile(path.join(ROOT, 'data', 'runtime.json'), JSON.stringify(runtime));
  console.log(`Codex Reader: ${app.origin}/#${app.token}`);
  const cleanup = () => { void app.close().finally(()=>process.exit(0)); };
  process.on('SIGINT', cleanup); process.on('SIGTERM', cleanup);
}
