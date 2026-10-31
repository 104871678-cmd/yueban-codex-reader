// HTML stays a live document. The isolated frame reports text and reading position.
function documentBridge(channel) {
  const send=(type,body={})=>parent.postMessage({channel,type,...body},'*');
  for(const name of ['localStorage','sessionStorage']){
    try{void window[name].length;}catch{
      const values=new Map();
      try{Object.defineProperty(window,name,{value:{getItem:key=>values.get(String(key))??null,setItem:(key,value)=>values.set(String(key),String(value)),removeItem:key=>values.delete(String(key)),clear:()=>values.clear(),key:index=>[...values.keys()][index]??null,get length(){return values.size;}}});}catch{}
    }
  }
  let anchors=[],scale=1,frame,reported=0;
  const current=()=>{
    const y=innerHeight*.2;
    let page=1;
    for(let i=0;i<anchors.length;i++){if(anchors[i].getBoundingClientRect().top<=y)page=i+1;else break;}
    return page;
  };
  function position(){const page=current();if(page!==reported){reported=page;send('page',{page});}}
  function collect(){
    if(!document.body)return;
    const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
    const pages=[],labels=[];anchors=[];
    let text='',anchor=null,label=document.title||'HTML 文档',node;
    const flush=()=>{if(!text.trim())return;pages.push(text.trim());anchors.push(anchor||document.body);labels.push(label);text='';anchor=null;};
    while(node=walker.nextNode()){
      const element=node.parentElement;
      if(!element||element.closest('script,style,noscript,template,textarea,[data-reader-bridge]'))continue;
      const value=node.textContent.replace(/\s+/g,' ').trim();if(!value)continue;
      if(/^H[1-3]$/.test(element.tagName)){if(text.length>1500)flush();label=element.textContent.trim().slice(0,120);}
      for(let start=0;start<value.length;start+=12000){
        const part=value.slice(start,start+12000);
        if(text.length+part.length>16000)flush();
        anchor||=element;text+=part+'\n';
      }
    }
    flush();if(!pages.length){pages.push('[HTML 中没有可提取文字，可补充截图提问。]');anchors.push(document.body);labels.push(label);}
    send('ready',{pages,labels});position();
  }
  let collected=false;
  const ready=()=>{if(collected)return;collected=true;collect();};
  document.addEventListener('DOMContentLoaded',()=>setTimeout(ready,0),{once:true});
  // A slow external dependency must not indefinitely hold up local text preparation.
  setTimeout(ready,1800);
  addEventListener('scroll',()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(position);},{passive:true});
  const select=()=>{const text=getSelection()?.toString().trim();if(text)send('selection',{text:text.slice(0,120000),page:current()});};
  document.addEventListener('pointerup',select);document.addEventListener('keyup',select);
  addEventListener('wheel',event=>{
    if(!(event.ctrlKey||event.metaKey)||!event.deltaY)return;
    event.preventDefault();send('zoom',{delta:event.deltaY,mode:event.deltaMode,x:event.clientX,y:event.clientY});
  },{passive:false,capture:true});
  addEventListener('message',event=>{
    if(event.source!==parent||event.data?.channel!==channel)return;
    const message=event.data;
    if(message.type==='navigate')anchors[message.page-1]?.scrollIntoView({block:'start',behavior:'instant'});
    if(message.type==='zoom'){
      const next=Math.max(.25,Math.min(4,Number(message.zoom)||1));
      const x=Number.isFinite(message.x)?message.x:innerWidth/2,y=Number.isFinite(message.y)?message.y:innerHeight*.25;
      const left=(scrollX+x)/scale,top=(scrollY+y)/scale;
      scale=next;document.documentElement.style.zoom=String(scale);scrollTo(left*scale-x,top*scale-y);position();
    }
  });
  // Links keep fragment navigation in the course and avoid replacing the reader.
  document.addEventListener('click',event=>{
    const link=event.target.closest('a[href]');if(!link)return;
    const href=link.getAttribute('href');
    if(href.startsWith('#')){event.preventDefault();let id;try{id=decodeURIComponent(href.slice(1));}catch{return;}document.getElementById(id)?.scrollIntoView();}
    else{event.preventDefault();if(/^https?:\/\//i.test(href))send('link',{url:href});}
  });
}

export async function readHtml(file){
  const bytes=await file.arrayBuffer(),prefix=new TextDecoder().decode(bytes.slice(0,4096));
  const charset=prefix.match(/charset\s*=\s*["']?\s*([\w-]+)/i)?.[1]||'utf-8';
  let text;try{text=new TextDecoder(charset).decode(bytes);}catch{text=new TextDecoder().decode(bytes);}
  const doc=new DOMParser().parseFromString(text,'text/html');
  doc.querySelectorAll('base,meta[http-equiv="Content-Security-Policy" i],meta[http-equiv="refresh" i]').forEach(node=>node.remove());
  const missing=[...doc.querySelectorAll('img[src],script[src],link[rel="stylesheet"][href]')].some(node=>!/^([a-z][\w+.-]*:|\/\/|#)/i.test(node.getAttribute('src')||node.getAttribute('href')||''));
  const channel=crypto.randomUUID(),bridge=doc.createElement('script');bridge.dataset.readerBridge='';bridge.textContent=`(${documentBridge.toString()})(${JSON.stringify(channel)});`;
  const meta=doc.createElement('meta');meta.charset='utf-8';doc.head.prepend(bridge);doc.head.prepend(meta);
  return {html:'<!doctype html>\n'+doc.documentElement.outerHTML,channel,missing,pages:null};
}

export class HtmlReader{
  constructor({stage,scroll,onPage,onSelection,onZoom,onLink}){Object.assign(this,{stage,scroll,onPage,onSelection,onZoom,onLink});this.records=[];this.closed=false;this.current=1;}
  async open(source){
    this.source=source;this.scroll.classList.add('html-document-scroll');this.stage.classList.add('html-stage');
    const frame=this.frame=document.createElement('iframe');frame.className='html-document';frame.title='HTML 课程原文';frame.setAttribute('sandbox','allow-scripts');
    const ready=new Promise((resolve,reject)=>{this.reject=reject;this.timer=setTimeout(()=>reject(new Error('HTML 未能提供正文，请先用浏览器确认文件可正常打开。')),12000);this.resolve=resolve;});
    // Handle failure immediately even if the local request is still in flight.
    void ready.catch(()=>{});
    this.receive=event=>{
      const data=event.data;if(this.closed||event.source!==frame.contentWindow||data?.channel!==source.channel)return;
      if(data.type==='ready'&&Array.isArray(data.pages)&&data.pages.length<=20000&&data.pages.every(page=>typeof page==='string'&&page.length<=17000)){
        source.pages=data.pages;source.labels=data.labels;
        this.records=data.pages.map((_,i)=>({scale:1,number:i+1}));clearTimeout(this.timer);this.resolve(data.pages);
      }
      if(data.type==='page'&&Number.isInteger(data.page)&&data.page>=1&&data.page<=this.records.length){this.current=data.page;this.onPage(data.page);}
      if(data.type==='selection'&&typeof data.text==='string')this.onSelection(data.text,Number(data.page));
      if(data.type==='zoom'&&Number.isFinite(data.delta))this.onZoom(data);
      if(data.type==='link'&&typeof data.url==='string'&&/^https?:\/\//i.test(data.url))this.onLink(data.url);
    };
    window.addEventListener('message',this.receive);
    try{
      const response=await fetch('/api/html',{method:'POST',headers:{'Content-Type':'text/html; charset=utf-8'},body:source.html});
      if(!response.ok)throw new Error((await response.json()).error||'HTML 打开失败。');
      const result=await response.json();this.id=result.id;
      if(this.closed){void this.release();return;}
      frame.src=result.url;this.stage.replaceChildren(frame);
      await ready;
    }catch(error){clearTimeout(this.timer);throw error;}
  }
  post(message){this.frame?.contentWindow?.postMessage({channel:this.source.channel,...message},'*');}
  layout(){for(const record of this.records)record.scale=this.zoom||1;this.post({type:'zoom',zoom:this.zoom||1});}
  zoomAt(zoom,x,y){this.zoom=zoom;const rect=this.frame.getBoundingClientRect();this.post({type:'zoom',zoom,x:x-rect.left,y:y-rect.top});}
  async navigate(number){number=Math.max(1,Math.min(this.records.length,number));this.current=number;this.onPage(number);this.post({type:'navigate',page:number});}
  async setMode(){}
  async release(){if(this.id)await fetch('/api/html/'+this.id,{method:'DELETE'}).catch(()=>{});}
  close(){this.closed=true;clearTimeout(this.timer);this.reject?.(new DOMException('文件已切换','AbortError'));window.removeEventListener('message',this.receive);this.scroll.classList.remove('html-document-scroll');this.stage.classList.remove('html-stage');void this.release();}
}
