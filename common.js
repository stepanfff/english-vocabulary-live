'use strict';
// Shared room helper: an unguessable room is a bearer secret, not an account/login.
const ROOM_PATTERN=/^[a-f0-9]{32}$/i;
function getQueryRoom() { const room=new URLSearchParams(location.search).get('room')||''; return ROOM_PATTERN.test(room)?room.toLowerCase():null; }
function makeRoom() { const b=new Uint8Array(16);crypto.getRandomValues(b);return Array.from(b,x=>x.toString(16).padStart(2,'0')).join(''); }
function normalizeRu(s) { return String(s||'').toLocaleLowerCase('ru-RU').replace(/ё/g,'е').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-zа-я0-9]+/gi,' ').trim(); }
function searchDictionary(lexicon,query,limit=7) {
 const q=normalizeRu(query); if(!q) return [];
 return lexicon.map(entry=>{
   const ru=normalizeRu(entry.ru),en=entry.en.toLowerCase();
   let rank=100;
   if(ru===q)rank=0;
   else if(ru.startsWith(q))rank=1;
   else if(ru.includes(q))rank=2;
   else if(q.length>=5 && q.startsWith(ru))rank=3;
   else if(en.includes(q))rank=4;
   return {entry,rank};
 }).filter(x=>x.rank<100).sort((a,b)=>a.rank-b.rank||a.entry.ru.length-b.entry.ru.length).slice(0,limit).map(x=>x.entry);
}
function setText(id,val){document.getElementById(id).textContent=val;}
function addEl(tag,className,textVal){const el=document.createElement(tag);if(className)el.className=className;if(textVal!==undefined)el.textContent=textVal;return el;}
async function copyText(text,field){
 try { if(navigator.clipboard && window.isSecureContext){await navigator.clipboard.writeText(text);return true;} }
 catch (_){}
 field.focus();field.select();return document.execCommand('copy');
}
