import * as pdfjs from '/vendor/pdfjs-dist/build/pdf.mjs';
import { planBatches, exercisePrompt, reviewPrompt, questionScope, asksAllExercises } from './tasks.js';
import { DocumentUpload } from './preload.js';
import {referencedPages,messageId,normalizeConversation} from './conversation.js';
import {ContinuousReader} from './continuous-reader.js';
import {HtmlReader,readHtml} from './html-reader.js';
import {ReaderMemoryClient} from './reader-memory.js';
pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs-dist/build/pdf.worker.mjs';

const $ = id => document.getElementById(id);
const MAX_TEXT = 120000;
const state = { file: null, key: null, pdf: null, slides: null, presentation: null, analysisPdf: null, analysisPending: false, analysisPromise: null, previewUrls: new Set(), page: 1, count: 0, zoom: null, selected: '', messages: [], busy: false, connected: false, loggedIn: false, rendering: false, renderTask: null, textLayer: null, renderVersion: 0, openVersion: 0, textCache: new Map(), cancelled: false, pages: null, indexPromise: null, metadataPromise: null, prepareController: null, waitingToAsk: false, task: null };
let toastTimer;
let documentUpload = null;
let attachments=[],replyTarget=null,activeRootId=null;
let navigationSerial=0,activeQuestionView=0,activeQuestionPage=null;
let continuousReader=null;
const readerMemory=new ReaderMemoryClient({api,onOpen:openFile,canOpen:()=>!state.busy&&!state.rendering&&!state.waitingToAsk,notify:toast,onPreferences:prefs=>{
  if(prefs.theme)setDarkBackground(prefs.theme==='dark',false);
  if(typeof prefs.chatCollapsed==='boolean')setChatCollapsed(prefs.chatCollapsed,false);
  if(prefs.readingMode)$('readingMode').value=prefs.readingMode;
  if(prefs.answerZoom)applyAnswerZoom(prefs.answerZoom);
  if(prefs.chatWidth)document.documentElement.style.setProperty('--chat-width',Math.min(prefs.chatWidth,Math.max(330,innerWidth-340))+'px');
  readerModeHint();
}});
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 6500); }
async function api(route, data) {
  const response = await fetch('/api/' + route, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || '请求失败。'); return result;
}
function updateControls() {
  $('quickRestart').disabled=!!state.restarting;
  $('reconnect').disabled=!!state.restarting;
  $('quickRestart').textContent=state.restarting?'↻ 正在重启…':'↻ 快速重启';
  $('attachImage').disabled=state.busy||state.waitingToAsk||!state.file;
  $('send').disabled = !state.file || !state.connected || !state.loggedIn || state.busy || state.rendering || state.waitingToAsk;
  $('send').hidden = state.busy || state.waitingToAsk; $('stop').hidden = !state.busy && !state.waitingToAsk;
  $('openFile').disabled = state.busy || state.rendering || state.waitingToAsk; $('fileInput').disabled = state.busy || state.rendering || state.waitingToAsk; $('emptyOpen').disabled = state.busy || state.rendering || state.waitingToAsk;
  $('newChat').disabled = !state.key || state.busy || state.waitingToAsk;
  $('originalPreview').disabled = !state.analysisPdf || !state.key || state.busy || state.waitingToAsk || state.rendering;
  $('scope').disabled = state.busy || state.waitingToAsk;
  $('model').disabled = state.busy || state.waitingToAsk; $('effort').disabled = state.busy || state.waitingToAsk;
  $('exportSolutions').hidden = !state.messages.some(m => m.role === 'assistant' && m.context?.startsWith('习题解答 ·') && !m.error && m.text);
  $('exportSolutions').disabled = state.busy;
  $('prevPage').disabled = !state.count || state.page <= 1 || state.rendering;
  $('nextPage').disabled = !state.count || state.page >= state.count || state.rendering;
  $('pageNumber').disabled = !state.count || state.rendering;
  for (const id of ['zoomIn', 'zoomOut', 'zoomFit']) $(id).disabled = !(state.pdf || state.presentation || state.html) || state.rendering;
  $('readingMode').hidden=!!state.html;
  $('scope').querySelector('option[value="selection"]').disabled = !!state.presentation;
  const attachAllowed = !!(state.pdf || state.presentation || state.analysisPdf || state.analysisPending) && ['page', 'document'].includes($('scope').value);
  $('includeImage').disabled = !attachAllowed || state.busy || state.waitingToAsk;
  const scope = $('scope').value;
  $('scope').querySelector('option[value="page"]').textContent=state.html?'当前正文段':'当前页';
  $('contextInfo').textContent = !state.file ? '先打开一份文档' : scope === 'none' ? '仅发送问题，保留前文对话' : scope === 'document' ? `全文文字 · 共 ${state.count} 页` : scope === 'selection' ? `引用 ${state.selected.length} 字` : `第 ${state.page} 页${attachAllowed && $('includeImage').checked ? ' · 全文 + 附图' : ' · 全文上下文'}`;
  if(state.html&&scope==='document')$('contextInfo').textContent=`全文文字 · ${state.count} 段`;
  if(state.html&&scope==='page')$('contextInfo').textContent=`第 ${state.page} 段 · 全文上下文`;
  if(state.restarting)for(const id of ['send','stop','openFile','fileInput','emptyOpen','newChat','attachImage','scope','model','effort','reconnect'])$(id).disabled=true;
  updateCompactStatus();fitQuestionInput();
}
function fitQuestionInput(){const input=$('question');input.style.height='auto';input.style.height=Math.min(110,Math.max(42,input.scrollHeight))+'px';}
function updateCompactStatus(){
  const details=[$('documentIndexStatus').textContent,$('documentUploadStatus').textContent].join('\n');
  const paused=/失败|暂停|尚未开始/.test(details),ready=$('documentUploadStatus').textContent.includes('已交给');
  $('documentSummary').textContent=state.file?`${paused?'准备暂停':ready?'文字就绪':'后台准备'} · ${state.count}页`:'文档详情';
  $('documentSummary').title=details+'\n点击展开详情';
  $('documentSummary').classList.toggle('needs-attention',!!state.file&&paused);
}
async function connect() {
  $('connectionText').textContent = '正在连接本机 Codex…'; $('connectionDot').className = 'status-dot';
  $('reconnect').disabled = true;
  try {
    const result = await api('status'); state.connected = result.connected; state.loggedIn = result.loggedIn;
    $('readerVersion').textContent='本地版'+(result.readerVersion ? ' '+result.readerVersion : '');
    $('connectionDot').className = 'status-dot ' + (result.connected && result.loggedIn ? 'online' : 'error');
    $('connectionText').textContent = result.connected ? (result.loggedIn ? '已连接本机 Codex' : 'Codex 尚未登录') : 'Codex 连接失败';
    $('connectionText').title = result.error || '使用本机 Codex 登录状态';
    $('login').hidden = !result.connected || result.loggedIn;
    const previous = $('model').value; $('model').replaceChildren(new Option('Codex 默认模型', ''));
    state.models = result.models || [];
    for (const model of result.models || []) $('model').add(new Option(model.name, model.id));
    if ([...$('model').options].some(o => o.value === previous)) $('model').value = previous;
    updateEffortOptions();
    if (result.error) toast(result.error);
  } catch(e) { state.connected = false; $('connectionText').textContent = '无法连接，请重新打开阅伴'; $('connectionDot').className = 'status-dot error'; toast(e.message); }
  finally { $('reconnect').disabled = false; updateControls(); if(state.file && state.indexPromise && !documentUpload)void startDocumentUpload(state.openVersion); }
}
function updateEffortOptions() {
  const model = state.models?.find(m => m.id === $('model').value) || state.models?.find(m => m.isDefault) || state.models?.[0];
  const advertised = model?.efforts?.length ? model.efforts : ['low', 'medium', 'high'];
  const ordinary = ['low', 'medium', 'high'].filter(value => advertised.includes(value));
  const supported = ordinary.length ? ordinary : advertised;
  let previous = $('effort').value;
  try {
    if(!localStorage.getItem('codex-reader-fast-default-v5')){localStorage.setItem('codex-reader-effort','low');localStorage.setItem('codex-reader-fast-default-v5','1');}
    previous = localStorage.getItem('codex-reader-effort') || previous;
  } catch {}
  const labels = { none:'即时', minimal:'极速', low:'快速', medium:'均衡', high:'深入', xhigh:'更深入', max:'最深入', ultra:'最深入' };
  $('effort').replaceChildren(...supported.map(value => new Option(labels[value] || value, value)));
  $('effort').value = supported.includes(previous) ? previous : supported.includes('low') ? 'low' : model?.defaultEffort || supported[0];
}

function clearSelection() {
  state.selected = ''; $('selectionPreview').hidden = true; $('selectionIndicator').textContent = '';
  if ($('scope').value === 'selection') $('scope').value = 'page'; updateControls();
}
function captureSelection() {
  const selection = window.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed || !$('pageStage').contains(selection.anchorNode) || !$('pageStage').contains(selection.focusNode)) return;
  const page=selection.anchorNode.parentElement?.closest('[data-page]');if(page)syncReaderPage(Number(page.dataset.page));
  const text = selection.toString().trim(); if (!text) return;
  state.selected = text; $('scope').value = 'selection'; $('selectionPreview').hidden = false;
  $('selectionPreview').querySelector('p').textContent = text;
  $('selectionIndicator').textContent = `已选中 ${text.length} 字`; updateControls();
}
$('pageStage').addEventListener('pointerup', captureSelection);
$('pageStage').addEventListener('keyup', captureSelection);
$('clearSelection').onclick = clearSelection;

async function savedMessages(key = state.key) {
  try { const result = await api('history?key=' + key); if (Array.isArray(result.messages)) return result.messages; } catch {}
  try { const stored = JSON.parse(localStorage.getItem('codex-reader:' + key) || '[]'); return Array.isArray(stored) ? stored.filter(m => ['user', 'assistant'].includes(m.role) && typeof m.text === 'string') : []; } catch { return []; }
}
async function persist() {
  if (!state.key) return;
  const key = state.key, messages = structuredClone(state.messages);
  try { await api('history', { key, messages }); return; } catch {}
  try { localStorage.setItem('codex-reader:' + state.key, JSON.stringify(state.messages)); } catch { toast('浏览器存储已满，请导出对话；本次对话仍可继续。'); }
}
function safeMarkdown(text, mathCache) {
  const math = [], prefix = 'MATH' + crypto.randomUUID().replaceAll('-', '') + 'TOKEN';
  const encoded = text.split(/(```[\s\S]*?```|`[^`\n]*`)/g).map((part, index) => index % 2 ? part : part.replace(/\\\[([\s\S]*?)\\\]|\\\(([\s\S]*?)\\\)|\$\$([\s\S]*?)\$\$|(?<!\\)\$([^$\n]+?)(?<!\\)\$/g, (match, a, b, c, d) => {
    const token = prefix + math.length + 'END'; math.push({ token, expression: a ?? b ?? c ?? d, display: a !== undefined || c !== undefined }); return token;
  })).join('');
  const template = document.createElement('template');
  template.innerHTML = window.marked.parse(encoded, { breaks: true, gfm: true });
  const allowed = new Set(['P','BR','STRONG','EM','DEL','CODE','PRE','BLOCKQUOTE','UL','OL','LI','H1','H2','H3','H4','H5','H6','HR','TABLE','THEAD','TBODY','TR','TH','TD','A']);
  for (const element of [...template.content.querySelectorAll('*')]) {
    if (!allowed.has(element.tagName)) { element.replaceWith(document.createTextNode(element.textContent)); continue; }
    const href = element.tagName === 'A' ? element.getAttribute('href') : null;
    for (const attribute of [...element.attributes]) element.removeAttribute(attribute.name);
    if (href && /^https?:\/\//i.test(href)) { element.href = href; element.target = '_blank'; element.rel = 'noopener noreferrer'; }
  }
  if (math.length && window.katex) {
    const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT), nodes = [];
    while (walker.nextNode()) if (walker.currentNode.textContent.includes(prefix)) nodes.push(walker.currentNode);
    for (const node of nodes) {
      const fragment = document.createDocumentFragment();
      for (const part of node.textContent.split(new RegExp('(' + prefix + '\\d+END)', 'g'))) {
        const item = math.find(m => m.token === part);
        if (!item) fragment.append(document.createTextNode(part));
        else {
          const key = String(item.display) + ':' + item.expression;
          if (mathCache?.has(key)) fragment.append(mathCache.get(key).cloneNode(true));
          else {
            const span = document.createElement('span');
            window.katex.render(item.expression, span, { displayMode: item.display, throwOnError: false, trust: false, maxExpand: 1000, maxSize: 15, strict: 'ignore' });
            if (mathCache) { if (mathCache.size >= 256) mathCache.delete(mathCache.keys().next().value); mathCache.set(key, span.cloneNode(true)); }
            fragment.append(span);
          }
        }
      }
      node.replaceWith(fragment);
    }
  }
  return template.content;
}
function findQuestion(id){return state.messages.find(m=>m.role==='user'&&m.id===id);}
function jumpToMessage(id) {
  const element=document.getElementById('chat-'+id);if(!element)return toast('这条记录暂不可用。');
  const box=$('messages');box.scrollTo({top:box.scrollTop+element.getBoundingClientRect().top-box.getBoundingClientRect().top-12,behavior:'instant'});
  box.querySelectorAll('.message-target').forEach(n=>n.classList.remove('message-target'));void element.offsetWidth;element.classList.add('message-target');element.focus({preventScroll:true});
}
function clearReply(){replyTarget=null;$('replyPreview').hidden=true;}
function updateQuestionNav() {
  const questions=state.messages.filter(m=>m.role==='user');$('questionNav').hidden=!questions.length;
  $('questionJump').replaceChildren(new Option('定位问题…',''),...questions.map(q=>new Option(`#${q.number}${q.page?' · 第'+q.page+'页':''} · ${q.text.slice(0,32)}`,q.id)));
}
function startReply(message) {
  const question=findQuestion(message.rootId)||findQuestion(message.questionId);if(!question)return;
  replyTarget={rootId:question.id,answerId:message.id};
  $('replyPreview').hidden=false;$('replyPreviewText').textContent=`追问 #${question.number}${question.page?' · 第 '+question.page+' 页':''}：${question.text.slice(0,65)}`;
  $('question').focus();
}
function action(text,fn,className='message-link') {const button=document.createElement('button');button.type='button';button.className=className;button.textContent=text;button.onclick=fn;return button;}
function renderMessage(message) {
  const mathCache = new Map();
  let refreshFrame = null;
  const element = document.createElement('article'); element.className = 'message ' + message.role;
  message.id ||= messageId();element.id='chat-'+message.id;element.tabIndex=-1;
  const label = document.createElement('div'); label.className = 'message-label'; label.textContent = message.role === 'user' ? '你' : '✳ Codex';
  const question=message.role==='user'?message:findQuestion(message.questionId);
  if(question)label.append(action(message.role==='user'?`#${question.number}`:`↩ 提问 #${question.number}`,()=>jumpToMessage(question.id),'question-marker'));
  if (message.context) { const tag = document.createElement('span'); tag.className = 'context-tag'; tag.textContent = message.context; label.append(tag); }
  const body = document.createElement('div'); body.className = 'message-body';
  element.append(label, body);
  const links=document.createElement('div');links.className='message-links';
  if(message.page)links.append(action(`第 ${message.page} 页 ↗`,()=>void navigate(message.page)));
  const root=findQuestion(message.rootId);
  if(root && root.id!==question?.id)links.append(action(`↩ 回到主问题 #${root.number}`,()=>jumpToMessage(root.id)));
  if(message.role==='user')links.append(action('查看回答 ↓',()=>{const answer=state.messages.find(m=>m.role==='assistant'&&m.questionId===message.id);if(answer)jumpToMessage(answer.id);}));
  if(message.role==='assistant'&&question)links.append(action('追问这段',()=>startReply(message)));
  if(links.childElementCount)element.append(links);
  if(message.attachments?.length){const gallery=document.createElement('div');gallery.className='sent-images';for(const file of message.attachments){const img=document.createElement('img');img.src=file.thumbnail;img.alt=file.name;gallery.append(img);}element.append(gallery);}
  const refresh = () => {
    if (refreshFrame !== null) { cancelAnimationFrame(refreshFrame); refreshFrame = null; }
    body.replaceChildren();
    if (message.role === 'assistant') {
      if (!message.text && !message.error) { const wait = document.createElement('span'); wait.className = 'thinking'; wait.textContent = state.busy ? '正在阅读与思考…' : '未收到回答内容。'; body.append(wait); }
      else body.append(safeMarkdown(message.text, mathCache));
    } else body.textContent = message.text;
    element.querySelector('.error-text')?.remove();
    if (message.error) { const error = document.createElement('div'); error.className = 'error-text'; error.textContent = message.error; element.append(error); }
  };
  refresh();
  if (message.role === 'assistant') {
    const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'copy-message'; copy.textContent = '复制回答';
    copy.onclick = () => navigator.clipboard.writeText(message.text).then(() => toast('已复制回答。')).catch(() => toast('复制失败，可以选中文字后手动复制。'));
    element.append(copy);
  }
  const schedule = () => { if (refreshFrame === null) refreshFrame = requestAnimationFrame(() => { refreshFrame = null; refresh(); }); };
  $('messages').append(element); return { element, refresh, schedule };
}
function showMessages() {
  normalizeConversation(state.messages);
  $('messages').querySelectorAll('.message').forEach(n => n.remove());
  $('chatWelcome').hidden = !!state.messages.length;
  for (const m of state.messages) renderMessage(m);
  const lastQuestion=state.messages.filter(m=>m.role==='user').at(-1);
  activeRootId=lastQuestion?.rootId || null;activeQuestionPage=lastQuestion?.page;activeQuestionView=navigationSerial;clearReply();updateQuestionNav();
  $('messages').scrollTop = $('messages').scrollHeight;
}
function fileDigest(file, signal) {
  return new Promise((resolve, reject) => {
    const worker = new Worker('/document-worker.js');
    const cleanup = () => { worker.terminate(); signal.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); reject(new DOMException('文档已切换', 'AbortError')); };
    worker.onmessage = ({ data }) => { cleanup(); if (data.error) reject(new Error(data.error)); else resolve(data.key); };
    worker.onerror = event => { cleanup(); reject(new Error(event.message || '文件指纹计算失败。')); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) return abort();
    worker.postMessage({ file });
  });
}
const idleTurn = () => new Promise(resolve => {
  if ('requestIdleCallback' in window) requestIdleCallback(resolve, { timeout: 150 }); else setTimeout(resolve, 0);
});
function waitForPreparation(promise) {
  const signal = state.controller?.signal;
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException('已停止等待', 'AbortError'));
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
async function prepareMetadata(file, version, controller) {
  const key = await fileDigest(file, controller.signal);
  if (version !== state.openVersion) return;
  const messages = await savedMessages(key);
  if (version !== state.openVersion) return;
  state.key = key; state.messages = messages; showMessages(); updateControls();
}

async function submitPreload(body, signal) {
  const response = await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal});
  if(!response.ok){const error=new Error((await response.json()).error || '后台提交失败');error.retryable=response.status===409;throw error;}
  let completed = false;
  await consumeEvents(response,(event,data)=>{
    if(event==='failure')throw new Error(data.message || '后台提交失败');
    if(event==='done') {if(data.status!=='completed')throw new DOMException('已暂停提交','AbortError');completed=true;}
  });
  if(!completed)throw new Error('Codex 尚未确认接收');
}
async function startDocumentUpload(version) {
  if(state.restarting)return;
  if(!state.connected || !state.loggedIn)return;
  try {
    await Promise.all([state.metadataPromise,state.indexPromise]);
    if(version!==state.openVersion || documentUpload || !state.key)return;
    const model=state.models?.find(m=>m.id===$('model').value)||state.models?.find(m=>m.isDefault)||state.models?.[0];
    const efforts=model?.efforts || ['low'];
    const effort=['none','minimal','low','medium'].find(e=>efforts.includes(e)) || efforts[0];
    const key=state.key;
    const upload = documentUpload = new DocumentUpload({key,fileName:state.file.name,count:state.count,pages:state.pages,model:$('model').value,effort,
      cache:async(body,signal)=>{const response=await fetch('/api/document/context',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal});if(!response.ok)throw new Error((await response.json()).error||'本机全文缓存失败。');},
      submit:submitPreload,status:()=>api('document/status?key='+key),renderPage:async page=>{await idleTurn();if(version!==state.openVersion)throw new DOMException('文件已切换','AbortError');return renderPageImage(page);},
      onStatus:text=>{if(version===state.openVersion)$('documentUploadStatus').textContent=text;}});
    if(state.busy || state.waitingToAsk)upload.pause();
    void upload.run();
  } catch(e) {if(version===state.openVersion)$('documentUploadStatus').textContent='后台提交尚未开始：'+e.message;}
}

const DML = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
function parseXML(text) { const doc = new DOMParser().parseFromString(text, 'application/xml'); if (doc.querySelector('parsererror')) throw new Error('PPTX 文件结构有误，无法读取。'); return doc; }
async function readPptx(file) {
  const zip = await window.JSZip.loadAsync(await file.arrayBuffer());
  let total = 0; for (const entry of Object.values(zip.files)) total += entry._data?.uncompressedSize || 0;
  if (total > 300 * 1024 * 1024) throw new Error('PPTX 解压后过大，请先另存为 PDF。');
  const presentationEntry = zip.file('ppt/presentation.xml'); const relationshipsEntry = zip.file('ppt/_rels/presentation.xml.rels');
  if (!presentationEntry || !relationshipsEntry) throw new Error('这不是有效的 PPTX 文件。');
  const presentation = parseXML(await presentationEntry.async('string'));
  const rels = parseXML(await relationshipsEntry.async('string'));
  const map = new Map([...rels.getElementsByTagName('Relationship')].filter(e => e.getAttribute('TargetMode') !== 'External').map(e => [e.getAttribute('Id'), e.getAttribute('Target')]));
  const slides = [];
  for (const id of [...presentation.getElementsByTagNameNS('*', 'sldId')]) {
    const target = map.get(id.getAttributeNS(REL, 'id')); if (!target) continue;
    const url = new URL(target, 'https://pptx.local/ppt/presentation.xml');
    const entry = zip.file(url.pathname.slice(1)); if (!entry) throw new Error('PPTX 中的页面内容缺失。');
    if ((entry._data?.uncompressedSize || 0) > 8 * 1024 * 1024) throw new Error('PPTX 单页过大，请先另存为 PDF。');
    const xml = parseXML(await entry.async('string'));
    const paragraphs = [...xml.getElementsByTagNameNS(DML, 'p')].map(p => [...p.getElementsByTagNameNS(DML, 't')].map(t => t.textContent).join('')).filter(t => t.trim());
    paragraphs.pictures = [];
    const slash = entry.name.lastIndexOf('/');
    const relsEntry = zip.file(entry.name.slice(0, slash + 1) + '_rels/' + entry.name.slice(slash + 1) + '.rels');
    if (relsEntry) {
      const relationships = parseXML(await relsEntry.async('string'));
      const images = new Map([...relationships.getElementsByTagName('Relationship')].filter(r => r.getAttribute('TargetMode') !== 'External').map(r => [r.getAttribute('Id'), r.getAttribute('Target')]));
      const seen = new Set();
      for (const blip of xml.getElementsByTagNameNS(DML, 'blip')) {
        const target = images.get(blip.getAttributeNS(REL, 'embed')); if (!target) continue;
        const imagePath = decodeURIComponent(new URL(target, 'https://pptx.local/' + entry.name).pathname.slice(1));
        const imageEntry = zip.file(imagePath);
        const ext = imagePath.split('.').at(-1).toLowerCase();
        const mime = { png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', gif:'image/gif', webp:'image/webp', bmp:'image/bmp', svg:'image/svg+xml' }[ext];
        if (!imageEntry || !mime || seen.has(imagePath)) continue;
        if ((imageEntry._data?.uncompressedSize || 0) > 32 * 1024 * 1024) continue;
        seen.add(imagePath); paragraphs.pictures.push({ entry: imageEntry, mime, url: null });
      }
    }
    slides.push(paragraphs);
  }
  if (!slides.length) throw new Error('PPTX 中没有可读取的页面。');
  return slides;
}
function loadPdf(data) {
  const task = pdfjs.getDocument({ data, cMapUrl: '/vendor/pdfjs-dist/cmaps/', cMapPacked: true, standardFontDataUrl: '/vendor/pdfjs-dist/standard_fonts/', wasmUrl: '/vendor/pdfjs-dist/wasm/', isEvalSupported: false });
  task.onPassword = (update, reason) => { const password = prompt(reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD ? '密码不正确，请重新输入 PDF 密码：' : '请输入 PDF 密码：'); if (password === null) void task.destroy(); else update(password); };
  return task.promise;
}
async function convertPpt(file, ext, signal) {
  const converted = await fetch('/api/convert?ext=' + ext, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file, signal });
  if (!converted.ok) { const error = await converted.json(); throw new Error(error.error); }
  return loadPdf(new Uint8Array(await converted.arrayBuffer()));
}
async function openPresentation(file) {
  const response = await fetch('/api/presentation/open?ext=pptx',{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:file});
  if (!response.ok) { const result = await response.json(); throw new Error(result.error || '课件原版打开失败。'); }
  const info = await response.json(); info.images = new Map(); return info;
}
function originalPageImage(page, presentation = state.presentation) {
  if (!presentation) return Promise.reject(new Error('课件尚未打开。'));
  if (presentation.images.has(page)) return presentation.images.get(page);
  const loading = new Promise((resolve,reject)=>{
    const image = new Image(); image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => { presentation.images.delete(page); reject(new Error(`第 ${page} 页原版渲染失败，请重试。`)); };
    image.src = `/api/presentation/${presentation.id}/page/${page}`;
  });
  presentation.images.set(page,loading);
  // Keep nearby decoded images in memory; every rendered page remains cached locally.
  if (presentation.images.size > 8) presentation.images.delete(presentation.images.keys().next().value);
  return loading;
}
async function prepareOriginal(file, version, controller) {
  state.analysisPending = true;
  $('originalPreview').hidden = false; $('originalPreview').textContent = '原版准备中…';
  $('originalPreview').title = '可先阅读文字与图片，原始排版在本机后台转换'; updateControls();
  try {
    const pdf = await convertPpt(file, 'pptx', controller.signal);
    if (version !== state.openVersion) { await pdf.destroy(); return null; }
    state.analysisPdf = pdf;
    $('originalPreview').textContent = '查看原版'; $('originalPreview').title = '原始排版已就绪，点击切换；不会自动打断当前阅读';
    return pdf;
  } catch(e) {
    if (version === state.openVersion && e.name !== 'AbortError') {
      $('originalPreview').textContent = '原版转换不可用';
      $('originalPreview').title = '文字与图片仍可阅读；原版排版需要 PowerPoint / LibreOffice，也可先另存为 PDF。';
      $('includeImage').checked = false;
    }
    return null;
  } finally { if (version === state.openVersion) { state.analysisPending = false; updateControls(); } }
}
async function populateSlidePictures(article, pictures, renderVersion) {
  const openVersion = state.openVersion;
  const gallery = document.createElement('div'); gallery.className = 'slide-pictures'; article.append(gallery);
  for (const picture of pictures || []) {
    try {
      if (!picture.url) {
        const bytes = await picture.entry.async('uint8array');
        if (openVersion !== state.openVersion) return;
        picture.url = URL.createObjectURL(new Blob([bytes], { type: picture.mime })); state.previewUrls.add(picture.url);
      }
      if (renderVersion !== state.renderVersion || openVersion !== state.openVersion) return;
      const image = document.createElement('img'); image.src = picture.url; image.alt = '本页图片'; image.className = 'slide-picture';
      image.decoding = 'async'; gallery.append(image);
    } catch { if (renderVersion === state.renderVersion) gallery.append(document.createTextNode('部分图片暂无法预览，请切换原版查看。')); }
  }
}
async function ensureAnalysisImages() {
  if (state.pdf || state.presentation || state.analysisPdf) return;
  if (state.analysisPending) {
    $('generationStatus').textContent = '正在等待原版页面供图片分析，仍可继续阅读和翻页…';
    await waitForPreparation(state.analysisPromise);
  }
  if (!state.pdf && !state.analysisPdf) throw new Error('原版转换未成功，当前可使用文字问答；图表问题请另存为 PDF 后分析。');
}

async function openFile(file) {
  if (!file || state.busy || state.rendering || state.waitingToAsk) return;
  if (!/\.(pdf|pptx?|html?)$/i.test(file.name)) return toast('请选择 PDF、PPT、PPTX 或 HTML 文件。');
  if (file.size > 100 * 1024 * 1024) return toast('文件超过 100 MB，请拆分后打开。');
  readerMemory.flushPosition();
  const version = ++state.openVersion;
  attachments=[];showAttachments();clearReply();activeRootId=null;
  documentUpload?.cancel(); documentUpload = null;
  $('documentUploadStatus').textContent = '本地打开后，自动后台提交给 Codex';
  state.prepareController?.abort();
  for (const url of state.previewUrls) URL.revokeObjectURL(url);
  state.previewUrls.clear();
  $('readerStatus').textContent = '正在打开文档…'; $('emptyReader').hidden = true; $('pageStage').hidden = true;
  state.rendering = true; updateControls();
  try {
    let pdf = null, slides = null, presentation = null, html = null;
    const ext = file.name.split('.').at(-1).toLowerCase();
    let data;
    if (ext === 'html'||ext === 'htm') html=await readHtml(file);
    else if (ext === 'pdf') data = new Uint8Array(await file.arrayBuffer());
    else if (ext === 'pptx') {
      $('readerStatus').textContent = '正在用本机 WPS / PowerPoint 打开原版第一页…';
      try{presentation=await openPresentation(file);}
      catch {
        $('readerStatus').textContent = '按页原版渲染不可用，正在尝试本地 PDF 转换…';
        try { pdf = await convertPpt(file,'pptx'); slides = null; }
        catch { throw new Error('无法打开课件原版。请检查 WPS / PowerPoint，或在 WPS 中另存为 PDF 后打开。'); }
      }
    } else {
      $('readerStatus').textContent = '正在尝试将 PowerPoint 转换为 PDF…';
      try {
        const converted = await fetch('/api/convert?ext=' + ext, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
        if (!converted.ok) { const error = await converted.json(); throw new Error(error.error); }
        data = new Uint8Array(await converted.arrayBuffer());
      } catch(e) {
        if (ext === 'ppt') throw new Error('旧版 PPT 需要本机安装 PowerPoint 或 LibreOffice。也可以先另存为 PDF 后打开。');
        slides = await readPptx(file); toast('当前使用 PPTX 文字模式，保留文字与页序；图表、公式和原始版式请另存为 PDF 后查看。');
      }
    }
    if (data) pdf = await loadPdf(data);
    if (version !== state.openVersion) { await pdf?.destroy(); if(presentation) void api('presentation/close',{id:presentation.id}).catch(()=>{}); return; }
    continuousReader?.close();continuousReader=null;
    state.renderTask?.cancel(); state.textLayer?.cancel();
    for (const old of new Set([state.pdf, state.analysisPdf])) await old?.destroy();
    if (state.presentation) void api('presentation/close',{id:state.presentation.id}).catch(()=>{});
    Object.assign(state, { file, key: null, pdf, slides, presentation,html,slidesPromise:null, analysisPdf: null, analysisPending: false, analysisPromise: null, page: 1, count: html?1:pdf ? pdf.numPages : presentation.count, zoom: null, textCache: new Map(), pages: null, task: null, messages: [], metadataPromise: null, indexPromise: null });
    $('originalPreview').hidden = true;
    $('taskProgress').hidden = true;
    clearSelection(); $('scope').value = 'document'; showMessages();
    $('fileTitle').textContent = file.name; $('fileTitle').title = file.readerEntry?.path||file.name;
    $('documentType').textContent = html?'HTML · 连续网页':pdf ? (ext === 'pdf' ? 'PDF 文档' : 'PowerPoint · PDF 预览') : `PPTX · ${presentation.engine} 原版`;
    $('pageTotal').textContent = '/ ' + state.count; $('pageNumber').max = state.count;
    $('pageList').replaceChildren();
    // Avoid thousands of buttons for exceptionally large files; page-number input remains available.
    if (state.count <= 500) for (let i = 1; i <= state.count; i++) { const b = document.createElement('button'); b.textContent = i; b.title = `第 ${i} 页`; b.onclick = () => navigate(i); $('pageList').append(b); }
    else { const label = document.createElement('span'); label.textContent = '请使用上方页码跳转'; label.style.fontSize = '11px'; $('pageList').append(label); }
    $('pageStage').hidden = false; await renderPage();
    if(file.readerEntry){const savedPage=Math.min(state.count,Math.max(1,file.readerEntry.page||1));if(savedPage>1)await navigate(savedPage);void readerMemory.opened(file);}
    if(html?.missing)toast('该 HTML 引用了旁边的资源文件，部分图片或样式可能缺失；本版支持单文件 HTML。');
    // The first page is usable before hashing, history retrieval, or full-text indexing.
    if(presentation)state.slidesPromise=idleTurn().then(()=>readPptx(file)).then(value=>{if(version===state.openVersion)state.slides=value;return value;});
    const controller = state.prepareController = new AbortController();
    state.metadataPromise = prepareMetadata(file, version, controller);
    void state.metadataPromise.catch(e => { if (version === state.openVersion && e.name !== 'AbortError') toast('文档可正常阅读，但对话准备失败：' + e.message); });
    state.indexPromise = indexWholeDocument();
    // A handled background promise keeps failed/cancelled imports from becoming unhandled rejections.
    void state.indexPromise.catch(() => {});
    void startDocumentUpload(version);
  } catch(e) {
    if (version === state.openVersion) { toast('打开失败：' + e.message); $('readerStatus').textContent = '打开失败，请重新选择文件'; if (state.file) $('pageStage').hidden = false; else $('emptyReader').hidden = false; }
  } finally { if (version === state.openVersion) { state.rendering = false; updateControls(); } $('fileInput').value = ''; }
}

async function pageText(index) {
  if(state.html)return state.html.pages?.[index-1]||'';
  if (state.textCache.has(index)) return state.textCache.get(index);
  let text; const version = state.openVersion, pdf = state.pdf;
  if (pdf) { const page = await pdf.getPage(index); const content = await page.getTextContent(); text = content.items.map(item => item.str + (item.hasEOL ? '\n' : ' ')).join('').trim(); }
  else {const slides=state.slides||await state.slidesPromise;text=(slides?.[index-1]||[]).join('\n');}
  if (version === state.openVersion) state.textCache.set(index, text); return text;
}
async function indexWholeDocument() {
  if(state.html){const pages=state.pages=state.html.pages;pages.forEach((text,i)=>state.textCache.set(i+1,text));$('documentIndexStatus').textContent=`全文已读取 · ${pages.length} 段（HTML 按正文分段定位）`;updateControls();return pages;}
  const version = state.openVersion, pages = [];
  try {
    for (let index = 1; index <= state.count; index++) {
      await idleTurn();
      while (state.rendering && version === state.openVersion) await new Promise(resolve => setTimeout(resolve, 16));
      if (version !== state.openVersion) throw new Error('文档已切换。');
      $('documentIndexStatus').textContent = `读取全文 ${index}/${state.count} 页`;
      pages.push(await pageText(index));
    }
    const scans=pages.flatMap((text,index)=>text.trim().length<24?[index+1]:[]);
    let missed=0;
    if(scans.length){
      await state.metadataPromise;
      let engine;try{engine=await api('document/ocr?key='+state.key);}catch{}
      if(engine?.available){
        for(let index=0;index<scans.length;index++){
          const page=scans[index];if(version!==state.openVersion)throw new Error('文档已切换。');
          await idleTurn();$('documentIndexStatus').textContent=`本机识别扫描页 ${index+1}/${scans.length} · 阅读不受影响`;
          try{
            let text=engine.pages?.[page];
            if(typeof text!=='string'){const image=await renderPageImage(page);if(version!==state.openVersion)throw new Error('文档已切换。');text=(await api('document/ocr',{key:state.key,page,image:image.data})).text;}
            if(text.trim()){pages[page-1]=[pages[page-1],`[本机文字识别，图表及公式需要时查看原图]\n${text}`].filter(Boolean).join('\n');state.textCache.set(page,pages[page-1]);}else missed++;
          }catch{missed++;}
        }
      }else missed=scans.length;
    }
    if (version !== state.openVersion) throw new Error('文档已切换。');
    state.pages = pages;
    $('documentIndexStatus').textContent = `全文已读取 · ${pages.length} 页`+(missed?` · ${missed} 页需按需查看原图`:'');
    updateControls(); return pages;
  } catch(e) { if (version === state.openVersion) $('documentIndexStatus').textContent = '全文读取失败：' + e.message; throw e; }
}
function syncReaderPage(number) {
  if(!number||!state.file)return;
  if(state.page!==number){state.page=number;navigationSerial++;clearSelection();}
  $('pageNumber').value=number;
  [...$('pageList').children].forEach((button,i)=>button.classList.toggle('active',i+1===number));
  $('readerStatus').textContent=state.file.name+' · 第 '+number+' / '+state.count+(state.html?' 段 · HTML 连续阅读':' 页 · '+($('readingMode').value==='single'?'单页阅读':'连续阅读'));
  readerMemory.position(state.file,number);
}
async function renderPage() {
  if(!state.file)return;
  const source=state.html||state.pdf||state.presentation;
  if(continuousReader?.source===source){continuousReader.zoom=state.zoom;continuousReader.layout();$('zoomFit').textContent=state.zoom?Math.round(state.zoom*100)+'%':'适合宽度';return;}
  continuousReader?.close();state.rendering=true;updateControls();
  if(state.html){
    const view=continuousReader=new HtmlReader({stage:$('pageStage'),scroll:$('documentScroll'),onPage:syncReaderPage,
      onSelection:(text,page)=>{if(Number.isInteger(page)&&page>=1&&page<=state.count)syncReaderPage(page);state.selected=text;$('scope').value='selection';$('selectionPreview').hidden=false;$('selectionPreview').querySelector('p').textContent=text;$('selectionIndicator').textContent=`已选中 ${text.length} 字`;updateControls();},
      onZoom:({delta,mode,x,y})=>{const pixels=delta*(mode===1?16:mode===2?500:1);state.zoom=Math.max(.25,Math.min(4,(state.zoom||1)*Math.exp(-Math.max(-250,Math.min(250,pixels))*.0012)));const rect=view.frame.getBoundingClientRect();view.zoomAt(state.zoom,rect.left+x,rect.top+y);$('zoomFit').textContent=Math.round(state.zoom*100)+'%';},
      onLink:url=>window.open(url,'_blank','noopener,noreferrer')});
    try{await view.open(source);if(continuousReader!==view)return;state.count=source.pages.length;$('pageTotal').textContent='/ '+state.count+' 段';$('pageNumber').max=state.count;$('pageNumber').setAttribute('aria-label','当前正文段');$('pageList').replaceChildren();
      for(let i=1;i<=Math.min(500,state.count);i++){const button=document.createElement('button');button.textContent=i;button.title=source.labels?.[i-1]||`第 ${i} 段`;button.onclick=()=>navigate(i);$('pageList').append(button);}syncReaderPage(1);$('zoomFit').textContent='适合宽度';
    }finally{if(continuousReader===view){state.rendering=false;updateControls();}}return;
  }
  $('pageNumber').setAttribute('aria-label','当前页码');
  const view=continuousReader=new ContinuousReader({stage:$('pageStage'),scroll:$('documentScroll'),pdfjs,onPage:syncReaderPage,onError:error=>toast('页面显示失败：'+error.message)});
  view.source=source;
  try{await view.open({pdf:state.pdf,presentation:state.presentation,count:state.count,getImage:page=>originalPageImage(page),zoom:state.zoom,mode:$('readingMode').value});
    if(continuousReader===view){syncReaderPage(state.page);$('zoomFit').textContent='适合宽度';}
  }finally{if(continuousReader===view){state.rendering=false;updateControls();}}
}
async function navigate(number) {
  if(!state.count||!continuousReader)return;
  number=Math.max(1,Math.min(state.count,Number.parseInt(number,10)||state.page));
  await continuousReader.navigate(number);
}
function snapshotPage() {
  const source = $('pdfCanvas'), canvas = document.createElement('canvas');
  const scale = Math.min(1, 1400 / source.width, 2000 / source.height);
  canvas.width = Math.max(1, Math.round(source.width * scale)); canvas.height = Math.max(1, Math.round(source.height * scale));
  const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png');
}
function encodedPng(canvas) {
  let result=canvas.toDataURL('image/png');
  for(let attempt=0;result.length>7600000&&attempt<5;attempt++) {
    const smaller=document.createElement('canvas');smaller.width=Math.max(1,Math.round(canvas.width*.8));smaller.height=Math.max(1,Math.round(canvas.height*.8));smaller.getContext('2d').drawImage(canvas,0,0,smaller.width,smaller.height);canvas=smaller;result=canvas.toDataURL('image/png');
  }
  if(result.length>8000000)throw new Error('图片较大，请裁剪后重试。');return result;
}
function showAttachments() {
  $('attachmentPreview').replaceChildren();
  attachments.forEach((file,index)=>{const item=document.createElement('div');item.className='attachment-item';const img=document.createElement('img');img.src=file.thumbnail;img.alt=file.name;item.append(img,action('×',()=>{attachments.splice(index,1);showAttachments();},'remove-image'));$('attachmentPreview').append(item);});
  $('attachmentPreview').hidden=!attachments.length;
}
async function addImages(files) {
  if(state.busy||state.waitingToAsk)return;
  const version=state.openVersion;
  for(const file of files) {
    if(attachments.length>=3){toast('一次最多补充3张图片。');break;}
    if(!/^image\/(png|jpeg|webp|gif|bmp)$/.test(file.type)){toast('请选择 PNG、JPG 或 WebP 图片。');continue;}
    if(file.size>20*1024*1024){toast('单张图片请控制在20 MB以内。');continue;}
    try {
      const image=await createImageBitmap(file);if(version!==state.openVersion){image.close();return;}const canvas=document.createElement('canvas');const scale=Math.min(1,1600/image.width,2200/image.height);
      canvas.width=Math.max(1,Math.round(image.width*scale));canvas.height=Math.max(1,Math.round(image.height*scale));const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(image,0,0,canvas.width,canvas.height);image.close();
      const data=encodedPng(canvas),thumb=document.createElement('canvas'),thumbScale=Math.min(100/canvas.width,100/canvas.height);thumb.width=Math.max(1,Math.round(canvas.width*thumbScale));thumb.height=Math.max(1,Math.round(canvas.height*thumbScale));thumb.getContext('2d').drawImage(canvas,0,0,thumb.width,thumb.height);
      attachments.push({name:(file.name||'粘贴图片.png').slice(0,200),data,thumbnail:thumb.toDataURL('image/png')});showAttachments();
    }catch{toast('图片读取失败，请换一张图片重试。');}
  }
}
async function renderPageImage(index, source = state.pdf || state.analysisPdf) {
  if(state.html)throw new Error('HTML 已提供全文文字；网页图表请通过“＋ 图片”补充截图。');
  if (state.presentation && !source) {
    const image = await originalPageImage(index);
    const scale = Math.min(1,1400/image.naturalWidth,2000/image.naturalHeight);
    const canvas = document.createElement('canvas'); canvas.width = Math.round(image.naturalWidth*scale); canvas.height = Math.round(image.naturalHeight*scale);
    canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);
    const data = encodedPng(canvas); canvas.width = canvas.height = 0; return {page:index,data};
  }
  if (!source || index > source.numPages) throw new Error(`原版 PDF 没有对应的第 ${index} 页，请切换原版后重新选择范围。`);
  const page = await source.getPage(index);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(2.5, 1600 / base.width, 2200 / base.height);
  const viewport = page.getViewport({ scale }); const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  const data = encodedPng(canvas); canvas.width = canvas.height = 0; return { page: index, data };
}
async function gatherContext(question, requested) {
  const { scope } = requested;
  const body = { documentKey: state.key, fileName: state.file.name, documentPages:state.count, question, page: requested.page, scope, model: requested.model, effort: requested.effort };
  if (requested.image) body.image = requested.image;
  if(requested.attachments.length)body.attachments=requested.attachments.map(({name,data})=>({name,data}));
  if(requested.replyContext)body.replyContext=requested.replyContext;
  if (scope === 'selection') {
    if (!requested.selected) throw new Error('请先在文档中划选要提问的文字。'); body.text = requested.selected;
  } else if (scope === 'page'&&!requested.usePrepared) body.text = await pageText(body.page);
  else if (scope === 'document') {
    if(requested.usePrepared)return body;
    await state.indexPromise;
    const pages = []; let length = 0;
    for (let index = 1; index <= state.count; index++) {
      if (state.cancelled) throw new DOMException('已停止', 'AbortError');
      $('generationStatus').textContent = `正在提取全文 ${index} / ${state.count} 页…`;
      const text = `[第 ${index} 页]\n${await pageText(index)}`; length += text.length + 2;
      if (length > MAX_TEXT) throw new Error('全文超过 120000 字，请改为当前页或选中文字提问。');
      pages.push(text);
    }
    body.text = pages.join('\n\n');
  }
  if (body.text?.length > MAX_TEXT) throw new Error('附带文字过长，请缩小选取范围。');
  return body;
}

async function consumeEvents(response, onEvent) {
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done }).replace(/\r\n/g, '\n');
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
      const event = block.split('\n').find(l => l.startsWith('event: '))?.slice(7);
      const data = block.split('\n').filter(l => l.startsWith('data: ')).map(l => l.slice(6)).join('\n');
      if (event && data) onEvent(event, JSON.parse(data));
    }
    if (done) break;
  }
}
async function supplyRequestedPages(data) {
  try {
    $('generationStatus').textContent=`正在自动查看第 ${data.pages.join('、')} 页…`;
    const images=[];
    for(const page of data.pages){if(state.cancelled)throw new Error('问答已停止');images.push(await renderPageImage(page));}
    await api('document/pages',{id:data.id,images});
  } catch(e) {await api('document/pages',{id:data.id,error:'页面读取失败：'+e.message}).catch(()=>{});}
}
async function sendQuestion(question) {
  if(state.restarting)return;
  const inputDraft=$('question').value;
  question = question.trim();
  if(!question && attachments.length)question='请解释我补充的图片，说明其中的文字、图表或题目。';
  if (!question || state.busy || state.waitingToAsk) return;
  if (!state.file) return toast('先打开一份文档，再开始提问。');
  if (!state.connected || !state.loggedIn) return toast('请先连接并登录本机 Codex。');
  if (state.rendering) return toast('页面仍在加载，请稍候。');
  const references=referencedPages(question);
  if(references.some(p=>p<1||p>state.count))return toast(`文档共 ${state.count} 页，请检查提问中的页码。`);
  const explicitRoot=!references.length&&replyTarget?findQuestion(replyTarget.rootId):null;
  const previousRoot=findQuestion(activeRootId);
  const continuing=!references.length&&!/这一页|这页|当前页|本页/.test(question)&&previousRoot&&activeQuestionView===navigationSerial;
  const root=explicitRoot || (continuing?previousRoot:null);
  const replyAnswer=replyTarget?state.messages.find(m=>m.id===replyTarget.answerId):null;
  const requested = { scope: explicitRoot?'page':questionScope(question,$('scope').value), page:references.length===1?references[0]:explicitRoot?(replyAnswer?.page||explicitRoot.page||state.page):continuing?(activeQuestionPage||state.page):state.page, rootId:root?.id, attachments:attachments.slice(), selected: state.selected, model: $('model').value, effort: $('effort').value };
  if(explicitRoot){const answer=state.messages.find(m=>m.id===replyTarget.answerId);requested.replyContext={question:explicitRoot.text.slice(0,12000),answer:(answer?.text||'').slice(0,12000)};}
  $('scope').value = requested.scope;
  requested.includeImage = !!(state.pdf || state.presentation || state.analysisPdf || state.analysisPending) && ['page', 'document'].includes(requested.scope) && $('includeImage').checked;
  documentUpload?.pause();
  const preparationController = new AbortController(); state.cancelled = false;
  if (!state.key) {
    state.waitingToAsk = true; state.controller = preparationController; updateControls();
    $('generationStatus').textContent = '文档可继续阅读，正在准备对话所需的文件信息…';
    try { await waitForPreparation(state.metadataPromise); if (!state.key) throw new Error('文件信息尚未准备好，请稍后重试。'); }
    catch(e) { $('generationStatus').textContent = e.message; if (e.name !== 'AbortError') toast(e.message); documentUpload?.resume(); return; }
    finally { state.waitingToAsk = false; state.controller = null; updateControls(); }
  }
  if(requested.scope==='document'&&asksAllExercises(question))return runDocumentTask('exercises',question);
  if(requested.scope!=='none'){
    state.waitingToAsk=true;state.controller=preparationController;updateControls();
    $('generationStatus').textContent='正在准备本机全文上下文，阅读和翻页不受影响…';
    try{
      await waitForPreparation(state.indexPromise);
      await startDocumentUpload(state.openVersion);
      documentUpload?.pause();
      if(documentUpload?.localReady)await waitForPreparation(documentUpload.localReady);
      const context=await waitForPreparation(api('document/status?key='+state.key));
      requested.usePrepared=!!context.cached;
      if(!requested.usePrepared)throw new Error('本机全文尚未准备好，请稍后重试；仍可继续阅读。');
      if(requested.includeImage){await ensureAnalysisImages();requested.image=(await waitForPreparation(renderPageImage(requested.page))).data;}
      if(references.length===1&&state.page!==requested.page)await navigate(requested.page);
    }catch(e){$('generationStatus').textContent=e.message;if(e.name!=='AbortError')toast(e.message);documentUpload?.resume();return;}
    finally{state.waitingToAsk=false;state.controller=null;updateControls();}
  }
  $('taskProgress').hidden = true;
  state.busy = true; state.cancelled = false; state.controller = new AbortController(); updateControls();
  let assistant = null, view = null, completed = false, addedUser = false, sourceQuestion=null;
  let firstText=false;const waitingSince=Date.now();
  const waitingTimer=setInterval(()=>{if(!firstText && !state.cancelled)$('generationStatus').textContent=`正在等待 Codex 回复 · 已等待 ${Math.floor((Date.now()-waitingSince)/1000)} 秒`;},1000);
  const items = new Map();
  function currentItem(id) {
    if (items.has(id)) return items.get(id);
    if (!assistant) assistant = { role: 'assistant', text: '' };
    else if (items.size) assistant = { role: 'assistant', text: '' };
    Object.assign(assistant,{questionId:sourceQuestion?.id,rootId:sourceQuestion?.rootId,page:sourceQuestion?.page});
    if (!state.messages.includes(assistant)) state.messages.push(assistant);
    view = renderMessage(assistant); const value = { message: assistant, view }; items.set(id, value); return value;
  }
  try {
    const body = await gatherContext(question, requested);
    if (state.cancelled) throw new DOMException('已停止', 'AbortError');
    const scopeNames = { page: `第 ${body.page} 页`, selection: `第 ${body.page} 页 · 选中文字`, document: '全文文字', none: '不附带新内容' };
    const id=messageId();
    const user = sourceQuestion = { id,number:state.messages.filter(m=>m.role==='user').length+1,rootId:requested.rootId||id,page:body.page,role:'user',text:question,context:scopeNames[body.scope]+(body.image?' · 已附页面原图':'')+(body.attachments?.length?` · ${body.attachments.length}张补图`:'') };
    if(requested.attachments.length)user.attachments=requested.attachments.map(({name,thumbnail})=>({name,thumbnail}));
    $('chatWelcome').hidden = true; state.messages.push(user); renderMessage(user); addedUser = true;
    activeRootId=user.rootId;activeQuestionPage=user.page;activeQuestionView=navigationSerial;attachments=[];showAttachments();clearReply();updateQuestionNav();
    if($('question').value===inputDraft)$('question').value = '';
    $('generationStatus').textContent = '正在把问题发送给 Codex…';
    $('messages').scrollTop = $('messages').scrollHeight;
    const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: state.controller.signal });
    if (!response.ok) { const e = await response.json(); throw new Error(e.error || 'Codex 请求失败。'); }
    await consumeEvents(response, (event, data) => {
      const nearBottom = $('messages').scrollHeight - $('messages').scrollTop - $('messages').clientHeight < 120;
      if (event === 'status') $('generationStatus').textContent = data.message;
      if (event === 'readPages') void supplyRequestedPages(data);
      if (event === 'delta') { firstText=true;const item = currentItem(data.itemId || 'reply'); item.message.text += data.delta; item.view.schedule(); $('generationStatus').textContent = 'Codex 正在回答…'; }
      if (event === 'message') { firstText=true;const item = currentItem(data.itemId || 'reply'); item.message.text = data.text || item.message.text; item.view.refresh(); }
      if (event === 'failure') { completed = true; throw new Error(data.message || 'Codex 生成失败。'); }
      if (event === 'done') { completed = true; if (data.status === 'interrupted') $('generationStatus').textContent = '已停止生成'; else $('generationStatus').textContent = '回答完成'; }
      if (nearBottom) $('messages').scrollTop = $('messages').scrollHeight;
    });
    if (!completed) throw new Error('与 Codex 的连接中断，请重试。');
    if (!items.size) throw new Error('没有收到回答内容。请检查 Codex 登录、模型和额度后重试。');
  } catch(e) {
    const cancelled = e.name === 'AbortError' || state.cancelled;
    const message = cancelled ? '已停止生成。' : e.message;
    $('generationStatus').textContent = message;
    if (addedUser) {
      if (!assistant) { assistant = { role: 'assistant', text: '', error: message,questionId:sourceQuestion?.id,rootId:sourceQuestion?.rootId,page:sourceQuestion?.page }; state.messages.push(assistant); view = renderMessage(assistant); }
      else { assistant.error = message; view?.refresh(); }
    } else toast(message);
    if (!cancelled) { $('question').value ||= question;if(!attachments.length)attachments=requested.attachments;showAttachments();toast(message); }
  } finally {
    clearInterval(waitingTimer);
    state.busy = false; state.controller = null;
    for (const item of items.values()) item.view.refresh();
    view?.refresh(); await persist(); updateControls();
    documentUpload?.resume();
  }
}

async function streamTaskMessage(body, context) {
  body.documentPages=state.count;
  const question=state.messages.filter(m=>m.role==='user').at(-1);
  const message = { role: 'assistant', text: '', context,questionId:question?.id,rootId:question?.rootId,page:body.page }; state.messages.push(message);
  const view = renderMessage(message); let done = false;
  state.controller = new AbortController();
  try {
    const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: state.controller.signal });
    if (!response.ok) throw new Error((await response.json()).error || 'Codex 请求失败。');
    const items = new Map();
    await consumeEvents(response, (event, data) => {
      const nearBottom = $('messages').scrollHeight - $('messages').scrollTop - $('messages').clientHeight < 120;
      if(event==='readPages')void supplyRequestedPages(data);
      if (event === 'delta') { const id = data.itemId || 'reply'; items.set(id, (items.get(id) || '') + data.delta); message.text = [...items.values()].join('\n\n'); view.schedule(); }
      if (event === 'message') { items.set(data.itemId || 'reply', data.text || ''); message.text = [...items.values()].join('\n\n'); view.refresh(); }
      if (event === 'failure') throw new Error(data.message || '这一批生成失败。');
      if (event === 'done') { done = true; if (data.status === 'interrupted') throw new DOMException('已停止', 'AbortError'); }
      if (nearBottom) $('messages').scrollTop = $('messages').scrollHeight;
    });
    if (!done || !message.text.trim()) throw new Error('本批未收到完整回答，请点击继续重试。');
    await persist(); return message.text;
  } catch(e) { message.text ||= '（本批尚未生成完整内容）'; message.error = state.cancelled ? '已停止，本批尚未完成；继续时会重新处理本批。' : e.message; view.refresh(); await persist(); throw e; }
}

async function runDocumentTask(kind, question, { textOnly = false } = {}) {
  if (!state.file || state.busy || state.waitingToAsk || !state.connected || !state.loggedIn) return;
  state.busy = true; state.cancelled = false; state.controller = new AbortController(); updateControls();
  documentUpload?.pause();
  let attachImages = !textOnly && !!(state.pdf || state.presentation || state.analysisPdf || state.analysisPending) && $('includeImage').checked;
  try {
    $('generationStatus').textContent = '正在准备整份文档，阅读和翻页不受影响…';
    await waitForPreparation(state.metadataPromise);
    if (state.cancelled) throw new DOMException('已停止', 'AbortError');
    if (!state.key) throw new Error('文档信息尚未准备好。');
    if (attachImages) await ensureAnalysisImages();
    const pages = await waitForPreparation(state.indexPromise);
    if (!pages?.length) throw new Error('文档尚未读取完成。');
    if(!state.html && !textOnly && !attachImages && pages.every(p=>p.trim().length<24)){attachImages=true;await ensureAnalysisImages();}
    if (!state.task || state.task.kind !== kind || state.task.question !== question || state.task.next >= state.task.batches.length) {
      const batches = planBatches(pages, { maxPages: attachImages ? 3 : (kind === 'exercises' ? 6 : 24), maxChars: kind === 'exercises' ? 24000 : 65000, overlap: kind === 'exercises' });
      state.task = { kind, question, batches, next: 0, results: [], attachImages, model: $('model').value, effort: $('effort').value };
      $('chatWelcome').hidden = true;
      const id=messageId();
      const user = { id,rootId:id,number:state.messages.filter(m=>m.role==='user').length+1,role: 'user', text: question, context: `整份文档 · ${state.count} 页 · 自动处理 ${batches.length} 批${attachImages ? ' · 含全部页图片' : ' · 文字模式'}` };
      state.messages.push(user); renderMessage(user); $('question').value = '';
      activeRootId=id;activeQuestionPage=null;activeQuestionView=navigationSerial;clearReply();updateQuestionNav();
    }
    const task = state.task;
    task.effort = $('effort').value;
    $('taskProgress').hidden = false;
    $('taskProgressBar').max = task.batches.length;
    $('taskProgressBar').value = task.next;
    for (; task.next < task.batches.length; task.next++) {
      if (state.cancelled) throw new DOMException('已停止', 'AbortError');
      const batch = task.batches[task.next];
      const progress = `${kind === 'exercises' ? '解答习题' : '研读全文'} ${task.next + 1}/${task.batches.length} 批 · 第 ${batch.start}—${batch.end} 页`;
      $('taskProgressText').textContent = progress;
      $('generationStatus').textContent = progress;
      const parts = [], images = [];
      for (let index = batch.readStart; index <= batch.readEnd; index++) {
        if (state.cancelled) throw new DOMException('已停止', 'AbortError');
        parts.push(`[第 ${index} 页]\n${pages[index - 1]}`);
        if (task.attachImages) { $('generationStatus').textContent = progress + ` · 准备第 ${index} 页图片`; images.push(await renderPageImage(index)); }
      }
      const text = parts.join('\n\n');
      if (text.length > MAX_TEXT) throw new Error(`第 ${batch.start}—${batch.end} 页文字过多，请拆分文档后处理。`);
      $('generationStatus').textContent = progress + ' · Codex 正在处理…';
      const answer = await streamTaskMessage({ documentKey: state.key, fileName: state.file.name, question: kind === 'exercises' ? exercisePrompt(question, batch, state.count) : reviewPrompt(question, batch, state.count), page: batch.start, scope: 'document', text, images, model: task.model, effort: task.effort, isolated: true }, `${kind === 'exercises' ? '习题解答' : '全文研读'} · 第 ${batch.start}—${batch.end} 页`);
      task.results.push({ batch, answer });
      $('taskProgressBar').value = task.next + 1;
    }
    if (kind === 'review') {
      let notes = task.results.map(r => `[第 ${r.batch.start}—${r.batch.end} 页研读结果]\n${r.answer}`).join('\n\n');
      // Hierarchically condense only when the evidence itself exceeds a single request.
      while (notes.length > 100000) {
        const chunks = notes.match(/[\s\S]{1,65000}/g), compressed = [];
        for (let i = 0; i < chunks.length; i++) {
          if (state.cancelled) throw new DOMException('已停止', 'AbortError');
          $('generationStatus').textContent = `汇总全文证据 ${i + 1}/${chunks.length}…`;
          compressed.push(await streamTaskMessage({ documentKey: state.key, fileName: state.file.name, question: `针对问题“${question}”，压缩以下研读笔记。保留所有相关结论、数字、题号和页码，合并重复内容，控制在原长度一半以内。`, page: 1, scope: 'document', text: chunks[i], model: task.model, effort: task.effort, isolated: true }, '整理全文证据'));
        }
        const next = compressed.join('\n\n');
        if (next.length >= notes.length) throw new Error('研读结果过长，已保留分批笔记，请缩小问题范围或导出查阅。');
        notes = next;
      }
      $('generationStatus').textContent = '已研读所有页面，正在汇总回答…';
      await streamTaskMessage({ documentKey: state.key, fileName: state.file.name, question: `${question}\n\n程序已经逐批研读整份文档的全部 ${state.count} 页。以下是每一批得到的相关证据。请结合这些证据给出整份文档的最终回答，保留页码引用，明确不确定之处。`, page: 1, scope: 'document', text: notes, model: task.model, effort: task.effort }, '整份文档 · 汇总回答');
    }
    $('generationStatus').textContent = kind === 'exercises' ? `已检查全部 ${state.count} 页；习题解答已分批汇总，可点击 ↓ 导出` : `已研读全部 ${state.count} 页并完成回答`;
    $('taskProgressText').textContent = `已完成全部 ${state.count} 页 · ${task.batches.length} 批`;
    toast(kind === 'exercises' ? '全部页面已处理。可点击右上角 ↓ 导出完整解答，并核对标出的不确定题目。' : '已完成整份文档的研读与回答。');
  } catch(e) { $('generationStatus').textContent = state.cancelled ? '任务已停止，已完成的部分已保存' : e.message; $('taskProgressText').textContent = `已完成 ${state.task?.next || 0}/${state.task?.batches.length || '?'} 批 · 已保留结果`; if (!state.cancelled) toast(e.message); }
  finally { state.busy = false; state.controller = null; await persist(); updateControls(); documentUpload?.resume(); }
}

$('openFile').onclick = $('emptyOpen').onclick = () => {if(!state.pickingFile){state.pickingFile=true;$('openFile').disabled=true;void readerMemory.pick().finally(()=>{state.pickingFile=false;updateControls();});}};
$('fileInput').onchange = e => openFile(e.target.files[0]);
$('prevPage').onclick = () => navigate(state.page - 1); $('nextPage').onclick = () => navigate(state.page + 1);
$('pageNumber').onchange = e => navigate(e.target.value);
$('originalPreview').onclick = async () => {
  if (!state.analysisPdf || !state.key || state.busy || state.waitingToAsk || state.rendering) return;
  continuousReader?.close();continuousReader=null;
  ++state.openVersion; // Stop indexing the quick preview before switching its page source.
  state.pdf = state.analysisPdf; state.analysisPdf = null; state.analysisPromise = null;
  state.slides = null; state.count = state.pdf.numPages; state.page = Math.min(state.page, state.count);
  state.textCache = new Map(); state.pages = null; state.task = null;
  for (const url of state.previewUrls) URL.revokeObjectURL(url); state.previewUrls.clear();
  $('slideText')?.replaceChildren(); $('originalPreview').hidden = true;
  $('documentType').textContent = 'PowerPoint · 原版预览';
  $('pageTotal').textContent = '/ ' + state.count; $('pageNumber').max = state.count;
  $('documentIndexStatus').textContent = '原版已就绪，后台提取文字…';
  clearSelection(); await renderPage();
  state.indexPromise = indexWholeDocument(); void state.indexPromise.catch(() => {});
};
$('documentScroll').title='滚轮或触控板上下滑动，连续阅读所有页面';
$('togglePages').onclick = () => { $('pageList').hidden = !$('pageList').hidden; if (state.file) void renderPage(); };
$('zoomFit').onclick = () => { state.zoom = null; void renderPage(); };
$('zoomIn').onclick = () => { state.zoom = Math.min(4, (state.zoom || continuousReader?.records[state.page-1]?.scale || 1) + .2); void renderPage(); };
$('zoomOut').onclick = () => { state.zoom = Math.max(.25, (state.zoom || continuousReader?.records[state.page-1]?.scale || 1) - .2); void renderPage(); };
function readerModeHint(){ $('documentScroll').title=$('readingMode').value==='single'?'页面内滚轮逐页翻阅，页面外滚轮上下滑动；Ctrl + 滚轮只缩放文档':'滚轮上下连续滑动；Ctrl + 滚轮只缩放文档'; }
$('readingMode').onchange=async()=>{
  readerModeHint();singleWheelAmount=0;clearSelection();
  try{localStorage.setItem('codex-reader-reading-mode',$('readingMode').value);}catch{}
  readerMemory.preference({readingMode:$('readingMode').value});
  if(continuousReader)await continuousReader.setMode($('readingMode').value,state.page);
};
let singleWheelAmount=0,readerZoomFrame=0,answerZoom=1;
function applyAnswerZoom(zoom,x,y){
  const box=$('messages'),area=box.getBoundingClientRect();
  x=x>=area.left&&x<=area.right?x:area.left+area.width/2;y=y>=area.top&&y<=area.bottom?y:area.top+area.height/2;
  const anchor=document.elementFromPoint(x,y)?.closest('.message'),old=anchor?.getBoundingClientRect(),fraction=old?(y-old.top)/old.height:0;
  const bottom=box.scrollHeight-box.scrollTop-box.clientHeight<20;
  answerZoom=Math.max(.7,Math.min(2.5,zoom));box.style.setProperty('--answer-zoom',answerZoom);
  if(anchor&&old){const next=anchor.getBoundingClientRect();box.scrollTop+=next.top+fraction*next.height-y;}else if(bottom)box.scrollTop=box.scrollHeight;
  $('answerZoomReset').hidden=Math.abs(answerZoom-1)<.005;$('answerZoomReset').textContent=Math.round(answerZoom*100)+'%';
  $('answerZoomReset').title='回答文字 '+Math.round(answerZoom*100)+'%，点击恢复 100%';
  try{localStorage.setItem('codex-reader-answer-zoom',String(answerZoom));}catch{}
  readerMemory.preference({answerZoom});
}
$('answerZoomReset').onclick=()=>applyAnswerZoom(1);
document.addEventListener('wheel',event=>{
  if(!(event.ctrlKey||event.metaKey)||!event.deltaY)return;
  const reader=event.target.closest('.reader'),chat=event.target.closest('#chatPanel');if(!reader&&!chat)return;
  event.preventDefault();
  const pixels=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?500:1),factor=Math.exp(-Math.max(-250,Math.min(250,pixels))*.0012);
  if(chat){applyAnswerZoom(answerZoom*factor,event.clientX,event.clientY);return;}
  if(!continuousReader?.records.length)return;
  state.zoom=Math.max(.25,Math.min(4,(state.zoom||continuousReader.records[state.page-1]?.scale||1)*factor));
  const view=continuousReader,x=event.clientX,y=event.clientY;
  cancelAnimationFrame(readerZoomFrame);readerZoomFrame=requestAnimationFrame(()=>{
    if(view!==continuousReader||view.closed)return;
    view.zoomAt(state.zoom,x,y);$('zoomFit').textContent=Math.round(state.zoom*100)+'%';
  });
},{capture:true,passive:false});
$('documentScroll').addEventListener('wheel',event=>{
  if($('readingMode').value!=='single'||!state.count||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey||Math.abs(event.deltaX)>=Math.abs(event.deltaY)||!event.target.closest('.continuous-page'))return;
  event.preventDefault();const direction=Math.sign(event.deltaY);let turns;
  if(event.deltaMode!==0||Math.abs(event.deltaY)>=80){const unit=event.deltaMode===1?3:event.deltaMode===2?1:100;turns=Math.max(1,Math.floor(Math.abs(event.deltaY)/unit));singleWheelAmount=0;}
  else{if(Math.sign(singleWheelAmount)!==direction)singleWheelAmount=0;singleWheelAmount+=event.deltaY;turns=Math.floor(Math.abs(singleWheelAmount)/100);singleWheelAmount-=direction*turns*100;}
  if(turns)void navigate(state.page+direction*turns);
},{passive:false});
function setChatCollapsed(collapsed,save=true){
  document.body.classList.toggle('chat-collapsed',collapsed);
  $('toggleChat').textContent=collapsed?'‹ 展开问答':'收起问答 ›';
  $('toggleChat').setAttribute('aria-expanded',String(!collapsed));$('chatPanel').inert=collapsed;
  $('chatSettings').open=false;
  if(collapsed&&$('chatPanel').contains(document.activeElement))$('toggleChat').focus();
  if(state.file)void renderPage();
  if(save)readerMemory.preference({chatCollapsed:collapsed});
}
$('toggleChat').onclick=()=>setChatCollapsed(!document.body.classList.contains('chat-collapsed'));
$('scope').onchange = updateControls; $('includeImage').onchange = updateControls;
$('chatForm').onsubmit = e => { e.preventDefault(); void sendQuestion($('question').value); };
$('attachImage').onclick=()=>$('chatImageInput').click();
$('chatImageInput').onchange=async e=>{await addImages([...e.target.files]);e.target.value='';};
$('question').addEventListener('paste',e=>{const files=[...e.clipboardData.items].filter(item=>item.type.startsWith('image/')).map(item=>item.getAsFile()).filter(Boolean);if(files.length){e.preventDefault();void addImages(files);}});
$('questionJump').onchange=e=>{if(e.target.value)jumpToMessage(e.target.value);};
$('latestMessage').onclick=()=>{$('messages').scrollTo({top:$('messages').scrollHeight,behavior:'smooth'});$('questionJump').value='';};
$('clearReply').onclick=clearReply;
$('replyPreviewText').onclick=()=>{if(replyTarget)jumpToMessage(replyTarget.rootId);};
$('question').onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); void sendQuestion($('question').value); } };
document.querySelectorAll('[data-question]').forEach(button => { button.onclick = () => { $('scope').value='page';updateControls();$('question').value = button.dataset.question; $('question').focus(); }; });
$('stop').onclick = async () => { state.cancelled = true; state.controller?.abort(); await api('stop', { documentKey: state.key }).catch(() => {}); };
$('reconnect').onclick = connect;
$('quickRestart').onclick=async()=>{
  if(state.restarting)return;
  state.restarting=true;
  const scrollTop=$('messages').scrollTop;
  state.cancelled=true;state.controller?.abort();documentUpload?.cancel();documentUpload=null;
  updateControls();$('generationStatus').textContent='正在重启问答服务，文档和记录已保留…';
  try {
    await api('restart',{});
    // Let the interrupted request finish saving its partial answer before reconnecting.
    const deadline=Date.now()+5000;
    while((state.busy||state.waitingToAsk)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,40));
    await persist();await connect();
    if(!state.connected)throw new Error('问答服务尚未连接，请再次点击快速重启。');
    $('messages').scrollTop=scrollTop;
    $('generationStatus').textContent='重启完成，可以继续提问';toast('重启完成，文档、当前页与聊天记录均已保留。');
  }catch(e){$('generationStatus').textContent=e.message;toast(e.message);}
  finally{state.restarting=false;updateControls();if(state.file&&state.indexPromise&&!documentUpload)void startDocumentUpload(state.openVersion);}
};
$('model').addEventListener('change', updateEffortOptions);
$('effort').addEventListener('change', () => { try { localStorage.setItem('codex-reader-effort', $('effort').value); } catch {} });
$('login').onclick = async () => { try { const result = await api('login', {}); if (result.url && /^https:\/\//.test(result.url)) { window.open(result.url, '_blank', 'noopener,noreferrer'); toast('登录完成后，点击“重连”。'); } else toast('未收到登录地址，请在 Codex 中完成登录。'); } catch(e) { toast(e.message); } };
$('newChat').onclick = async () => {
  if (!state.key || state.busy) return;
  if (state.messages.length && !confirm('为当前文档开始新对话？窗口中的旧记录将被清除，可先导出保存。')) return;
  try { await api('new', { documentKey: state.key }); state.messages = []; persist(); showMessages(); $('generationStatus').textContent = '已开始新对话'; } catch(e) { toast(e.message); }
};
$('exportChat').onclick = () => {
  if (!state.messages.length) return toast('还没有可导出的对话。');
  const text = `# ${state.file?.name || '文档'} · 阅读对话\n\n` + state.messages.map(m => `## ${m.role === 'user' ? '你' : 'Codex'}${m.context ? `（${m.context}）` : ''}\n\n${m.text}${m.error ? '\n\n> ' + m.error : ''}`).join('\n\n');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' })); const a = document.createElement('a'); a.href = url; a.download = `${state.file.name.replace(/\.[^.]+$/, '')}-阅读对话.md`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
$('exportSolutions').onclick = () => {
  const answers = state.messages.filter(m => m.role === 'assistant' && m.context?.startsWith('习题解答 ·') && !m.error && m.text);
  if (!answers.length) return toast('还没有完整的习题解答。');
  const incomplete = state.task?.kind === 'exercises' && state.task.next < state.task.batches.length;
  const text = `# ${state.file.name} · 习题解答\n\n文档共 ${state.count} 页。${incomplete ? `任务尚未完成：已完成 ${state.task.next}/${state.task.batches.length} 批，以下仅包含已完成部分。` : '以下为各批次的习题解答，请结合原题核对；条件不足的题目会在正文中标注。'}\n\n` + answers.map(m => `## ${m.context}\n\n${m.text}`).join('\n\n---\n\n');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' })); const a = document.createElement('a'); a.href = url; a.download = `${state.file.name.replace(/\.[^.]+$/, '')}-习题解答.md`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
$('help').onclick = () => $('helpDialog').showModal(); $('closeHelp').onclick = () => $('helpDialog').close();
$('documentSummary').onclick=()=>{$('appMenu').open=!$('appMenu').open;};
$('question').addEventListener('input',fitQuestionInput);
const documentStatusObserver=new MutationObserver(updateCompactStatus);
for(const id of ['documentIndexStatus','documentUploadStatus'])documentStatusObserver.observe($(id),{childList:true,characterData:true,subtree:true});
for(const id of ['appMenu','chatSettings'])$(id).addEventListener('toggle',()=>{if($(id).open)$(id==='appMenu'?'chatSettings':'appMenu').open=false;});
$('appMenu').addEventListener('click',event=>{if(event.target.closest('button'))$('appMenu').open=false;});
document.addEventListener('pointerdown',event=>{for(const id of ['appMenu','chatSettings'])if(!$(id).contains(event.target)&&event.target!==$('documentSummary'))$(id).open=false;});
document.addEventListener('keydown',event=>{if(event.key==='Escape')for(const id of ['appMenu','chatSettings'])if($(id).open){$(id).open=false;$(id).querySelector('summary').focus();}});
$('shutdown').onclick = async () => { if (state.busy && !confirm('正在生成回答，确定退出阅伴？')) return; await api('shutdown', {}); $('helpDialog').close(); state.connected = false; state.loggedIn = false; $('connectionText').textContent = '阅伴已退出'; $('connectionDot').className = 'status-dot'; updateControls(); toast('后台服务已关闭，可以关闭此窗口。'); };
for (const event of ['dragover', 'dragenter']) $('dropZone').addEventListener(event, e => { e.preventDefault(); $('dropZone').classList.add('dragging'); });
$('dropZone').addEventListener('dragleave', e => { if (!$('dropZone').contains(e.relatedTarget)) $('dropZone').classList.remove('dragging'); });
$('dropZone').addEventListener('drop', e => { e.preventDefault(); $('dropZone').classList.remove('dragging'); if (state.busy) return toast('请先停止当前回答，再切换文档。'); void openFile(e.dataTransfer.files[0]); });
window.addEventListener('dragover', e => e.preventDefault()); window.addEventListener('drop', e => e.preventDefault());
window.addEventListener('pagehide',()=>{documentUpload?.cancel();if(state.presentation)navigator.sendBeacon('/api/presentation/close',new Blob([JSON.stringify({id:state.presentation.id})],{type:'application/json'}));});
document.addEventListener('keydown', e => { if (e.target.matches('input,textarea,select') || e.ctrlKey || e.metaKey || e.altKey) return; if(e.key==='PageDown'||e.key==='PageUp'){e.preventDefault();const direction=e.key==='PageDown'?1:-1;if($('readingMode').value==='single')void navigate(state.page+direction);else $('documentScroll').scrollBy({top:$('documentScroll').clientHeight*.85*direction,behavior:'auto'});return;}if (e.key === 'ArrowRight') { e.preventDefault(); void navigate(state.page + 1); } if (e.key === 'ArrowLeft') { e.preventDefault(); void navigate(state.page - 1); } });
let resizeTimer;
function scheduleRender() { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (state.file && !state.rendering) void renderPage(); }, 200); }
window.addEventListener('resize', scheduleRender);
$('resizeHandle').addEventListener('pointerdown', e => { $('resizeHandle').setPointerCapture(e.pointerId); document.body.classList.add('resizing'); });
$('resizeHandle').addEventListener('pointermove', e => { if (!document.body.classList.contains('resizing')) return; document.documentElement.style.setProperty('--chat-width', Math.max(330, Math.min(innerWidth - 340, innerWidth - e.clientX)) + 'px'); });
$('resizeHandle').addEventListener('pointerup', () => { document.body.classList.remove('resizing'); readerMemory.preference({chatWidth:$('chatPanel').clientWidth});scheduleRender(); });
$('resizeHandle').addEventListener('keydown', e => { if (['ArrowLeft', 'ArrowRight'].includes(e.key)) { e.preventDefault(); const width = $('chatForm').closest('.chat-panel').clientWidth; document.documentElement.style.setProperty('--chat-width', Math.max(330, Math.min(innerWidth - 340, width + (e.key === 'ArrowLeft' ? 20 : -20))) + 'px'); scheduleRender(); } });

async function init() {
  try {
    const token = location.hash.slice(1);
    if (token) { await api('unlock', { token }); history.replaceState(null, '', location.pathname); }
    try{const saved=await readerMemory.load();if(saved.lastFileId)void readerMemory.open(saved.lastFileId);}catch{toast('暂时无法读取上次设置，仍可正常使用阅读器。');}
    await connect();
  } catch(e) { toast(e.message); $('connectionText').textContent = '请通过“启动阅伴”重新打开'; }
  updateControls();
}
function setDarkBackground(dark,save=true){
  document.documentElement.dataset.theme=dark?'dark':'light';
  $('toggleTheme').textContent=dark?'☀ 浅色背景':'☾ 深色背景';
  $('toggleTheme').setAttribute('aria-pressed',String(dark));
  try{localStorage.setItem('codex-reader-theme',dark?'dark':'light');}catch{}
  if(save)readerMemory.preference({theme:dark?'dark':'light'});
}
try{setDarkBackground((document.documentElement.dataset.theme||localStorage.getItem('codex-reader-theme'))==='dark',false);}catch{setDarkBackground(false,false);}
setChatCollapsed(document.body.classList.contains('chat-collapsed'),false);
$('toggleTheme').onclick=()=>setDarkBackground(document.documentElement.dataset.theme!=='dark');
try{$('readingMode').value=localStorage.getItem('codex-reader-reading-mode')==='single'?'single':'continuous';const saved=Number(localStorage.getItem('codex-reader-answer-zoom'));if(Number.isFinite(saved)&&saved>=.7&&saved<=2.5)applyAnswerZoom(saved);}catch{}
readerModeHint();
void init();
