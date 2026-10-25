import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { access } from 'node:fs/promises';
import path from 'node:path';

export class PresentationHost {
  constructor(script, inputFile, directory, { spawnProcess = spawn } = {}) {
    this.script = script; this.inputFile = inputFile; this.directory = directory;
    this.pending = new Map(); this.pages = new Map(); this.sequence = 0; this.proc = null; this.info = null;
    this.spawnProcess = spawnProcess; this.foreground = new Set(); this.closing = false;
  }
  async start() {
    let resolveReady, rejectReady;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const proc = this.proc = this.spawnProcess('powershell.exe', ['-NoProfile','-NonInteractive','-STA','-ExecutionPolicy','Bypass','-File',this.script,'-InputFile',this.inputFile,'-OutputDirectory',this.directory], { windowsHide:true, stdio:['pipe','pipe','pipe'] });
    let stderr = '';
    proc.stderr.on('data', b => { stderr = (stderr + b.toString()).slice(-1800); }); proc.stdin.on('error',()=>{});
    const timer = setTimeout(() => { rejectReady(new Error('原版第一页打开超时，请用 WPS 另存为 PDF 后打开。')); void this.close(); }, 60000);
    const fail = e => { clearTimeout(timer); rejectReady(e); for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(e); } this.pending.clear(); };
    createInterface({input:proc.stdout}).on('line', line => {
      let result; try { result = JSON.parse(line); } catch { return; }
      if (result.type === 'ready') {
        clearTimeout(timer); this.info = result; this.pages.set(1,Promise.resolve(path.join(this.directory,'page-1.png'))); resolveReady(result);
        // Return the first page immediately, then keep the same Office session busy.
        setImmediate(() => { this.background = this.renderRemaining(); });
      }
      else if (result.type === 'fatal') fail(new Error(`无法使用 WPS/PowerPoint 打开原版：${result.error}`));
      else if (result.id != null) {
        const pending = this.pending.get(result.id); if (!pending) return;
        this.pending.delete(result.id); clearTimeout(pending.timer);
        if (result.error) pending.reject(new Error(result.error)); else pending.resolve(path.join(this.directory,`page-${result.page}.png`));
      }
    });
    proc.once('error',e=>fail(new Error(`原版渲染启动失败：${e.message}`)));
    proc.once('exit',code=>{ this.proc = null; this.closing = true; fail(new Error(`原版渲染已退出（${code}）。${stderr}`)); });
    return ready;
  }
  getPage(page, { background = false } = {}) {
    if (!this.info || !Number.isInteger(page) || page < 1 || page > this.info.count) return Promise.reject(new Error('页码超出范围。'));
    if (this.closing) return Promise.reject(new Error('课件已关闭，请重新打开文件。'));
    let operation = this.pages.get(page);
    if (!operation) {
      operation = this.loadPage(page).catch(e=>{this.pages.delete(page);throw e;});
      this.pages.set(page,operation);
    }
    if (!background) {
      this.foreground.add(operation);
      operation.then(()=>this.foreground.delete(operation),()=>this.foreground.delete(operation));
    }
    return operation;
  }
  async renderRemaining() {
    for (let page = 2; page <= this.info.count && !this.closing; page++) {
      // Only one speculative page at a time. Requested pages go ahead of the rest.
      while (this.foreground.size && !this.closing) await Promise.allSettled([...this.foreground]);
      if (this.closing) break;
      try { await this.getPage(page,{background:true}); }
      catch { /* A failed background page can be retried when requested. */ }
    }
  }
  async loadPage(page) {
    const output = path.join(this.directory,`page-${page}.png`);
    try { await access(output); return output; } catch {}
    return new Promise((resolve,reject)=>{
      if (this.closing || !this.proc?.stdin.writable) return reject(new Error('原版渲染连接已关闭，请重新打开文件。'));
      const id = ++this.sequence;
      const timer = setTimeout(()=>{ this.pending.delete(id); reject(new Error('本页渲染超时，请重试。')); },45000);
      this.pending.set(id,{resolve,reject,timer}); this.proc.stdin.write(JSON.stringify({id,page})+'\n');
    });
  }
  async close() {
    this.closing = true;
    const proc = this.proc; if (!proc) return;
    await new Promise(resolve=>{
      const timer = setTimeout(()=>{proc.kill();resolve();},5000);
      proc.once('exit',()=>{clearTimeout(timer);resolve();});
      try { proc.stdin.end(JSON.stringify({method:'close'})+'\n'); } catch { proc.kill(); }
    });
  }
}
