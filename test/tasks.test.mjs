import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planBatches, exercisePrompt } from '../public/tasks.js';
test('every page including scanned/blank pages belongs to exactly one exercise batch', () => {
  const batches = planBatches(['first', '', '', 'fourth', '', 'sixth', '', 'eighth']);
  const assigned = batches.flatMap(b => Array.from({ length: b.end - b.start + 1 }, (_, i) => b.start + i));
  assert.deepEqual(assigned, [1,2,3,4,5,6,7,8]);
  assert.ok(batches.every(b => b.readStart <= b.start && b.readEnd >= b.end && b.readEnd - b.readStart + 1 <= 5));
  assert.equal(batches[0].readEnd, 4); assert.equal(batches[1].readStart, 3);
});
test('text-heavy pages reduce batch size; prompts identify ownership of cross-page exercises', () => {
  const batches = planBatches(['x'.repeat(15000), 'y'.repeat(15000), 'z'], { maxChars: 24000 });
  assert.equal(batches[0].start, 1); assert.equal(batches[0].end, 1);
  const prompt = exercisePrompt('全部解答', batches[1], 3);
  assert.match(prompt, /不要只给解题提示/); assert.match(prompt, /避免重复/); assert.match(prompt, /不能编造/);
});
import {questionScope,asksAllExercises} from '../public/tasks.js';

test('page wording and shortcuts never start whole-document processing',()=>{
  assert.equal(questionScope('请概括这一页的核心观点，并解释关键术语。','document'),'page');
  assert.equal(questionScope('解释当前页的图','document'),'page');
  assert.equal(questionScope('比较整份文档中的章节','document'),'document');
  assert.equal(questionScope('解释这个词','selection'),'selection');
  assert.equal(questionScope('解答全部习题','page'),'document');
  assert.equal(asksAllExercises('请用容易理解的语言解释这一页'),false);
});
