import {dirname,resolve} from 'node:path';

export const localLinkTarget=text=>{
  const target=(/^\]\(([^)\r\n]+)\)$/.exec(text)||/^\[[^\]\r\n]+\]\(([^)\r\n]+)\)$/.exec(text))?.[1];
  return target&&/^[\p{L}\p{N}_./-]+$/u.test(target)?target:null;
};
export function linkedSources(rule){
  return [...new Set((rule.requiredText||[]).map(localLinkTarget).filter(Boolean).map(target=>resolve(dirname(rule.path),target)))];
}
