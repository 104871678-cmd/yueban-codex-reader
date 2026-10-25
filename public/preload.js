import {planBatches} from './tasks.js';

// Uploads run in a separate Codex conversation and never own the chat controls.
export class DocumentUpload {
  constructor(options) {
    Object.assign(this,options);
    this.controller = new AbortController(); this.ready = false; this.paused = false;
    this.textPages = new Set(); this.imagePages = new Set();
  }
  cancel() { this.controller.abort(); this.requestController?.abort(); }
  pause() { this.paused = true; this.requestController?.abort(); }
  resume() { this.paused = false; }
  async yieldToQuestion() {
    while (this.paused && !this.controller.signal.aborted) await new Promise(r=>setTimeout(r,80));
    this.controller.signal.throwIfAborted();
  }
  show() {
    if (this.controller.signal.aborted) return;
    this.onStatus(this.ready ? `全文文字已交给 Codex · 提问按页定位，图表按需查看` : `${this.cached?'本机全文已就绪 · 后台提交':'后台准备全文'} · ${this.textPages.size}/${this.count} 页`);
  }
  async send(body) {
    while (true) {
      await this.yieldToQuestion();
      if((await this.status()).ready)return;
      const controller = this.requestController = new AbortController();
      const abort = ()=>controller.abort(); this.controller.signal.addEventListener('abort',abort,{once:true});
      try { await this.submit({...body,documentKey:this.key,fileName:this.fileName,scope:'document',documentPages:this.count,model:this.model,effort:this.effort},controller.signal); return; }
      catch(e) {
        if (this.controller.signal.aborted) throw e;
        if(e.retryable){await new Promise(r=>setTimeout(r,300));continue;}
        if (e.name !== 'AbortError') throw e;
        // A foreground question interrupted this background acknowledgement. Retry later.
      } finally { this.controller.signal.removeEventListener('abort',abort); if(this.requestController===controller)this.requestController=null; }
    }
  }
  async run() {
    try {
      this.localReady=this.stage();
      await this.localReady;
      this.cached=true;
      const saved = await this.status();
      this.textPages = new Set(saved.textPages); this.imagePages = new Set(saved.imagePages);
      if (saved.ready) { this.ready = true; this.show(); return; }
      this.show();
      for (const batch of planBatches(this.pages,{maxPages:1000,maxChars:65000,overlap:false})) {
        if (Array.from({length:batch.end-batch.start+1},(_,i)=>batch.start+i).every(p=>this.textPages.has(p))) continue;
        const text = this.pages.slice(batch.start-1,batch.end).map((p,i)=>`[第 ${batch.start+i} 页]\n${p || '本页没有可提取文字；需要时调用 reader_pages 查看本页原图。'}`).join('\n\n');
        if (text.length>120000) throw new Error('单页文字过长，无法自动提交，请拆分文件。');
        await this.send({question:'这是打开课程文件后的后台资料提交，不是用户提问。请接收这些页的全文文字供后续问答使用。不总结、不解题、不逐页分析，只回复“已接收”。',text,page:batch.start,preload:{kind:'text',start:batch.start,end:batch.end,total:this.count}});
        for(let p=batch.start;p<=batch.end;p++)this.textPages.add(p);this.show();
      }
      const verified = await this.status();
      if(!verified.ready)throw new Error('部分资料尚未确认接收，请重新打开文件重试。');
      this.ready = true; this.show();
    } catch(e) {
      if(!this.controller.signal.aborted)this.onStatus('后台提交暂停：'+e.message+'；仍可直接问当前页');
    }
  }
  async stage(){
    if(!this.cache)return;
    for(const batch of planBatches(this.pages,{maxPages:1000,maxChars:65000,overlap:false})){
      this.controller.signal.throwIfAborted();
      const text=this.pages.slice(batch.start-1,batch.end).map((page,i)=>`[第 ${batch.start+i} 页]\n${page||'本页没有可提取文字；需要时调用 reader_pages 查看本页原图。'}`).join('\n\n');
      await this.cache({key:this.key,start:batch.start,end:batch.end,total:this.count,text},this.controller.signal);
    }
  }
}
