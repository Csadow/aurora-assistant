// A model question can pause, never execute an action or establish completion.
// Preserve the entire reply; do not infer an answer, rewrite or truncate it.
export function proseQuestion(content){
  if(typeof content!=='string')return null;
  const text=content.trim();if(!text||text.length>1000||!/[?？]$/.test(text))return null;
  let fence=null;
  for(const line of text.split('\n')){
    const marker=line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if(!marker)continue;
    if(!fence)fence={char:marker[1][0],length:marker[1].length};
    else if(marker[1][0]===fence.char&&marker[1].length>=fence.length&&!marker[2].trim())fence=null;
  }
  return fence?null:text;
}
