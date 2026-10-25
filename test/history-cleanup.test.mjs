import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {archiveReaderHistory} from '../lib/history-cleanup.mjs';

test('archives only persistent threads in the exact reader directory, after collecting every page',async()=>{
  const cwd=path.resolve('reader-test/data/tmp'),calls=[];
  const bridge={async request(method,params){
    calls.push({method,params});
    if(method==='thread/list')return params.cursor?{data:[{id:'own-2',cwd}],nextCursor:null}:{data:[{id:'own-1',cwd},{id:'foreign',cwd:path.resolve('other-project')},{id:'nested',cwd:path.join(cwd,'other')},{id:'private',cwd,ephemeral:true}],nextCursor:'page-2'};
    if(params.threadId==='own-2')throw new Error('still in use');
    return {};
  }};
  assert.deepEqual(await archiveReaderHistory(bridge,cwd),{archived:1,failed:['own-2']});
  assert.deepEqual(calls.map(c=>c.method),['thread/list','thread/list','thread/archive','thread/archive']);
  assert.deepEqual(calls.filter(c=>c.method==='thread/archive').map(c=>c.params.threadId),['own-1','own-2']);
  assert.ok(calls.every(c=>c.method!=='thread/delete'));
});
