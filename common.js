'use strict';
// Shared room helper: no changes to the server-side message transport.
const ROOM_PATTERN=/^[a-f0-9]{32}$/i;
function getQueryRoom() { const room=new URLSearchParams(location.search).get('room')||''; return ROOM_PATTERN.test(room)?room.toLowerCase():null; }
function makeRoom() { const b=new Uint8Array(16);crypto.getRandomValues(b);return Array.from(b,x=>x.toString(16).padStart(2,'0')).join(''); }
function normalizeRu(s) { return String(s||'').toLocaleLowerCase('ru-RU').replace(/ё/g,'е').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-zа-я0-9]+/gi,' ').trim(); }

// A tiny local search engine for the 236 vocabulary entries. No network request
// is made on each keystroke: the complete dictionary is fetched just once.
const VOC_STOP_WORDS=new Set(['и','или','а','на','в','во','с','со','к','ко','из','от','до','за','под','над','для','по','при','об','о','у','не','это','этот','его','ее','их','the','to','of']);
const VOC_SYNONYM_GROUPS=[
 ['данн','информац','сведен'],['компьютер','эвм'],['основн','главн','базов'],
 ['устройств','прибор','аппарат'],['сложн','запутан','комплексн'],
 ['работ','задач','задани'],['быстр','скорост'],['помог','помощ','содейств','способств'],
 ['решен','реша','ответ'],['систем','структур'],['обработ','переработ'],
 ['хран','сохран'],['создан','разработ','изготов'],['появлен','возникнов'],
 ['соедин','связ','коммуникац'],['сборк','собир','монтаж'],
 ['использован','применен','употреблен'],['увелич','повыш','рост'],
 ['сниж','уменьш','сокращ'],['сеть','сет'],['электрическ','электронн'],
 ['вычисл','расчет','рассчит','счита']
];
const VOC_SYNONYMS=new Map();
for(let i=0;i<VOC_SYNONYM_GROUPS.length;i++)for(const prefix of VOC_SYNONYM_GROUPS[i]){
 const groups=VOC_SYNONYMS.get(prefix)||[];groups.push(i);VOC_SYNONYMS.set(prefix,groups);
}
const VOC_INDEX_CACHE=new WeakMap();
const VOC_EXACT_CACHE=new WeakMap();
function searchTokens(normalized){return normalized.split(' ').filter(w=>w.length>1&&!VOC_STOP_WORDS.has(w));}
function indexedDictionary(lexicon){
 let idx=VOC_INDEX_CACHE.get(lexicon);
 if(!idx){
  idx=lexicon.map(entry=>{const ru=normalizeRu(entry.ru);return {entry,ru,tokens:searchTokens(ru),en:normalizeRu(entry.en)};});
  const exact=new Map();
  for(const doc of idx){if(!exact.has(doc.ru))exact.set(doc.ru,[]);exact.get(doc.ru).push(doc);}
  VOC_INDEX_CACHE.set(lexicon,idx);VOC_EXACT_CACHE.set(lexicon,exact);
 }
 return idx;
}
function sameConcept(a,b){
 for(const [root,groups] of VOC_SYNONYMS)if(a.startsWith(root)){
  for(const g of groups)if(VOC_SYNONYM_GROUPS[g].some(prefix=>b.startsWith(prefix)))return true;
 }
 return false;
}
// Fast distance limited to short words and to likely typos; adjacent swaps count as one.
function wordDistance(a,b,maxDist=2){
 if(Math.abs(a.length-b.length)>maxDist)return maxDist+1;
 const prev2=new Uint16Array(b.length+1),prev=new Uint16Array(b.length+1),cur=new Uint16Array(b.length+1);
 for(let j=0;j<=b.length;j++)prev[j]=j;
 for(let i=1;i<=a.length;i++){
  cur[0]=i;let rowBest=cur[0];
  for(let j=1;j<=b.length;j++){
   let d=Math.min(prev[j]+1,cur[j-1]+1,prev[j-1]+(a[i-1]===b[j-1]?0:1));
   if(i>1&&j>1&&a[i-1]===b[j-2]&&a[i-2]===b[j-1])d=Math.min(d,prev2[j-2]+1);
   cur[j]=d;if(d<rowBest)rowBest=d;
  }
  if(rowBest>maxDist)return maxDist+1;
  prev2.set(prev);prev.set(cur);
 }
 return prev[b.length];
}
function tokenSimilarity(a,b){
 if(a===b)return 1;
 const min=Math.min(a.length,b.length);
 if(min<3)return 0;
 if(b.startsWith(a))return min>=4?0.94:0.88;
 if(a.startsWith(b))return a.length-b.length<=3?0.88:0;
 // Inflections: схема / схему, обработка / обрабатывать.
 let prefix=0;while(prefix<min&&a[prefix]===b[prefix])prefix++;
 if(min>=5&&prefix>=min-2&&Math.abs(a.length-b.length)<=4)return 0.85;
 const maxDist=min>=8?2:1;
 if(Math.abs(a.length-b.length)<=maxDist){
  const d=wordDistance(a,b,maxDist);
  if(d===1)return 0.81;
  if(d===2&&maxDist>=2)return 0.69;
 }
 if(sameConcept(a,b))return 0.68;
 return 0;
}
// Rich results are used by sender for an honest "похоже" indicator.
function searchDictionaryDetailed(lexicon,query,limit=7){
 const q=normalizeRu(query);
 if(q.length<2||!Array.isArray(lexicon)||!lexicon.length)return [];
 const index=indexedDictionary(lexicon);
 const exact=VOC_EXACT_CACHE.get(lexicon).get(q);
 if(exact)return exact.slice(0,limit).map(x=>({entry:x.entry,kind:'Точное совпадение',score:0}));
 const qt=searchTokens(q);
 const tokenCache=new Map();
 const sim=(a,b)=>{
  const k=a+'|'+b;
  if(tokenCache.has(k))return tokenCache.get(k);
  const v=tokenSimilarity(a,b);tokenCache.set(k,v);return v;
 };
 const candidates=[];
 for(const doc of index){
  let score=Infinity,kind='Похоже';
  if(doc.ru===q){score=0;kind='Точное совпадение';}
  else if(doc.ru.startsWith(q)){score=0.04+Math.min(0.1,(doc.ru.length-q.length)*0.001);kind='Начало фразы';}
  else if(doc.ru.includes(q)){score=0.16;kind='Совпадение в тексте';}
  else if(doc.en.includes(q)){score=0.19;kind='По-английски';}
  else if(qt.length && doc.tokens.length){
   let strength=0,matched=0,firstMatchIndex=doc.tokens.length;
   for(const word of qt){
    let best=0,bestPos=doc.tokens.length;
    for(let j=0;j<doc.tokens.length;j++){
     const v=sim(word,doc.tokens[j]);
     if(v>best){best=v;bestPos=j;}
    }
    strength+=best;
    if(best>=0.64){matched++;firstMatchIndex=Math.min(firstMatchIndex,bestPos);}
   }
   const quality=strength/qt.length;
   const coverage=matched/qt.length;
   if((qt.length===1&&coverage===1&&quality>=0.68)||
      (qt.length===2&&coverage===1&&quality>=0.66)||
      (qt.length>=3&&coverage>=0.66&&quality>=0.55)){
     score=0.27+(1-quality)*0.72+(1-coverage)*0.33+
      Math.min(0.14,Math.max(0,doc.tokens.length-qt.length)*0.017)+
      Math.min(0.10,firstMatchIndex*0.012);
     kind=quality>=0.91&&coverage===1?'Совпадение по словам':'Похожая формулировка';
   }
  }
  if(Number.isFinite(score))candidates.push({entry:doc.entry,kind,score});
 }
 return candidates.sort((a,b)=>a.score-b.score||a.entry.ru.length-b.entry.ru.length||a.entry.id-b.entry.id).slice(0,limit);
}
function searchDictionary(lexicon,query,limit=7){return searchDictionaryDetailed(lexicon,query,limit).map(x=>x.entry);}
function setText(id,val){document.getElementById(id).textContent=val;}
function addEl(tag,className,textVal){const el=document.createElement(tag);if(className)el.className=className;if(textVal!==undefined)el.textContent=textVal;return el;}
async function copyText(text,field){
 try { if(navigator.clipboard && window.isSecureContext){await navigator.clipboard.writeText(text);return true;} }
 catch (_){ }
 field.focus();field.select();return document.execCommand('copy');
}
