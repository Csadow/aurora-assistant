import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
const fallback={surface:'#17171c',surface_container_lowest:'#111115',surface_container_low:'#1d1d23',surface_container:'#222229',surface_container_high:'#2a2a33',surface_container_highest:'#33333d',on_surface:'#e3e1e9',on_surface_variant:'#adabb8',outline_variant:'#37363f',primary:'#c9b9ef',on_primary:'#312544',primary_container:'#423653',error:'#ffb4ab'};
const validColor=value=>typeof value==='string'&&/^#[\da-f]{6}$/i.test(value);
const validFont=value=>typeof value==='string'&&/^[\p{L}\p{N} _-]{1,80}$/u.test(value);
export async function linuxTheme(home=homedir()){
  const palette={...fallback};let name='Aurora dark',font='Inter',mono='JetBrains Mono';
  try{const generated=JSON.parse(await readFile(join(home,'.local/state/quickshell/user/generated/colors.json'),'utf8'));if(validColor(generated.surface)&&validColor(generated.on_surface)){for(const key of Object.keys(fallback))if(validColor(generated[key]))palette[key]=generated[key];name='Linux · Illogical Impulse';}}catch{}
  try{const settings=JSON.parse(await readFile(join(home,'.config/illogical-impulse/config.json'),'utf8'));if(validFont(settings.appearance?.fonts?.main))font=settings.appearance.fonts.main;if(validFont(settings.appearance?.fonts?.monospace))mono=settings.appearance.fonts.monospace;}catch{}
  const rgb=palette.surface.slice(1).match(/../g).map(s=>parseInt(s,16));const scheme=(rgb[0]*0.299+rgb[1]*0.587+rgb[2]*0.114)>150?'light':'dark';
  const variables={'--bg':palette.surface,'--rail':palette.surface_container_lowest,'--sidebar':palette.surface_container_low,'--panel':palette.surface_container_low,'--raised':palette.surface_container,'--hover':palette.surface_container_high,'--selected':palette.surface_container_highest,'--text':palette.on_surface,'--muted':palette.on_surface_variant,'--border':palette.outline_variant,'--accent':palette.primary,'--on-accent':palette.on_primary,'--accent-container':palette.primary_container,'--danger':palette.error};
  const css=`:root{color-scheme:${scheme};${Object.entries(variables).map(([k,v])=>`${k}:${v}`).join(';')};--font-ui:${JSON.stringify(font)},Inter,system-ui,sans-serif;--font-mono:${JSON.stringify(mono)},"JetBrains Mono",ui-monospace,monospace;}`;
  return {name,scheme,variables,font,mono,css,revision:createHash('sha256').update(css).digest('hex').slice(0,12)};
}
