'use strict';
// Shared room helper and on-device vocabulary search. No extra network calls per keystroke.
const ROOM_PATTERN=/^[a-f0-9]{32}$/i;
function getQueryRoom() { const room=new URLSearchParams(location.search).get('room')||''; return ROOM_PATTERN.test(room)?room.toLowerCase():null; }
function makeRoom() { const b=new Uint8Array(16);crypto.getRandomValues(b);return Array.from(b,x=>x.toString(16).padStart(2,'0')).join(''); }
function normalizeRu(s) { return String(s||'').toLocaleLowerCase('ru-RU').replace(/ё/g,'е').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-zа-я0-9]+/gi,' ').trim(); }

// Fast on-device vocabulary search. No requests are made while typing.
// The lesson's Russian wording remains authoritative; alternative phrasings
// are suggestions only and should be checked before being sent.
const VOC_STOP_WORDS=new Set(['и','или','а','на','в','во','с','со','к','ко','из','от','до','за','под','над','для','по','при','об','о','у','не','что','это','этот','его','ее','их','как','бы','же','того','те','the','to','of']);
const VOC_SYNONYM_GROUPS=[
 ['данн','информац','сведен','материал'],
 ['компьютер','вычислительн','эвм','машин'],
 ['основн','главн','базов','первичн'],
 ['устройств','прибор','аппарат','оборудован'],
 ['задач','проблем','вопрос'],
 ['реша','решен','ответ'],
 ['выполн','осуществ','провед','исполн'],
 ['включ','содерж','вход','состав'],
 ['хран','сохран','запомин','удерж'],
 ['обработ','переработ','манипулир'],
 ['ввод','ввести','внес','вноси','заноси','подач'],
 ['вывод','вывести','выдач','получен'],
 ['распозна','опозна','узнава','идентифиц'],
 ['определ','установ','выявл'],
 ['преобраз','превращ','конверт'],
 ['представ','изображ','обознач'],
 ['сравн','сопостав'],
 ['цифров','числов','числен'],
 ['последоват','поочеред','по порядк'],
 ['вспомогат','дополнительн','вторичн'],
 ['управлен','контрол','регулир'],
 ['редактирован','изменени','исправлен'],
 ['встроенн','встраива','внедрен'],
 ['сотов','мобильн'],
 ['схем','микросхем','цеп'],
 ['скорост','быстродейств','производительност'],
 ['огранич','замедл','сниж'],
 ['тверд','жестк'],
 ['логическ','логик'],
 ['печатн','плат'],
 ['использован','применени','употреблен'],
 ['взаимодейств','соедин','взаимосвяз'],
 ['источни','исходн','начальн','первоначальн']
];
const VOC_SYNONYMS=new Map();
for(let i=0;i<VOC_SYNONYM_GROUPS.length;i++)for(const root of VOC_SYNONYM_GROUPS[i]){
 const arr=VOC_SYNONYMS.get(root)||[];arr.push(i);VOC_SYNONYMS.set(root,arr);
}
const VOC_INDEX_CACHE=new WeakMap();
const VOC_EXACT_CACHE=new WeakMap();
function searchTokens(normalized){return normalized.split(' ').filter(w=>w.length>1&&!VOC_STOP_WORDS.has(w));}
function indexedDictionary(lexicon){
 let index=VOC_INDEX_CACHE.get(lexicon);
 if(index)return index;
 index=[];
 const exact=new Map();
 for(const entry of lexicon){
  const variants=[{value:entry.ru,source:'main'},...(entry.ruVariants||[]).map(value=>({value,source:'variant'})),...(entry.aliases||[]).map(value=>({value,source:'alias'}))];
  const seen=new Set();
  for(const variant of variants){
   const ru=normalizeRu(variant.value);
   if(!ru||seen.has(ru))continue;
   seen.add(ru);
   const doc={entry,ru,source:variant.source,tokens:searchTokens(ru),en:normalizeRu(entry.en)};
   index.push(doc);
   if(!exact.has(ru))exact.set(ru,[]);
   exact.get(ru).push(doc);
  }
 }
 VOC_INDEX_CACHE.set(lexicon,index);VOC_EXACT_CACHE.set(lexicon,exact);
 return index;
}
function sameConcept(a,b){
 for(const [root,groups] of VOC_SYNONYMS)if(a.startsWith(root)){
  for(const g of groups)if(VOC_SYNONYM_GROUPS[g].some(prefix=>b.startsWith(prefix)))return true;
 }
 return false;
}
// Bounded Damerau-Levenshtein: adjacent transpositions count as one typo.
function wordDistance(a,b,maxDist=2){
 if(Math.abs(a.length-b.length)>maxDist)return maxDist+1;
 const prev2=new Uint16Array(b.length+1),prev=new Uint16Array(b.length+1),cur=new Uint16Array(b.length+1);
 for(let j=0;j<=b.length;j++)prev[j]=j;
 for(let i=1;i<=a.length;i++){
  cur[0]=i;let rowBest=cur[0];
  for(let j=1;j<=b.length;j++){
   let d=Math.min(prev[j]+1,cur[j-1]+1,prev[j-1]+(a[i-1]===b[j-1]?0:1));
   if(i>1&&j>1&&a[i-1]===b[j-2]&&a[i-2]===b[j-1])d=Math.min(d,prev2[j-2]+1);
   cur[j]=d;rowBest=Math.min(rowBest,d);
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
 let prefix=0;while(prefix<min&&a[prefix]===b[prefix])prefix++;
 if(min>=5&&prefix>=min-2&&Math.abs(a.length-b.length)<=4)return 0.84;
 const maxDist=min>=8?2:1;
 if(Math.abs(a.length-b.length)<=maxDist){
  const d=wordDistance(a,b,maxDist);
  if(d===1)return 0.80;
  if(d===2&&maxDist>=2)return 0.66;
 }
 if(sameConcept(a,b))return 0.68;
 return 0;
}
function searchDictionaryDetailed(lexicon,query,limit=7){
 const q=normalizeRu(query);
 if(q.length<2||!Array.isArray(lexicon)||!lexicon.length)return [];
 const index=indexedDictionary(lexicon);
 const exact=VOC_EXACT_CACHE.get(lexicon).get(q);
 if(exact){
  const seen=new Set();
  const ranked=exact.slice().sort((a,b)=>({main:0,variant:1,alias:2}[a.source]-{main:0,variant:1,alias:2}[b.source]));
  return ranked.filter(x=>!seen.has(x.entry.id)&&seen.add(x.entry.id)).slice(0,limit)
   .map(doc=>({entry:doc.entry,kind:doc.source==='alias'?'Синоним':doc.source==='variant'?'Вариант перевода':'Точное совпадение',score:doc.source==='alias'?0.015:0}));
 }
 const qtokens=searchTokens(q);
 const simCache=new Map();
 const sim=(a,b)=>{
  const key=a+'|'+b;
  if(simCache.has(key))return simCache.get(key);
  const value=tokenSimilarity(a,b);simCache.set(key,value);return value;
 };
 const candidates=new Map();
 for(const doc of index){
  let score=Infinity,kind='Похожая формулировка';
  const bias=doc.source==='main'?0:doc.source==='variant'?0.018:0.045;
  if(doc.ru.startsWith(q)){score=0.035+Math.min(0.10,(doc.ru.length-q.length)*0.001)+bias;kind='Начало фразы';}
  else if(doc.ru.includes(q)){score=0.15+bias;kind='Совпадение в тексте';}
  else if(doc.en.includes(q)){score=0.175;kind='По-английски';}
  else if(qtokens.length && doc.tokens.length){
   let strength=0,matched=0,firstMatchIndex=doc.tokens.length;
   for(const qt of qtokens){
    let best=0,bestPos=doc.tokens.length;
    for(let j=0;j<doc.tokens.length;j++){
     const value=sim(qt,doc.tokens[j]);
     if(value>best){best=value;bestPos=j;}
    }
    strength+=best;
    if(best>=0.64){matched++;firstMatchIndex=Math.min(firstMatchIndex,bestPos);}
   }
   const quality=strength/qtokens.length;
   const coverage=matched/qtokens.length;
   if((qtokens.length===1&&coverage===1&&quality>=0.67)||
      (qtokens.length===2&&coverage===1&&quality>=0.65)||
      (qtokens.length>=3&&coverage>=0.67&&quality>=0.57)){
    score=0.245+(1-quality)*0.70+(1-coverage)*0.34+
      Math.min(0.14,Math.max(0,doc.tokens.length-qtokens.length)*0.017)+
      Math.min(0.10,firstMatchIndex*0.012)+bias;
    kind=quality>=0.91&&coverage===1?'Совпадение по словам':'Похожая формулировка';
   }
  }
  if(Number.isFinite(score)){
   const prior=candidates.get(doc.entry.id);
   if(!prior||score<prior.score)candidates.set(doc.entry.id,{entry:doc.entry,kind,score});
  }
 }
 return [...candidates.values()].sort((a,b)=>a.score-b.score||a.entry.ru.length-b.entry.ru.length||a.entry.id-b.entry.id).slice(0,limit);
}
function searchDictionary(lexicon,query,limit=7){return searchDictionaryDetailed(lexicon,query,limit).map(x=>x.entry);}

function setText(id,val){document.getElementById(id).textContent=val;}
function addEl(tag,className,textVal){const el=document.createElement(tag);if(className)el.className=className;if(textVal!==undefined)el.textContent=textVal;return el;}
async function copyText(text,field){
 try { if(navigator.clipboard && window.isSecureContext){await navigator.clipboard.writeText(text);return true;} }
 catch (_){ }
 field.focus();field.select();return document.execCommand('copy');
}
