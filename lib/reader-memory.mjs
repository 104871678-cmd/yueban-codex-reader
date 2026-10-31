import {readFile,writeFile,rename,realpath,stat} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export class ReaderMemory{
  constructor(directory){this.file=path.join(directory,'reader-memory.json');this.data={version:1,preferences:{},files:[],lastFileId:null};this.queue=Promise.resolve();}
  async load(){try{const saved=JSON.parse(await readFile(this.file,'utf8'));if(saved.version===1&&saved.preferences&&Array.isArray(saved.files)){this.data=saved;this.data.files=saved.files.filter(file=>typeof file.id==='string'&&typeof file.path==='string'&&path.isAbsolute(file.path)).slice(0,20);}}catch{}return this;}
  snapshot(){return structuredClone(this.data);}
  save(){const text=JSON.stringify(this.data),temporary=this.file+'.'+randomUUID()+'.tmp';const task=this.queue.catch(()=>{}).then(async()=>{await writeFile(temporary,text);await rename(temporary,this.file);});this.queue=task;return task;}
  async preferences(input){
    if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('设置无效。');
    const rules={theme:value=>['light','dark'].includes(value),chatCollapsed:value=>typeof value==='boolean',readingMode:value=>['single','continuous'].includes(value),answerZoom:value=>Number.isFinite(value)&&value>=.7&&value<=2.5,chatWidth:value=>Number.isFinite(value)&&value>=330&&value<=2400};
    for(const [key,value] of Object.entries(input)){if(!rules[key]?.(value))throw new Error('设置无效：'+key);}
    Object.assign(this.data.preferences,input);await this.save();return this.snapshot();
  }
  async register(selected){
    if(typeof selected!=='string'||!path.isAbsolute(selected))throw new Error('请选择本机文件。');
    const actual=await realpath(selected);await this.check(actual);
    let file=this.data.files.find(file=>process.platform==='win32'?file.path.toLowerCase()===actual.toLowerCase():file.path===actual);
    if(!file){file={id:randomUUID(),path:actual,name:path.basename(actual),page:1};this.data.files.unshift(file);this.data.files=this.data.files.slice(0,20);await this.save();}
    return structuredClone(file);
  }
  async check(file){
    if(!/\.(pdf|pptx?|html?)$/i.test(file))throw new Error('请选择 PDF、PPT、PPTX 或 HTML 文件。');
    const info=await stat(file).catch(()=>{throw new Error('找不到原文件，可能已移动或删除，请重新打开文档选择。');});
    if(!info.isFile())throw new Error('这不是可读取的文件。');
    if(info.size>100*1024*1024)throw new Error('文件超过 100 MB，请拆分后打开。');return info;
  }
  entry(id){const file=this.data.files.find(file=>file.id===id);if(!file)throw new Error('最近打开记录不存在，请重新选择文件。');return file;}
  async content(id){const file=this.entry(id),info=await this.check(file.path);return {file:structuredClone(file),info};}
  async opened(id){const file=this.entry(id);file.openedAt=new Date().toISOString();this.data.files=[file,...this.data.files.filter(item=>item!==file)];this.data.lastFileId=id;await this.save();return this.snapshot();}
  async page(id,page){if(!Number.isInteger(page)||page<1||page>20000)throw new Error('阅读位置无效。');this.entry(id).page=page;await this.save();}
  async forget(id){this.data.files=this.data.files.filter(file=>file.id!==id);if(this.data.lastFileId===id)this.data.lastFileId=null;await this.save();return this.snapshot();}
}
