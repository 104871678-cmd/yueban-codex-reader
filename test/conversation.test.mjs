import {test} from 'node:test';
import assert from 'node:assert/strict';
import {referencedPages,normalizeConversation} from '../public/conversation.js';
import {questionScope} from '../public/tasks.js';

test('explicit Arabic and Chinese page references resolve the intended page',()=>{
  assert.deepEqual(referencedPages('给我解释第十页'),[10]);
  assert.deepEqual(referencedPages('第 10 页和第十一页比较'),[10,11]);
  assert.deepEqual(referencedPages('第两百零三页'),[203]);
  assert.equal(questionScope('解释第十页中的公式','document'),'page');
  assert.equal(questionScope('比较第十页和第二十页','document'),'document');
});

test('legacy conversations gain stable question IDs and answer links; follow-up roots remain intact',()=>{
  const messages=[{role:'user',text:'讲解第十页',context:'第 10 页 · 附图'},{role:'assistant',text:'讲解内容'}];
  normalizeConversation(messages);const first=messages[0].id;
  assert.equal(messages[0].page,10);assert.equal(messages[0].number,1);assert.equal(messages[1].questionId,first);
  messages.push({role:'user',text:'为什么？',rootId:first},{role:'assistant',text:'推导'});
  normalizeConversation(messages);assert.equal(messages[0].id,first);assert.equal(messages[2].number,2);assert.equal(messages[3].rootId,first);
});
