import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';

export class OcrHost {
  constructor(script){this.script=script;this.pending=new Map();this.sequence=0;}
  start(){
    if(this.ready)return this.ready;
    this.ready=new Promise(resolve=>{
      const proc=this.proc=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',this.script],{windowsHide:true,stdio:['pipe','pipe','ignore']});
      const timer=setTimeout(()=>{resolve({available:false});proc.kill();},15000);
      const fail=()=>{clearTimeout(timer);resolve({available:false});for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('本地文字识别已退出。'));}this.pending.clear();};
      proc.stdin.on('error',()=>{});proc.once('error',fail);proc.once('exit',fail);
      createInterface({input:proc.stdout}).on('line',line=>{
        let value;try{value=JSON.parse(line);}catch{return;}
        if(value.type==='ready'){clearTimeout(timer);resolve(value);return;}
        const pending=this.pending.get(value.id);if(!pending)return;clearTimeout(pending.timer);this.pending.delete(value.id);
        if(value.error)pending.reject(new Error(value.error));else pending.resolve(value.text||'');
      });
    });return this.ready;
  }
  async recognize(path){
    if(!(await this.start()).available)throw new Error('本机文字识别不可用。');
    return new Promise((resolve,reject)=>{
      const id=++this.sequence,timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('扫描页识别超时。'));},45000);
      this.pending.set(id,{resolve,reject,timer});this.proc.stdin.write(JSON.stringify({id,path})+'\n');
    });
  }
  close(){this.proc?.kill();}
}
