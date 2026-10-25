import {readFile,writeFile,rename} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

// Native conversation IDs exist only for the lifetime of this reader worker.
// Course text and replayable answers belong to the reader's local data directory.
export class LocalContext {
  constructor(dataDir){this.dataDir=dataDir;this.sessions={};this.prepared={};this.conversations={};this.queue=Promise.resolve();}
  async load(){
    for(const [field,file] of [['prepared','course-context.json'],['conversations','conversation-context.json']]){
      try{const value=JSON.parse(await readFile(path.join(this.dataDir,file),'utf8'));if(value&&typeof value==='object'&&!Array.isArray(value))this[field]=value;}catch{}
    }
  }
  save(file,value){
    const contents=JSON.stringify(value),target=path.join(this.dataDir,file);
    const pending=this.queue.catch(()=>{}).then(async()=>{const temporary=target+'.'+randomUUID()+'.tmp';await writeFile(temporary,contents);await rename(temporary,target);});
    this.queue=pending;return pending;
  }
  resetWorker(){for(const key of Object.keys(this.sessions))delete this.sessions[key];}
  ready(item){return item?.version===1&&item.textPages?.length===item.total&&Array.isArray(item.chunks)&&item.chunks.length>0;}
  async accept(key,preload,text){
    let item=this.prepared[key];
    if(!item||item.total!==preload.total)item=this.prepared[key]={version:1,total:preload.total,textPages:[],imagePages:[],chunks:[],revision:randomUUID()};
    const field=preload.kind==='text'?'textPages':'imagePages';
    item[field]=[...new Set([...item[field],...Array.from({length:preload.end-preload.start+1},(_,i)=>preload.start+i)])].sort((a,b)=>a-b);
    if(preload.kind==='text'){
      const existing=item.chunks.find(c=>c.start===preload.start&&c.end===preload.end);
      if(existing?.text===text)return;
      item.chunks=item.chunks.filter(c=>c.start!==preload.start||c.end!==preload.end);
      item.chunks.push({start:preload.start,end:preload.end,text});item.revision=randomUUID();
    }
    await this.save('course-context.json',this.prepared);
  }
  courseText(item){return [...(item?.chunks||[])].sort((a,b)=>a.start-b.start).map(c=>c.text).join('\n\n');}
  async remember(key,question,answer){
    if(!answer.trim())return;
    const turns=this.conversations[key]||[];
    this.conversations[key]=[...turns,{role:'user',text:question},{role:'assistant',text:answer}].slice(-24);
    this.conversations['last:'+key.split(':').at(-1)]=key;
    await this.save('conversation-context.json',this.conversations);
  }
  async previous(key,documentKey){
    let messages=this.conversations[key];
    if(!messages?.length)try{messages=JSON.parse(await readFile(path.join(this.dataDir,'history',documentKey+'.json'),'utf8'));}catch{}
    return (Array.isArray(messages)?messages:[]).filter(m=>['user','assistant'].includes(m.role)&&typeof m.text==='string').slice(-24).map(m=>`${m.role}: ${m.text}`).join('\n').slice(-48000);
  }
  async clear(documentKey){
    for(const object of [this.sessions,this.conversations])for(const key of Object.keys(object))if(key===documentKey||(key.endsWith(':'+documentKey)&&!key.startsWith('prepare:')))delete object[key];
    await this.save('conversation-context.json',this.conversations);
  }
}
