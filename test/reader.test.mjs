import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, readdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createReader } from '../server.mjs';
import { validateMessage, buildPrompt, MAX_TEXT } from '../lib/context.mjs';

export class TestBridge extends EventEmitter {
  constructor({ autoComplete = true } = {}) { super(); this.calls = []; this.autoComplete = autoComplete; this.next = 0; this.reply = '这是文档的解释。'; }
  async start() {}
  async status() { return { connected: true, loggedIn: true, models: [{ id: 'test-model', name: 'Test', image: true }] }; }
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === 'thread/start') return { thread: { id: 'thread-' + ++this.next,ephemeral:params.ephemeral===true } };
    if (method === 'thread/fork') return { thread: { id: 'thread-' + ++this.next } };
    if (method === 'thread/resume') return { thread: { id: params.threadId } };
    if (method === 'turn/start') {
      const turnId = 'turn-' + ++this.next;
      setTimeout(() => {
        this.emit('notification', { method: 'turn/started', params: { threadId: params.threadId, turn: { id: turnId } } });
        if (this.autoComplete) {
          this.emit('notification', { method: 'item/agentMessage/delta', params: { threadId: params.threadId, turnId, itemId: 'reply', delta: this.reply } });
          this.emit('notification', { method: 'item/completed', params: { threadId: params.threadId, turnId, item: { type: 'agentMessage', id: 'reply', text: this.reply } } });
          this.emit('notification', { method: 'turn/completed', params: { threadId: params.threadId, turn: { id: turnId, status: 'completed' } } });
        }
      }, 30);
      return { turn: { id: turnId } };
    }
    if (method === 'turn/interrupt') setTimeout(() => this.emit('notification', { method: 'turn/completed', params: { threadId: params.threadId, turn: { id: params.turnId, status: 'interrupted' } } }), 5);
    return {};
  }
  close() {}
}
const message = changes => ({ question: '解释这一页', documentKey: 'a'.repeat(64), fileName: '测试.pdf', page: 2, scope: 'page', text: '文档正文', ...changes });
async function setup(t, bridge = new TestBridge(), options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'codex-reader-test-'));
  const app = await createReader({ dataDir, bridge, ...options });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const url = route => app.origin + route;
  const unlock = await fetch(url('/api/unlock'), { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: app.token }) });
  const cookie = unlock.headers.get('set-cookie').split(';')[0];
  const send = (route, body, extra = {}) => fetch(url(route), { method: 'POST', headers: { Cookie: cookie, Origin: app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...extra });
  return { app, url, cookie, send, bridge, dataDir };
}
test('rejects oversized context and document content when scope is none', () => {
  assert.throws(() => validateMessage(message({ text: 'x'.repeat(MAX_TEXT + 1) })), /超过/);
  assert.throws(() => validateMessage(message({ scope: 'none' })), /不附带/);
  assert.throws(() => validateMessage(message({ scope: 'selection', text: '' })), /选中文字/);
  assert.throws(() => validateMessage(message({ image: 'data:text/html;base64,AAAA' })), /图片/);
  assert.throws(() => validateMessage(message({ documentKey: '../secrets' })), /打开文档/);
  assert.throws(() => validateMessage(message({ effort: 1 })), /回答速度/);
});
test('prompt carries exact page, scope, and quotation boundaries', () => {
  const text = buildPrompt(validateMessage(message()));
  assert.match(text, /当前页码：2/); assert.match(text, /范围：当前页/); assert.match(text, /<document_content>\n文档正文\n<\/document_content>/);
});

test('reader settings, real file paths and reading position survive a new server origin without Codex',async t=>{
  const dataDir=await mkdtemp(path.join(os.tmpdir(),'reader-memory-')),fixture=path.join(dataDir,'课程.pdf');await writeFile(fixture,'local document');let app,cookie;
  t.after(async()=>{await app?.close();await rm(dataDir,{recursive:true,force:true});});
  async function start(){const bridge=new TestBridge();app=await createReader({dataDir,bridge,pickFile:async()=>({path:fixture})});const response=await fetch(app.origin+'/api/unlock',{method:'POST',headers:{Origin:app.origin},body:JSON.stringify({token:app.token})});cookie=response.headers.get('set-cookie').split(';')[0];return bridge;}
  const send=(route,body)=>fetch(app.origin+'/api/'+route,{method:'POST',headers:{Cookie:cookie,Origin:app.origin},body:JSON.stringify(body)});
  const read=route=>fetch(app.origin+'/api/'+route,{headers:{Cookie:cookie}});
  let bridge=await start();assert.equal((await send('preferences',{theme:'dark',chatCollapsed:true,readingMode:'single',answerZoom:1.2})).status,200);
  const picked=await(await send('files/pick',{})).json();assert.equal(path.basename(picked.file.path),'课程.pdf');
  assert.equal(await(await read('files/content?id='+picked.file.id)).text(),'local document');
  assert.equal((await fetch(app.origin+'/api/files/content?id='+picked.file.id)).status,403);
  await send('files/opened',{id:picked.file.id});await send('files/page',{id:picked.file.id,page:7});assert.equal(bridge.calls.length,0);
  await app.close();bridge=await start();
  const saved=await(await read('memory')).json();assert.equal(saved.preferences.theme,'dark');assert.equal(saved.preferences.chatCollapsed,true);assert.equal(saved.lastFileId,picked.file.id);assert.equal(saved.files[0].page,7);assert.equal(saved.files[0].path,picked.file.path);assert.equal(bridge.calls.length,0);
  const html=await(await fetch(app.origin)).text();assert.match(html,/data-theme="dark"/);assert.match(html,/<body class="chat-collapsed">/);
  assert.equal((await send('preferences',{theme:'invalid'})).status,400);
  await rm(fixture);const missing=await read('files/content?id='+picked.file.id);assert.equal(missing.status,400);assert.match((await missing.json()).error,/移动或删除/);
  await send('files/forget',{id:picked.file.id});assert.equal((await(await read('memory')).json()).files.length,0);
});

test('HTML keeps scripts in a private isolated document and removes its file on close',async t=>{
  const {send,url,cookie,app,dataDir}=await setup(t);
  const html='<!doctype html><html><body><h1>课程</h1><script>document.body.dataset.ready="yes"</script></body></html>';
  const created=await send('/api/html',null,{headers:{Cookie:cookie,Origin:app.origin,'Content-Type':'text/html'},body:html});
  assert.equal(created.status,200);const document=await created.json();
  assert.equal((await fetch(url(document.url))).status,403);
  const response=await fetch(url(document.url),{headers:{Cookie:cookie}});
  assert.equal(await response.text(),html);assert.match(response.headers.get('content-security-policy'),/sandbox allow-scripts;/);
  assert.doesNotMatch(response.headers.get('content-security-policy'),/allow-same-origin/);
  assert.equal((await fetch(url(document.url),{method:'DELETE',headers:{Cookie:cookie,Origin:app.origin}})).status,200);
  assert.equal((await fetch(url(document.url),{headers:{Cookie:cookie}})).status,404);
  assert.deepEqual((await readdir(path.join(dataDir,'tmp'))).filter(name=>name.endsWith('.html')),[]);
});
test('requires local cookie and origin; blocks access to private app files', async t => {
  const { url, cookie, app } = await setup(t);
  assert.equal((await fetch(url('/api/status'))).status, 403);
  assert.equal((await fetch(url('/api/new'), { method: 'POST', headers: { Cookie: cookie, Origin: 'https://elsewhere.invalid' }, body: '{}' })).status, 403);
  assert.equal((await fetch(url('/api/status'), { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await fetch(url('/server.mjs'))).status, 404);
  assert.equal((await fetch(url('/data/sessions.json'))).status, 404);
  assert.equal((await fetch(url('/api/unlock'), { method: 'POST', headers: { Origin: app.origin }, body: JSON.stringify({ token: '错'.repeat(64) }) })).status, 403);
});

test('original slides are private, loaded on demand, bounded, and removed on close', async t => {
  let host;
  const { send, url, cookie, app, dataDir } = await setup(t, undefined, { presentationFactory: (input, directory) => host = {
    directory, closed: false,
    async start() { await writeFile(path.join(directory,'page-1.png'),'first slide'); return {engine:'WPS',count:3,width:720,height:540}; },
    async getPage(page) { if (!Number.isInteger(page) || page < 1 || page > 3) throw new Error('页码超出范围'); const target = path.join(directory,`page-${page}.png`); await writeFile(target,'slide image'); return target; },
    async close() { this.closed = true; }
  } });
  const response = await fetch(url('/api/presentation/open?ext=pptx'), {method:'POST', headers:{Cookie:cookie,Origin:app.origin}, body:Buffer.from('presentation bytes')});
  assert.equal(response.status,200);
  const info = await response.json(); assert.equal(info.width / info.height,4/3);
  assert.deepEqual((await readdir(host.directory)).sort(),['page-1.png','source.pptx']);
  const route = `/api/presentation/${info.id}/page/2`;
  assert.equal((await fetch(url(route))).status,403);
  const image = await fetch(url(route),{headers:{Cookie:cookie}});
  assert.equal(image.status,200); assert.equal(image.headers.get('content-type'),'image/png'); assert.equal(await image.text(),'slide image');
  assert.equal((await fetch(url(`/api/presentation/${info.id}/page/999`),{headers:{Cookie:cookie}})).status,400);
  assert.equal((await send('/api/presentation/close',{id:'../outside'})).status,400);
  assert.equal((await send('/api/presentation/close',{id:info.id})).status,200); assert.equal(host.closed,true);
  assert.deepEqual(await readdir(path.join(dataDir,'tmp','presentations')),[]);
  assert.equal((await fetch(url(route),{headers:{Cookie:cookie}})).status,400);
});
test('streams an answer, retains same-document context, isolates different documents', async t => {
  const { send, bridge } = await setup(t);
  const first = await (await send('/api/chat', message())).text();
  assert.match(first, /event: delta/); assert.match(first, /这是文档的解释/); assert.match(first, /event: done/);
  await (await send('/api/chat', message({ question: '继续解释' }))).text();
  await (await send('/api/chat', message({ documentKey: 'b'.repeat(64) }))).text();
  const turns = bridge.calls.filter(c => c.method === 'turn/start');
  assert.equal(turns[0].params.threadId, turns[1].params.threadId);
  assert.notEqual(turns[0].params.threadId, turns[2].params.threadId);
  assert.equal(bridge.calls.filter(c => c.method === 'thread/start').length, 2);
  assert.equal(bridge.calls.find(c => c.method === 'thread/start').params.sandbox, 'read-only');
});
test('rejects duplicate sends during preparation without creating a second thread', async t => {
  const bridge = new TestBridge(); const original = bridge.request.bind(bridge);
  bridge.request = async (method, params) => { if (method === 'thread/start') await new Promise(r => setTimeout(r, 80)); return original(method, params); };
  const { send } = await setup(t, bridge);
  const first = send('/api/chat', message()); await new Promise(r => setTimeout(r, 20));
  assert.equal((await send('/api/chat', message())).status, 409);
  await (await first).text();
  assert.equal(bridge.calls.filter(c => c.method === 'thread/start').length, 1);
});
test('stops an active answer, rejects context reset while generating', async t => {
  const { send, bridge } = await setup(t, new TestBridge({ autoComplete: false }));
  const answer = await send('/api/chat', message());
  await new Promise(r => setTimeout(r, 45));
  assert.equal((await send('/api/new', { documentKey: 'a'.repeat(64) })).status, 409);
  assert.equal((await send('/api/chat', message())).status, 409);
  await send('/api/stop', { documentKey: 'a'.repeat(64) });
  assert.match(await answer.text(), /interrupted/);
  assert.equal(bridge.calls.filter(c => c.method === 'turn/interrupt').length, 1);
});
test('a new conversation starts a fresh thread', async t => {
  const { send, bridge } = await setup(t);
  await (await send('/api/chat', message())).text();
  await send('/api/new', { documentKey: 'a'.repeat(64) });
  await (await send('/api/chat', message())).text();
  const calls = bridge.calls.filter(c => c.method === 'turn/start'); assert.notEqual(calls[0].params.threadId, calls[1].params.threadId);
});
test('page screenshot is sent as a local image and deleted after completion', async t => {
  const { send, bridge, dataDir } = await setup(t);
  await (await send('/api/chat', message({ image: 'data:image/png;base64,iVBORw0KGgo=' }))).text();
  const input = bridge.calls.find(c => c.method === 'turn/start').params.input;
  assert.equal(input[1].type, 'localImage');
  await new Promise(r => setTimeout(r, 30));
  assert.deepEqual(await readdir(path.join(dataDir, 'tmp')), []);
});
test('backend disconnect ends the stream with an actionable error', async t => {
  const { send, bridge } = await setup(t, new TestBridge({ autoComplete: false }));
  const answer = await send('/api/chat', message()); bridge.emit('offline', '连接断开');
  assert.match(await answer.text(), /连接断开/);
});
test('isolated document batches do not replace the main conversation', async t => {
  const { send, bridge } = await setup(t);
  await (await send('/api/chat', message())).text();
  await (await send('/api/chat', message({ isolated: true }))).text();
  await (await send('/api/chat', message())).text();
  const turns = bridge.calls.filter(c => c.method === 'turn/start');
  assert.equal(turns[0].params.threadId, turns[2].params.threadId);
  assert.notEqual(turns[0].params.threadId, turns[1].params.threadId);
  assert.equal(bridge.calls.filter(c => c.method === 'thread/start')[1].params.ephemeral, true);
});
test('multi-page screenshots retain page labels and are all cleaned up', async t => {
  const { send, bridge, dataDir } = await setup(t);
  await (await send('/api/chat', message({ images: [1,2,3].map(page => ({ page, data: 'data:image/png;base64,iVBORw0KGgo=' })) }))).text();
  const input = bridge.calls.find(c => c.method === 'turn/start').params.input;
  assert.equal(input.filter(i => i.type === 'localImage').length, 3);
  assert.ok(input.some(i => i.type === 'text' && i.text === '以下图片是文档第 3 页：'));
  await new Promise(r => setTimeout(r, 30)); assert.deepEqual(await readdir(path.join(dataDir, 'tmp')), []);
});
test('chat history survives server restart and origin change', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'reader-persist-')); let app;
  t.after(async () => { await app?.close(); await rm(dataDir, { recursive: true, force: true }); });
  async function unlock() {
    const r = await fetch(app.origin + '/api/unlock', { method: 'POST', headers: { Origin: app.origin }, body: JSON.stringify({ token: app.token }) });
    return r.headers.get('set-cookie').split(';')[0];
  }
  app = await createReader({ dataDir, bridge: new TestBridge() }); let cookie = await unlock();
  const messages = [{ role: 'assistant', text: '已保存的解答', context: '习题解答 · 第 1—3 页' }];
  const saved = await fetch(app.origin + '/api/history', { method: 'POST', headers: { Cookie: cookie, Origin: app.origin }, body: JSON.stringify({ key: 'a'.repeat(64), messages }) }); assert.equal(saved.status, 200);
  await app.close(); app = await createReader({ dataDir, bridge: new TestBridge() }); cookie = await unlock();
  const result = await (await fetch(app.origin + '/api/history?key=' + 'a'.repeat(64), { headers: { Cookie: cookie } })).json(); assert.deepEqual(result.messages, messages);
});
test('answer speed reaches each Codex turn and can change within one conversation', async t => {
  const { send, bridge } = await setup(t);
  await (await send('/api/chat', message({ effort:'low' }))).text();
  await (await send('/api/chat', message({ effort:'high' }))).text();
  const turns = bridge.calls.filter(c => c.method === 'turn/start');
  assert.equal(turns[0].params.effort,'low'); assert.equal(turns[1].params.effort,'high');
  assert.equal(turns[0].params.threadId,turns[1].params.threadId);
});

test('page, selection and document questions reuse the warmed whole-course context without resending it',async t=>{
  const {send,bridge}=await setup(t);
  await(await send('/api/chat',message({scope:'document',page:1,text:'[第1页] FIRST [第2页] SECOND',preload:{kind:'text',start:1,end:2,total:2}}))).text();
  await(await send('/api/chat',message({scope:'page',page:2}))).text();
  await(await send('/api/chat',message({scope:'selection',text:'SECOND'}))).text();
  await(await send('/api/chat',message({scope:'document',text:'do not resend the whole file'}))).text();
  const turns=bridge.calls.filter(c=>c.method==='turn/start');
  assert.equal(new Set(turns.map(c=>c.params.threadId)).size,1);
  for(const turn of turns.slice(1)){
    assert.match(turn.params.input[0].text,/已预先收到整份文档/);
    assert.doesNotMatch(turn.params.input[0].text,/<prepared_document>|do not resend/);
  }
  assert.match(turns[1].params.input[0].text,/当前页码：2/);
  assert.match(turns[2].params.input[0].text,/SECOND/);
  assert.equal(bridge.calls.filter(c=>c.method==='thread/start').length,1);
});

test('a current-page question answers while background upload is waiting; interruption is not marked uploaded',async t=>{
  const bridge=new TestBridge({autoComplete:false});const {send,url,cookie}=await setup(t,bridge);
  const controller=new AbortController();
  const response=await send('/api/chat',message({scope:'document',preload:{kind:'text',start:1,end:2,total:2}}),{signal:controller.signal});
  const background=response.text().catch(()=>{});await new Promise(r=>setTimeout(r,45));
  bridge.autoComplete=true;
  const answer=await send('/api/chat',message());assert.equal(answer.status,200);assert.match(await answer.text(),/这是文档的解释/);
  controller.abort();await background;await new Promise(r=>setTimeout(r,30));
  const status=await(await fetch(url('/api/document/status?key='+'a'.repeat(64)),{headers:{Cookie:cookie}})).json();
  assert.equal(status.ready,false);assert.deepEqual(status.textPages,[]);
});

test('model can request only validated pages of the active document through the reader',async t=>{
  const bridge=new TestBridge({autoComplete:false}),{send}=await setup(t,bridge);
  const response=await send('/api/chat',message({documentPages:3}));const reader=response.body.getReader();
  await new Promise(r=>setTimeout(r,40));
  const params={threadId:bridge.calls.find(c=>c.method==='turn/start').params.threadId,turnId:'turn-'+bridge.next};
  await assert.rejects(bridge.readDocumentPages({...params,arguments:{pages:[4]}}),/页码无效/);
  await assert.rejects(bridge.readDocumentPages({...params,arguments:{pages:[2,2]}}),/页码无效/);
  const result=bridge.readDocumentPages({...params,arguments:{pages:[2]}});
  let stream='';const decoder=new TextDecoder();while(!stream.includes('event: readPages')){const chunk=await reader.read();stream+=decoder.decode(chunk.value);}
  const request=JSON.parse(stream.match(/event: readPages\ndata: ([^\n]+)/)[1]);
  assert.deepEqual(request.pages,[2]);
  const image='data:image/png;base64,iVBORw0KGgo=';
  assert.equal((await send('/api/document/pages',{id:request.id,images:[{page:3,data:image}]})).status,400);
  assert.equal((await send('/api/document/pages',{id:request.id,images:[{page:2,data:image}]})).status,200);
  const tool=await result;assert.equal(tool.success,true);assert.deepEqual(tool.contentItems,[{type:'inputText',text:'以下是文档第 2 页原图：'},{type:'inputImage',imageUrl:image}]);
  await reader.cancel();await new Promise(r=>setTimeout(r,20));
  await assert.rejects(bridge.readDocumentPages({...params,arguments:{pages:[2]}}),/没有/);
});

test('supplementary images and quoted explanations reach the model; question anchors survive history reload',async t=>{
  const {send,bridge,url,cookie}=await setup(t);
  const data='data:image/png;base64,iVBORw0KGgo=';
  await(await send('/api/chat',message({attachments:[{name:'截图.png',data}],replyContext:{question:'解释第十页',answer:'原讲解内容'}}))).text();
  const input=bridge.calls.find(c=>c.method==='turn/start').params.input;
  assert.equal(input.filter(c=>c.type==='localImage').length,1);assert.match(input[0].text,/<quoted_explanation>/);
  assert.ok(input.some(c=>c.type==='text'&&c.text==='用户补充图片：截图.png'));
  const id='m-'+crypto.randomUUID(),answerId='m-'+crypto.randomUUID();
  const messages=[{id,rootId:id,role:'user',text:'讲解',number:1,page:10,attachments:[{name:'截图.png',thumbnail:data}]},{id:answerId,rootId:id,questionId:id,role:'assistant',text:'回答',page:10}];
  assert.equal((await send('/api/history',{key:'a'.repeat(64),messages})).status,200);
  const history=await(await fetch(url('/api/history?key='+'a'.repeat(64)),{headers:{Cookie:cookie}})).json();
  assert.deepEqual(history.messages,messages);
  assert.throws(()=>validateMessage(message({attachments:[{name:'bad',data:'data:text/html;base64,AAAA'}]})),/补充图片/);
});

test('connection loss creates a new private conversation with locally restored context',async t=>{
  const {send,bridge,dataDir}=await setup(t);
  await writeFile(path.join(dataDir,'sessions.json'),'{}');
  await(await send('/api/chat',message())).text();
  bridge.emit('offline','test disconnect');
  const request=bridge.request.bind(bridge);
  bridge.request=async(method,params)=>{
    if(method==='thread/resume') {bridge.calls.push({method,params});throw new Error(`thread ${params.threadId} already has an active writer`);}
    return request(method,params);
  };
  const oldId=bridge.calls.find(c=>c.method==='turn/start').params.threadId;
  assert.match(await(await send('/api/chat',message())).text(),/event: delta/);
  assert.match(await(await send('/api/chat',message())).text(),/event: delta/);
  assert.equal(bridge.calls.filter(c=>['thread/resume','thread/fork'].includes(c.method)).length,0);
  const turns=bridge.calls.filter(c=>c.method==='turn/start');
  assert.notEqual(turns[1].params.threadId,oldId);assert.equal(turns[2].params.threadId,turns[1].params.threadId);
  assert.match(turns[1].params.input[0].text,/<previous_conversation>[\s\S]*这是文档的解释/);
  assert.deepEqual(JSON.parse(await readFile(path.join(dataDir,'sessions.json'),'utf8')),{});
});

test('quick restart interrupts a turn, coalesces duplicate clicks and restores local history into a new private thread',async t=>{
  const {send,bridge,url,cookie,app}=await setup(t,new TestBridge({autoComplete:false}));
  const history=[{role:'user',text:'保留的问题'}];
  await send('/api/history',{key:'a'.repeat(64),messages:history});
  const stream=await send('/api/chat',message());const answer=stream.text();
  await new Promise(resolve=>setTimeout(resolve,40));
  let closeCount=0,releaseClose;
  let restartRequests=0;app.server.on('request',req=>{if(req.url==='/api/restart')restartRequests++;});
  bridge.close=async()=>{closeCount++;await new Promise(resolve=>{releaseClose=resolve;});};
  const first=send('/api/restart',{});
  while(!releaseClose)await new Promise(resolve=>setTimeout(resolve,5));
  const second=send('/api/restart',{});
  while(restartRequests<2)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal((await send('/api/chat',message())).status,409);
  releaseClose();
  assert.equal((await first).status,200);assert.equal((await second).status,200);assert.equal(closeCount,1);
  bridge.close=()=>{};
  assert.match(await answer,/interrupted/);
  const saved=await(await fetch(url('/api/history?key='+'a'.repeat(64)),{headers:{Cookie:cookie}})).json();
  assert.deepEqual(saved.messages,history);
  bridge.autoComplete=true;
  assert.match(await(await send('/api/chat',message())).text(),/event: delta/);
  const turns=bridge.calls.filter(c=>c.method==='turn/start');assert.notEqual(turns[0].params.threadId,turns[1].params.threadId);
  assert.match(turns[1].params.input[0].text,/<previous_conversation>[\s\S]*保留的问题/);
  assert.ok(bridge.calls.filter(c=>c.method==='thread/start').every(c=>c.params.ephemeral===true));
  assert.equal(bridge.calls.filter(c=>c.method==='thread/resume').length,0);
});

test('a restart fences a question still preparing its thread',async t=>{
  const {send,bridge}=await setup(t);
  const request=bridge.request.bind(bridge);let releaseStart;
  bridge.request=async(method,params)=>{
    if(method==='thread/start')await new Promise(resolve=>{releaseStart=resolve;});
    return request(method,params);
  };
  const question=send('/api/chat',message());
  while(!releaseStart)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal((await send('/api/restart',{})).status,200);
  releaseStart();
  assert.match((await(await question).json()).error,/已重启/);
  assert.equal(bridge.calls.filter(c=>c.method==='turn/start').length,0);
});

test('all foreground, background and batch conversations are ephemeral; native IDs are not persisted',async t=>{
  const {send,bridge,dataDir}=await setup(t);
  await(await send('/api/chat',message())).text();
  await(await send('/api/chat',message({scope:'document',preload:{kind:'text',start:1,end:2,total:2}}))).text();
  await(await send('/api/chat',message({scope:'document'}))).text();
  await(await send('/api/chat',message({isolated:true}))).text();
  const starts=bridge.calls.filter(c=>c.method==='thread/start');assert.equal(starts.length,3);assert.ok(starts.every(c=>c.params.ephemeral===true));
  assert.equal(bridge.calls.filter(c=>['thread/resume','thread/fork'].includes(c.method)).length,0);
  const files=await readdir(dataDir);assert.equal(files.includes('sessions.json'),false);assert.equal(files.includes('prepared.json'),false);
  for(const file of ['course-context.json','conversation-context.json'])assert.doesNotMatch(await readFile(path.join(dataDir,file),'utf8'),/thread-\d+/);
});

test('full course and recent answer context survive a worker restart without stored Codex sessions',async t=>{
  const {send,bridge,url,cookie}=await setup(t);
  await(await send('/api/chat',message({scope:'document',text:'[第1页] COURSE-MARKER',preload:{kind:'text',start:1,end:1,total:1}}))).text();
  await(await send('/api/chat',message({scope:'document',question:'记住这门课的标记'}))).text();
  await send('/api/restart',{});
  const status=await(await fetch(url('/api/document/status?key='+'a'.repeat(64)),{headers:{Cookie:cookie}})).json();assert.equal(status.cached,true);assert.equal(status.ready,false);
  await(await send('/api/chat',message({scope:'document',question:'继续讲解'}))).text();
  const input=bridge.calls.filter(c=>c.method==='turn/start').at(-1).params.input[0].text;
  assert.match(input,/<prepared_document>[\s\S]*COURSE-MARKER/);assert.match(input,/<previous_conversation>[\s\S]*记住这门课的标记[\s\S]*这是文档的解释/);
});

test('legacy native sessions are never resumed; their local messages remain readable',async t=>{
  const dataDir=await mkdtemp(path.join(os.tmpdir(),'reader-private-migration-'));
  const legacyId='00000000-0000-0000-0000-000000000001',key='a'.repeat(64);
  await writeFile(path.join(dataDir,'sessions.json'),JSON.stringify({['page:v5:'+key]:legacyId}));
  const bridge=new TestBridge(),app=await createReader({dataDir,bridge});
  t.after(async()=>{await app.close();await rm(dataDir,{recursive:true,force:true});});
  const unlock=await fetch(app.origin+'/api/unlock',{method:'POST',headers:{Origin:app.origin},body:JSON.stringify({token:app.token})});
  const headers={Origin:app.origin,Cookie:unlock.headers.get('set-cookie').split(';')[0]};
  const oldMessages=[{role:'user',text:'旧版本的问题'},{role:'assistant',text:'旧版本的答案'}];
  await fetch(app.origin+'/api/history',{method:'POST',headers,body:JSON.stringify({key,messages:oldMessages})});
  const result=await fetch(app.origin+'/api/chat',{method:'POST',headers,body:JSON.stringify(message())});assert.match(await result.text(),/event: delta/);
  assert.equal(bridge.calls.some(c=>c.method==='thread/resume'),false);
  assert.match(bridge.calls.find(c=>c.method==='turn/start').params.input[0].text,/旧版本的问题[\s\S]*旧版本的答案/);
  assert.deepEqual(JSON.parse(await readFile(path.join(dataDir,'sessions.json'),'utf8')),{['page:v5:'+key]:legacyId});
});

test('refuses to send a question if a worker fails to honor ephemeral mode',async t=>{
  const {send,bridge}=await setup(t);const request=bridge.request.bind(bridge);
  bridge.request=async(method,params)=>{const result=await request(method,params);if(method==='thread/start')result.thread.ephemeral=false;return result;};
  const response=await send('/api/chat',message());assert.equal(response.status,400);assert.match((await response.json()).error,/临时会话/);
  assert.equal(bridge.calls.some(c=>c.method==='turn/start'),false);
});

test('local staging never starts Codex and page questions use full text while remote upload is stalled',async t=>{
  const bridge=new TestBridge({autoComplete:false});let boots=0;bridge.start=async()=>{boots++;};
  const {send,url,cookie}=await setup(t,bridge),key='a'.repeat(64);
  for(let page=1;page<=2;page++)assert.equal((await send('/api/document/context',{key,start:page,end:page,total:2,text:'[第'+page+'页] '+(page===1?'FIRST-CONTEXT':'LAST-CONTEXT')})).status,200);
  const status=async()=> (await fetch(url('/api/document/status?key='+key),{headers:{Cookie:cookie}})).json();
  assert.equal((await status()).cached,true);assert.equal((await status()).ready,false);assert.equal(boots,0);assert.equal(bridge.calls.length,0);
  const controller=new AbortController();
  const response=await send('/api/chat',message({scope:'document',text:'[第1页] FIRST-CONTEXT',page:1,preload:{kind:'text',start:1,end:1,total:2}}),{signal:controller.signal});
  const background=response.text().catch(()=>{});await new Promise(resolve=>setTimeout(resolve,45));
  bridge.autoComplete=true;
  assert.match(await(await send('/api/chat',message({scope:'page',page:2,text:''}))).text(),/event: delta/);
  const first=bridge.calls.filter(c=>c.method==='turn/start').at(-1).params;
  assert.match(first.input[0].text,/<prepared_document>[\s\S]*FIRST-CONTEXT[\s\S]*LAST-CONTEXT/);
  assert.equal(first.input.filter(item=>item.type==='localImage').length,0);
  await(await send('/api/chat',message({scope:'page',page:1,text:''}))).text();
  const second=bridge.calls.filter(c=>c.method==='turn/start').at(-1).params;
  assert.equal(second.threadId,first.threadId);assert.doesNotMatch(second.input[0].text,/<prepared_document>/);assert.match(second.input[0].text,/当前页码：1/);
  assert.equal((await status()).ready,true);
  controller.abort();await background;
});

test('scanned-page OCR runs locally once and caches the result without starting Codex',async t=>{
  let recognitions=0;const {send,url,cookie,bridge}=await setup(t,undefined,{ocrFactory:()=>({async start(){return {available:true};},async recognize(){recognitions++;return '扫描页全文';},close(){}})});
  const key='a'.repeat(64),body={key,page:1,image:'data:image/png;base64,iVBORw0KGgo='};
  assert.equal((await(await send('/api/document/ocr',body)).json()).text,'扫描页全文');
  assert.equal((await(await send('/api/document/ocr',body)).json()).cached,true);assert.equal(recognitions,1);
  const result=await(await fetch(url('/api/document/ocr?key='+key),{headers:{Cookie:cookie}})).json();assert.equal(result.pages[1],'扫描页全文');assert.equal(bridge.calls.length,0);
});
