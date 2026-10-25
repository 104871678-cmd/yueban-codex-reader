import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {PresentationHost} from '../lib/presentation.mjs';

async function fixture(t,count=6) {
  const directory=await mkdtemp(path.join(os.tmpdir(),'reader-background-'));
  const proc=new EventEmitter(),commands=[];
  proc.stdout=new PassThrough();proc.stderr=new PassThrough();
  proc.stdin=new Writable({write(chunk,encoding,done){
    for(const line of chunk.toString().trim().split('\n')) {
      const command=JSON.parse(line);
      if(command.method==='close') queueMicrotask(()=>proc.emit('exit',0));
      else commands.push(command);
    }
    done();
  }});
  proc.kill=()=>proc.emit('exit',1);
  const emit=value=>proc.stdout.write(JSON.stringify(value)+'\n');
  const host=new PresentationHost('unused.ps1','source.pptx',directory,{spawnProcess:()=>proc});
  t.after(async()=>{await host.close();await rm(directory,{recursive:true,force:true});});
  const started=host.start();emit({type:'ready',count,width:720,height:540});await started;
  const wait=async predicate=>{for(let i=0;i<200;i++){if(predicate())return;await delay(5);}assert.fail('background renderer did not progress');};
  const finish=page=>{const command=commands.find(c=>c.page===page);assert.ok(command);emit({id:command.id,page});};
  return {host,commands,wait,finish};
}

test('first page returns before the rest; every remaining slide renders without navigation',async t=>{
  const {host,commands,wait,finish}=await fixture(t);
  assert.equal(host.info.count,6);assert.equal(commands.length,0);
  for(let page=2;page<=6;page++){await wait(()=>commands.some(c=>c.page===page));finish(page);}
  await host.background;
  assert.deepEqual(commands.map(c=>c.page),[2,3,4,5,6]);
  await host.getPage(5);assert.equal(commands.length,5);
});

test('requested slides take priority, duplicate requests reuse work, closing stops background rendering',async t=>{
  const {host,commands,wait,finish}=await fixture(t);
  await wait(()=>commands.length===1);assert.equal(commands[0].page,2);
  const requested=host.getPage(6),duplicate=host.getPage(6);assert.equal(requested,duplicate);
  await wait(()=>commands.length===2);finish(2);await delay(20);
  assert.deepEqual(commands.map(c=>c.page),[2,6]);
  finish(6);await requested;await wait(()=>commands.some(c=>c.page===3));
  await host.close();await host.background;
  assert.deepEqual(commands.map(c=>c.page),[2,6,3]);
  await assert.rejects(host.getPage(4),/已关闭/);
});
