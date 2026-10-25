import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function findCodex() {
  if (process.env.CODEX_READER_CODEX) return process.env.CODEX_READER_CODEX;
  const local = process.env.LOCALAPPDATA;
  const roots = [local && path.join(local, 'OpenAI', 'Codex', 'bin'), path.join(os.homedir(), 'AppData', 'Local', 'OpenAI', 'Codex', 'bin')].filter(Boolean);
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const versions = readdirSync(root, { withFileTypes: true }).filter(x => x.isDirectory()).map(x => path.join(root, x.name, 'codex.exe')).filter(existsSync).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    if (versions.length) return versions[0];
  }
  return process.platform === 'win32' ? 'codex.exe' : 'codex';
}

export class CodexBridge extends EventEmitter {
  constructor(cwd) { super(); this.cwd = cwd; this.pending = new Map(); this.counter = 0; this.ready = null; this.proc = null; }
  async start() {
    if (this.ready) return this.ready;
    this.ready = this.boot().catch(e => { this.ready = null; throw e; });
    return this.ready;
  }
  async boot() {
    const args=['app-server','--listen','stdio://'];
    for(const feature of ['apps','shell_tool','shell_snapshot','multi_agent','skill_search'])args.push('--disable',feature);
    // Disable configured integrations before app-server initializes them, in this process only.
    try {
      const source=readFileSync(path.join(process.env.CODEX_HOME || path.join(os.homedir(),'.codex'),'config.toml'),'utf8');
      for(const match of source.matchAll(/^\s*\[(mcp_servers|plugins)\.((?:"[^"\r\n]+"|'[^'\r\n]+'|[A-Za-z0-9_-]+))\]\s*$/gm)) {
        const raw=match[2],name=raw.startsWith('"')?JSON.parse(raw):raw.startsWith("'")?raw.slice(1,-1):raw;
        if(!name.includes('.'))args.push('-c',`${match[1]}.${name}.enabled=false`);
      }
    } catch {}
    const proc = this.proc = spawn(findCodex(), args, {
      cwd: this.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    proc.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-4000); });
    proc.stdin.on('error', () => {});
    const lines = createInterface({ input: proc.stdout });
    lines.on('line', line => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.id !== undefined && !msg.method) {
        const pending = this.pending.get(msg.id);
        if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(msg.id);
        if (msg.error) pending.reject(new Error(msg.error.message)); else pending.resolve(msg.result);
      } else if (msg.method && msg.id !== undefined) {
        if(msg.method==='item/tool/call' && msg.params?.tool==='reader_pages' && this.readDocumentPages) {
          Promise.resolve().then(()=>this.readDocumentPages(msg.params)).then(
            result=>this.send({id:msg.id,result}),
            error=>this.send({id:msg.id,result:{success:false,contentItems:[{type:'inputText',text:error.message}]}})
          ).catch(()=>{});
          return;
        }
        // The document assistant never approves command execution or edits.
        this.send({ id: msg.id, error: { code: -32601, message: 'This reader only supports document conversations; interactive tools are disabled.' } });
        this.emit('notification', { method: 'reader/toolBlocked', params: { threadId: msg.params?.threadId } });
      } else if (msg.method) this.emit('notification', msg);
    });
    const failed = error => {
      if (this.proc !== proc) return;
      this.proc = null; this.ready = null;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
      this.pending.clear(); this.emit('offline', error.message);
    };
    proc.once('error', e => failed(new Error(`无法启动 Codex：${e.message}。请先安装 Codex CLI。`)));
    proc.once('exit', code => failed(new Error(`Codex 已退出（${code}）。${stderr.slice(-1200)}`)));
    const result = await this.request('initialize', { clientInfo: { name: 'codex_reader', title: 'Codex Reader', version: '0.9.0' }, capabilities: { experimentalApi: true } });
    this.send({ method: 'initialized', params: {} });
    // Apply a reader-only profile to our threads, leaving desktop/user settings intact.
    this.threadConfig = {'features.apps':false,'features.shell_tool':false,'features.unified_exec':false,'features.multi_agent':false,web_search:'disabled',project_doc_max_bytes:0,'memories.use_memories':false,'memories.generate_memories':false};
    const {config} = await this.request('config/read',{includeLayers:false,cwd:this.cwd});
    for(const group of ['mcp_servers','plugins']) {
      const entries=config?.[group] || {};
      if(Object.keys(entries).some(name=>name.includes('.')))this.threadConfig[group]=Object.fromEntries(Object.entries(entries).map(([name,value])=>[name,{...value,enabled:false}]));
      else for(const name of Object.keys(entries))this.threadConfig[`${group}.${name}.enabled`]=false;
    }
    const account=await this.request('account/read',{refreshToken:false});
    // Reuse native ChatGPT login over HTTPS/SSE. This avoids repeated WebSocket
    // connection timeouts on this machine; it does not create an API-key provider.
    const chatgptBase=(process.env.CODEX_APP_SERVER_CHATGPT_BASE_URL || config?.chatgpt_base_url || 'https://chatgpt.com/backend-api').replace(/\/+$/,'');
    if(account.account?.type==='chatgpt' && (!config?.model_provider || config.model_provider==='openai') && ['https://chatgpt.com/backend-api','https://chatgpt.com/backend-api/codex'].includes(chatgptBase)) {
      this.threadConfig.model_provider='reader_http';
      this.threadConfig.model_providers={...(config?.model_providers||{}),reader_http:{name:'Reader HTTPS',base_url:chatgptBase.endsWith('/codex')?chatgptBase:chatgptBase+'/codex',wire_api:'responses',requires_openai_auth:true,supports_websockets:false}};
    }
    return result;
  }
  send(msg) {
    if (!this.proc || this.proc.stdin.destroyed) throw new Error('Codex 连接已断开，请重新连接。');
    this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }
  request(method, params = {}, timeout = 60000) {
    return new Promise((resolve, reject) => {
      const id = ++this.counter;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex 请求超时：${method}。请检查登录和网络后重试。`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  async status() {
    await this.start();
    const [account, models] = await Promise.all([this.request('account/read', { refreshToken: false }), this.request('model/list', { limit: 100 })]);
    return {
      connected: true, loggedIn: !!account.account, authType: account.account?.type || null,
      models: (models.data || []).filter(m => !m.hidden).map(m => ({ id: m.model, name: m.displayName, isDefault: m.isDefault, image: (m.inputModalities || ['text', 'image']).includes('image'), defaultEffort: m.defaultReasoningEffort, efforts: (m.supportedReasoningEfforts || []).map(e => e.reasoningEffort) })),
    };
  }
  async close() {
    const proc=this.proc;
    if(!proc)return;
    // Wait for this reader's worker to release its conversation writer.
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('问答服务仍在退出，请稍后再次重启。')),10000);
      proc.once('exit',()=>{clearTimeout(timer);resolve();});
      if(proc.exitCode!==null || proc.signalCode!==null){clearTimeout(timer);resolve();}
      else proc.kill();
    });
  }
}
