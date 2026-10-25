const digits={零:0,〇:0,一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};
function pageNumber(value) {
  if(/^\d+$/.test(value))return Number(value);
  if(!/[十百千]/.test(value))return Number([...value].map(x=>digits[x]).join(''));
  let result=0,current=0;
  for(const c of value){if(c in digits)current=digits[c];else{result+=(current||1)*({十:10,百:100,千:1000}[c]||0);current=0;}}
  return result+current;
}
export function referencedPages(question) {
  return [...new Set([...question.matchAll(/第\s*([0-9零〇一二两三四五六七八九十百千]+)\s*[页张]/g)].map(m=>pageNumber(m[1])))];
}
export const messageId=()=> 'm-'+crypto.randomUUID();
export function normalizeConversation(messages) {
  let question=null,count=0;const ids=new Set();
  for(const m of messages) {
    if(!/^m-[a-f0-9-]{36}$/.test(m.id||'')||ids.has(m.id))m.id=messageId();ids.add(m.id);
    if(m.role==='user') {
      m.number=++count;
      if(!m.page){const page=m.context?.match(/第\s*(\d+)\s*页/);if(page)m.page=Number(page[1]);}
      m.rootId ||= m.id;question=m;
    } else if(question) {m.questionId ||= question.id;m.rootId ||= question.rootId;m.page ||= question.page;}
  }
  const questions=new Map(messages.filter(m=>m.role==='user').map(m=>[m.id,m]));
  for(const m of messages)if(!questions.has(m.rootId))m.rootId=m.role==='user'?m.id:m.questionId;
  return messages;
}
