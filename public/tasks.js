import {referencedPages} from './conversation.js';

export const asksAllExercises = question => /(?:全部|所有|整份|整本|全书)[\s\S]{0,18}(?:习题|练习|题目|例题)|(?:习题|练习|题目)[\s\S]{0,18}(?:全部|所有|都.*(?:解|做|答))/.test(question);

export function questionScope(question, selected) {
  if(asksAllExercises(question))return 'document';
  if(selected !== 'none' && selected !== 'selection' && referencedPages(question).length===1)return 'page';
  if(selected !== 'none' && selected !== 'selection' && /(?:这一页|这页|本页|当前页|这一张|这张幻灯片)/.test(question))return 'page';
  return selected;
}

export function planBatches(pages, { maxPages = 3, maxChars = 24000, overlap = true } = {}) {
  const batches = []; let start = 0;
  while (start < pages.length) {
    let end = start, chars = 0;
    while (end < pages.length && end - start < maxPages) {
      const length = pages[end].length;
      if (end > start && chars + length > maxChars) break;
      chars += length; end++;
    }
    batches.push({ start: start + 1, end, readStart: overlap ? Math.max(1, start) : start + 1, readEnd: overlap ? Math.min(pages.length, end + 1) : end });
    start = end;
  }
  return batches;
}

export function exercisePrompt(question, batch, total) {
  return `任务：解答整份课程文档中的所有习题。用户额外要求：${question}\n整份文件共 ${total} 页，本批负责第 ${batch.start}—${batch.end} 页。相邻页仅用于补全跨页题干。\n逐页检查本批负责页中的全部例题、习题、练习、思考题、选择题及明确要求作答的问题。题目从本批页开始时必须解答；相邻页开始的题目仅作为背景，避免重复。\n按原文题号和 PDF 页码逐题列出：题干概要、已知条件、详细推导或论证、最终答案。多小问逐项回答，不要只给解题提示。保留原文公式符号和单位。即使原文附有答案，也给出过程。\n如果这一批没有习题，请明确写“第 ${batch.start}—${batch.end} 页未发现习题”。若题干、图片或条件不清楚，明确标出页码及缺失信息，不能编造。若一道题没有在相邻页结束，标出需要更多后续页。\n这是整份文档的自动分批任务，不要要求用户逐题输入，不要声称已处理本批以外的题目。`;
}

export function reviewPrompt(question, batch, total) {
  return `正在研读整份文档以回答用户问题：${question}\n文档共 ${total} 页，本批为第 ${batch.start}—${batch.end} 页。\n仔细检查本批的全部文字及所附图片，提取与用户问题相关的事实、计算、论点和证据，并标出 PDF 页码。保留回答所需的题干、公式、数字和条件。不要提前给整份文件的最终答案，不要以本批代替全文。若完全无相关信息，明确写“本批无相关信息”。结果尽量简洁，但不得遗漏相关事实。`;
}
