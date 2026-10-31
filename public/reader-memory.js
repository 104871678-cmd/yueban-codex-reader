export class ReaderMemoryClient{
  constructor({api,onOpen,onPreferences,canOpen,notify}){Object.assign(this,{api,onOpen,onPreferences,canOpen,notify});this.snapshot={preferences:{},files:[]};this.ready=false;this.pending={};this.saves=Promise.resolve();window.addEventListener('pagehide',()=>this.beacon());}
  async load(){this.snapshot=await this.api('memory');this.onPreferences(this.snapshot.preferences);this.ready=true;this.render();return this.snapshot;}
  preference(delta){if(!this.ready)return;Object.assign(this.snapshot.preferences,delta);Object.assign(this.pending,delta);clearTimeout(this.preferenceTimer);this.preferenceTimer=setTimeout(()=>this.flushPreferences(),100);}
  flushPreferences(){clearTimeout(this.preferenceTimer);const delta=this.pending;this.pending={};if(!Object.keys(delta).length)return;this.saves=this.saves.catch(()=>{}).then(()=>this.api('preferences',delta)).catch(()=>this.notify('设置暂时未能保存，请稍后重试。'));}
  position(file,page){if(!file?.readerEntry||!this.snapshot.files.some(entry=>entry.id===file.readerEntry.id))return;clearTimeout(this.positionTimer);this.pendingPosition={id:file.readerEntry.id,page};this.positionTimer=setTimeout(()=>this.flushPosition(),250);}
  flushPosition(){clearTimeout(this.positionTimer);const body=this.pendingPosition;this.pendingPosition=null;if(body)void this.api('files/page',body).catch(()=>{});}
  beacon(){if(this.ready)navigator.sendBeacon('/api/preferences',new Blob([JSON.stringify(this.snapshot.preferences)],{type:'application/json'}));if(this.pendingPosition)navigator.sendBeacon('/api/files/page',new Blob([JSON.stringify(this.pendingPosition)],{type:'application/json'}));}
  async pick(){
    if(!this.canOpen())return;this.controller?.abort();
    try{const result=await this.api('files/pick',{});if(result.file)await this.open(result.file);}catch(error){this.notify('打开文档失败：'+error.message);}
  }
  async open(entry){
    if(!this.canOpen())return;
    if(typeof entry==='string')entry=this.snapshot.files.find(file=>file.id===entry);if(!entry)return;
    this.controller?.abort();const controller=this.controller=new AbortController();
    try{
      const response=await fetch('/api/files/content?id='+encodeURIComponent(entry.id),{signal:controller.signal});
      if(!response.ok)throw new Error((await response.json()).error||'无法读取文件。');
      const blob=await response.blob();controller.signal.throwIfAborted();
      const file=new File([blob],entry.name,{lastModified:Number(response.headers.get('X-File-Modified'))||Date.now()});
      Object.defineProperty(file,'readerEntry',{value:entry});if(!this.snapshot.files.some(file=>file.id===entry.id))this.snapshot.files.unshift(entry);await this.onOpen(file);
    }catch(error){if(error.name!=='AbortError')this.notify(error.message);}
  }
  async opened(file){if(!file.readerEntry)return;try{const saved=await this.api('files/opened',{id:file.readerEntry.id});this.snapshot={...saved,preferences:{...saved.preferences,...this.snapshot.preferences}};this.render();}catch{this.notify('文档已打开，但最近记录暂未保存。');}}
  render(){
    const container=document.getElementById('recentList');container.replaceChildren();document.getElementById('recentCount').textContent=this.snapshot.files.length;
    if(!this.snapshot.files.length){const empty=document.createElement('p');empty.className='recent-empty';empty.textContent='使用“打开文档”后，自动记住文件和原路径。';container.append(empty);return;}
    for(const file of this.snapshot.files){
      const row=document.createElement('div');row.className='recent-file';
      const open=document.createElement('button');open.type='button';open.className='recent-open';open.title=file.path;
      const name=document.createElement('strong');name.textContent=file.name;const location=document.createElement('small');location.textContent=file.path;open.append(name,location);
      open.onclick=()=>{document.getElementById('appMenu').open=false;void this.open(file);};
      const remove=document.createElement('button');remove.type='button';remove.className='recent-forget';remove.textContent='×';remove.title='移除这条记录，不删除原文件';remove.setAttribute('aria-label','移除 '+file.name+' 的打开记录');
      remove.onclick=async()=>{try{const saved=await this.api('files/forget',{id:file.id});this.snapshot={...saved,preferences:{...saved.preferences,...this.snapshot.preferences}};this.render();}catch(error){this.notify(error.message);}};
      row.append(open,remove);container.append(row);
    }
  }
}
