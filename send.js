'use strict';
const room=getQueryRoom();
const form=document.getElementById('sendForm');
const input=document.getElementById('word');
const submit=document.getElementById('submit');
const suggestions=document.getElementById('suggestions');
let lexicon=[];
let loadingDictionary=true;
let sending=false;

if(!room){
 submit.disabled=true;
 setText('error','Ссылка неполная. Попроси друга скопировать ссылку заново.');
 setText('roomState','Нет комнаты');
 document.getElementById('roomState').classList.add('offline');
}else{
 setText('roomState','Комната готова');
 document.getElementById('roomState').classList.add('live');
}

// Load a small (236-entry) JSON file just once. Suggestions are synchronous and
// local; typing does not add server requests, waits or load to message delivery.
fetch('/dictionary.json')
 .then(r=>{if(!r.ok)throw Error('Нет словаря');return r.json();})
 .then(rows=>{
   lexicon=Array.isArray(rows)?rows:[];
   loadingDictionary=false;
   renderSuggestions();
 })
 .catch(()=>{
   loadingDictionary=false;
   setText('suggestionStatus','Словарь недоступен — обычная отправка работает.');
 });

function clearSuggestions(){suggestions.replaceChildren();}
function renderSuggestions(){
 clearSuggestions();
 const query=input.value.trim();
 if(loadingDictionary){setText('suggestionStatus','Загрузка словаря…');return;}
 if(!lexicon.length){setText('suggestionStatus','Нет словаря. Отправка вручную доступна.');return;}
 if(query.length<2){setText('suggestionStatus','Введи 2–3 буквы, чтобы увидеть варианты.');return;}
 const hits=searchDictionaryDetailed(lexicon,query,6);
 setText('suggestionStatus',hits.length?'Подходящие фразы — нажми, чтобы отправить:':'Похожих слов не найдено. Можно отправить написанное.');
 for(const {entry,kind} of hits){
   const button=document.createElement('button');
   button.type='button';button.className='suggestion-option';button.disabled=sending||!room;
   button.setAttribute('aria-label','Отправить: '+entry.ru+' — '+entry.en);
   const top=addEl('span','suggestion-russian',entry.ru);
   const tag=addEl('span','suggestion-kind',kind);
   const english=addEl('span','suggestion-english',entry.en);
   const pron=addEl('span','suggestion-pron',entry.pron);
   const tags=addEl('span','suggestion-location',(entry.locations||[]).map(loc=>'стр. '+loc.page).filter((x,i,a)=>a.indexOf(x)===i).join(' · '));
   const line=addEl('span','suggestion-line');line.append(top,tag);
   button.append(line,english,pron,tags);
   button.addEventListener('click',()=>sendWord(entry.ru));
   suggestions.append(button);
 }
}

input.addEventListener('input',()=>{
 setText('count',input.value.length+' / 220');
 setText('error','');setText('success','');
 renderSuggestions();
});

// PC shortcut: Enter sends; Shift+Enter inserts a newline.
// On mobile the visible send button and one-tap suggestions remain primary.
input.addEventListener('keydown',e=>{
 if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){
   e.preventDefault();
   if(!sending && input.value.trim())form.requestSubmit();
 }
});
form.addEventListener('submit',e=>{
 e.preventDefault();
 sendWord(input.value.trim());
});

async function sendWord(word){
 if(sending||!room||!word)return;
 // Critical path: one direct HTTP POST using the existing server API.
 // No search, timer, debounce, AI query or additional round-trip occurs here.
 sending=true;submit.disabled=true;
 for(const button of suggestions.children)button.disabled=true;
 setText('error','');setText('success','Отправка…');
 try{
   const response=await fetch('/api/send',{
     method:'POST',headers:{'Content-Type':'application/json'},
     body:JSON.stringify({room,word})
   });
   const data=await response.json();
   if(!response.ok)throw Error(data.error||'Ошибка отправки');
   if(data.delivered>0)setText('success','✓ Отправлено получателю: '+word);
   else setText('success','Получатель не подключён. Сообщение не сохранено.');
   input.value='';setText('count','0 / 220');
   clearSuggestions();
   setText('suggestionStatus','Можно вводить следующее слово.');
   input.focus();
 }catch(e){setText('success','');setText('error','Не удалось отправить: '+e.message);}
 finally{sending=false;submit.disabled=!room; if(input.value.trim())renderSuggestions();}
}
