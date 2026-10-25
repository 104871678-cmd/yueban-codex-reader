import path from 'node:path';

const normalize=value=>path.resolve(value.replace(/^\\\\\?\\/,'')).replace(/[\\/]+$/,'').toLowerCase();
// Only archive persistent sessions in this reader's own temporary directory.
// Archive is reversible; the reader's local messages are never touched here.
export async function archiveReaderHistory(bridge,cwd){
  const ids=new Set(),seen=new Set();let cursor=null;
  do{
    const result=await bridge.request('thread/list',{cwd,modelProviders:['openai','reader_http'],sourceKinds:['cli','vscode','appServer','exec','unknown'],archived:false,limit:100,...(cursor?{cursor}:{})});
    for(const thread of result.data||[])if(typeof thread.id==='string'&&typeof thread.cwd==='string'&&normalize(thread.cwd)===normalize(cwd)&&thread.ephemeral!==true)ids.add(thread.id);
    cursor=result.nextCursor||null;if(cursor&&seen.has(cursor))throw new Error('旧阅读器会话列表分页异常。');if(cursor)seen.add(cursor);
  }while(cursor);
  const failed=[];let archived=0;
  for(const threadId of ids)try{await bridge.request('thread/archive',{threadId});archived++;}catch{failed.push(threadId);}
  return {archived,failed};
}
