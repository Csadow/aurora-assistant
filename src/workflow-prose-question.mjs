// A model question can pause, never execute an action or establish completion.
// Preserve the entire reply; do not infer an answer, rewrite or truncate it.
export function proseQuestion(content){
  if(typeof content!=='string')return null;
  const text=content.trim();if(!text||text.length>1000)return null;
  let fence=null,lastQuestion=-1;const lines=text.split('\n');
  for(const [index,line] of lines.entries()){
    const marker=line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if(marker){
      if(!fence)fence={char:marker[1][0],length:marker[1].length};
      else if(marker[1][0]===fence.char&&marker[1].length>=fence.length&&!marker[2].trim())fence=null;
    }else if(!fence&&/[?？]\s*$/.test(line))lastQuestion=index;
  }
  if(fence||lastQuestion<0)return null;
  if(/[?？]$/.test(text))return text;
  const choices=lines.slice(lastQuestion+1).map(line=>line.trim()).filter(Boolean);
  return choices.length>=1&&choices.length<=6&&choices.every(line=>/^[-*]\s+\S|^\d+[.)]\s+\S/.test(line))?text:null;
}
