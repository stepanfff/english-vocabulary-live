'use strict';
// All vocabulary suggestions are computed locally. The server is called ONLY
// when joining/leaving/switching rooms, or sending a message.
const $=id=>document.getElementById(id);
let chosenRole=null;
let session=null;
let channel=null;
let lexicon=[];
let sending=false;
let changing=false;
let connected=false;
let lastSync=0;
let historyItems=[];
let seenIds=new Set();
let latestMessage=null;
let alertMessage=null;
let alertQueue=[];
let chosenMatches=new Map();
let soundEnabled=false;
const speechOkay='speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
let fullscreenEnabled=true;
try{const saved=localStorage.getItem('ec_fullscreen_v2');if(saved!==null)fullscreenEnabled=saved==='true';}catch(_){}

function text(id,v){const el=$(id);if(el)el.textContent=v==null?'':String(v);}
function show(id,yes){$(id).classList.toggle('hidden',!yes);}
function toast(message,kind=''){
  const el=document.createElement('div');el.className='toast '+kind;el.textContent=message;
  $('toastArea').prepend(el);setTimeout(()=>{if(el.isConnected)el.remove();},4400);
  while($('toastArea').children.length>3)$('toastArea').lastChild.remove();
}
function net(on,label){
  connected=!!on;
  $('networkPill').className='network-pill '+(on?'online':navigator.onLine?'offline':'offline');
  text('networkText',label||(on?'На связи':'Переподключение'));
}
async function api(url,body){
  const response=await fetch(url,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw Error(data.error||'Не удалось выполнить запрос');
  return data;
}
function setRoleChoice(role){
  chosenRole=role;
  for(const button of document.querySelectorAll('[data-role]')){
    button.setAttribute('aria-pressed',String(button.dataset.role===role));
  }
  $('createRoom').disabled=false;
  updateJoinButton();
  text('lobbyError','');
}
function updateJoinButton(){
  const digits=$('joinCode').value.replace(/\D/g,'').slice(0,6);
  if(digits!==$('joinCode').value)$('joinCode').value=digits;
  $('joinRoom').disabled=!chosenRole||digits.length!==6;
}
for(const btn of document.querySelectorAll('[data-role]'))btn.addEventListener('click',()=>setRoleChoice(btn.dataset.role));
$('joinCode').addEventListener('input',updateJoinButton);
$('createRoom').addEventListener('click',async()=>{
  if(!chosenRole)return;
  $('createRoom').disabled=true; text('lobbyError','');
  try{const data=await api('/api/rooms/create',{role:chosenRole});enterSession(data);}
  catch(e){text('lobbyError',e.message);toast(e.message,'error');}
  finally{$('createRoom').disabled=false;}
});
$('joinForm').addEventListener('submit',async e=>{
  e.preventDefault();if(!chosenRole)return;
  const code=$('joinCode').value;
  if(!/^\d{6}$/.test(code))return;
  $('joinRoom').disabled=true;text('lobbyError','');
  try{const data=await api('/api/rooms/join',{code,role:chosenRole});enterSession(data);}
  catch(e){text('lobbyError',e.message);toast(e.message,'error');}
  finally{updateJoinButton();}
});

function displayRole(){
  if(!session)return;
  const receiver=session.role==='receiver';
  text('myRole',receiver?'↓ Получатель':'↗ Отправитель');
  text('sessionTitle',receiver?'Твои ответы.':'Быстрая отправка.');
  text('sessionSubtitle',receiver?'Новые слова появляются без перезагрузки.':'Находи фразы и отправляй в одно нажатие.');
  show('receiverView',receiver);show('senderView',!receiver);
  if(!receiver){closeAlert(true);setTimeout(()=>{$('word').focus({preventScroll:true});},50);}
  updatePresence();
}
function updatePresence(){
  if(!session)return;
  const peer=$('peerState');
  if(!session.peerJoined){peer.textContent='○ Ожидаем второго участника';peer.className='peer-pill';}
  else if(session.peerOnline){peer.textContent='● Друг онлайн';peer.className='peer-pill online';}
  else{peer.textContent='○ Друг временно не в сети';peer.className='peer-pill';}
}
function enterSession(data){
  const newRoom=!session || data.code!==session.code;
  session={...data};
  show('welcome',false);show('session',true);show('bootError',false);
  text('roomCode',data.code.slice(0,3)+' '+data.code.slice(3));
  text('sessionError','');
  if(newRoom){
    historyItems=[];seenIds=new Set();latestMessage=null;
    chosenMatches.clear();
    try{
      const cache=JSON.parse(localStorage.getItem('ec_seen_'+data.code)||'[]');
      if(Array.isArray(cache))seenIds=new Set(cache.slice(-100));
    }catch(_){}
  }
  displayRole();
  applyHistory(data.messages||[],true);
  beginStream();
}
function returnLobby(message){
  if(channel){channel.close();channel=null;}
  session=null;historyItems=[];latestMessage=null;alertQueue=[];
  closeAlert(true);
  show('session',false);show('welcome',true);net(true,'Сайт доступен');
  if(message){text('lobbyError',message);toast(message,'warn');}
}
async function restore(){
  try{
    const r=await fetch('/api/session',{credentials:'same-origin',cache:'no-store'});
    const data=await r.json();
    net(true,'Сайт доступен');
    if(data.active)enterSession(data);
    else{show('welcome',true);show('session',false);}
  }catch(_){
    show('welcome',true);
    net(false,'Нет соединения');
    text('lobbyError','Не удаётся связаться с сервером. Проверь интернет и обнови страницу.');
  }
}
function beginStream(){
  if(!session)return;
  if(channel){channel.close();channel=null;}
  net(false,'Соединяем комнату…');
  const stream=new EventSource('/events',{withCredentials:true});channel=stream;
  stream.addEventListener('sync',evt=>{
    if(channel!==stream)return;
    let data;try{data=JSON.parse(evt.data);}catch(_){return;}
    if(!session || data.code!==session.code)return;
    net(true,'В реальном времени');
    session={...session,...data};
    text('roomCode',data.code.slice(0,3)+' '+data.code.slice(3));
    displayRole();
    applyHistory(data.messages||[],true);
  });
  stream.addEventListener('presence',evt=>{
    if(channel!==stream||!session)return;
    try{const p=JSON.parse(evt.data);session.peerJoined=!!p.peerJoined;session.peerOnline=!!p.peerOnline;updatePresence();}catch(_){}
  });
  stream.addEventListener('role',evt=>{
    if(channel!==stream||!session)return;
    try{
      const role=JSON.parse(evt.data).role;
      if(role && role!==session.role){session.role=role;displayRole();toast(role==='sender'?'Теперь ты отправитель':'Теперь ты получатель');}
    }catch(_){}
  });
  stream.addEventListener('message',evt=>{
    if(channel!==stream||!session)return;
    try{const msg=JSON.parse(evt.data);if(!msg?.id||seenIds.has(msg.id))return;
      if(session.role==='receiver')receiveOne(msg,true);
      else{markSeen(msg.id);historyItems.unshift(msg);renderHistory();}
    }catch(_){}
  });
  stream.addEventListener('expired',()=>returnLobby('Время комнаты истекло. Создай новую комнату.'));
  stream.addEventListener('error',()=>{
    if(channel!==stream)return;
    net(false,navigator.onLine?'Переподключаемся…':'Нет интернета');
    // EventSource reconnects on its own. When the page is visible we also
    // request a snapshot, to catch messages sent while the phone slept.
  });
}
async function resync(){
  if(!session||document.visibilityState!=='visible')return;
  if(Date.now()-lastSync<1400)return;
  lastSync=Date.now();
  try{
    const r=await fetch('/api/session',{credentials:'same-origin',cache:'no-store'});
    const data=await r.json();
    if(!data.active){returnLobby('Комната больше недоступна. Создай новую.');return;}
    const switched=data.role!==session.role;
    session={...session,...data};
    if(switched)displayRole();else updatePresence();
    applyHistory(data.messages||[],true);
    if(!channel || channel.readyState!==EventSource.OPEN)beginStream();
  }catch(_){net(false,'Переподключаемся…');}
}
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')resync();});
window.addEventListener('pageshow',e=>{if(e.persisted)resync();});
window.addEventListener('online',()=>{if(session)resync();else restore();});
window.addEventListener('offline',()=>net(false,'Нет интернета'));
// Free Render: when actively using the page, send an incoming ping occasionally.
setInterval(()=>{if(document.visibilityState==='visible')fetch('/healthz',{cache:'no-store'}).catch(()=>{});},3*60*1000);

$('swapRoles').addEventListener('click',async()=>{
  if(!session||changing)return;
  const next=session.role==='sender'?'получателем':'отправителем';
  if(!window.confirm('Вы оба поменяетесь ролями. Ты станешь '+next+'. Продолжить?'))return;
  changing=true;$('swapRoles').disabled=true;
  try{
    const result=await api('/api/rooms/swap',{});
    if(session){session={...session,...result};displayRole();toast('Роли поменялись на обоих телефонах');}
  }catch(e){toast(e.message,'error');}
  finally{changing=false;$('swapRoles').disabled=false;}
});
$('leaveRoom').addEventListener('click',async()=>{
  if(!session||!window.confirm('Выйти из комнаты? Для повторного входа понадобится код.'))return;
  try{await api('/api/rooms/leave',{});returnLobby();toast('Ты вышел из комнаты');}
  catch(e){toast(e.message,'error');}
});
$('copyCode').addEventListener('click',async()=>{
  if(!session)return;
  try{
    if(navigator.clipboard&&window.isSecureContext)await navigator.clipboard.writeText(session.code);
    else{const el=document.createElement('textarea');el.value=session.code;document.body.appendChild(el);el.select();document.execCommand('copy');el.remove();}
    toast('Код скопирован: '+session.code);
  }catch(_){toast('Назови другу код '+session.code,'warn');}
});

// Vocabulary lookup. No API calls on input; spellchecking/synonyms use common.js.
fetch('/dictionary.json').then(r=>{if(!r.ok)throw Error();return r.json();}).then(rows=>{
  if(Array.isArray(rows))lexicon=rows;
  renderSuggestions();renderReceiverSearch();
  if(latestMessage)renderAnswer(latestMessage);
  if(alertMessage)paintAlert(alertMessage);
}).catch(()=>{text('suggestionStatus','Словарь не загрузился, ручная отправка работает.');});
function matchOptions(message){
  const selected=chosenMatches.get(message.id);
  const byId=message.entryId&&lexicon.find(x=>x.id===message.entryId);
  if(selected){const x=lexicon.find(e=>e.id===selected);if(x)return {match:x,options:[x],exact:true};}
  if(byId)return {match:byId,options:[byId],exact:true};
  if(!lexicon.length)return {match:null,options:[],exact:false};
  const hits=searchDictionaryDetailed(lexicon,message.word,3);
  if(!hits.length)return {match:null,options:[],exact:false};
  const best=hits[0];
  const exact=normalizeRu(best.entry.ru)===normalizeRu(message.word);
  return {match:best.entry,options:hits.map(h=>h.entry),exact};
}
function contentFor(message){
  const result=matchOptions(message);
  return {...result,en:result.match?result.match.en:'Не найдено в словаре',pron:result.match?result.match.pron:'',locations:result.match?(result.match.locations||[]):[]};
}
function locationLabel(loc,short=false){
  if(short){const pages=[...new Set(loc.map(x=>String(x.page)))];return pages.length?'Страницы: '+pages.join(' · '):'';}
  const unique=[];
  for(const l of loc){const s='стр. '+l.page+(l.exercise?' · '+l.exercise:'');if(!unique.includes(s))unique.push(s);}
  return unique.join(' / ');
}
function markSeen(id){seenIds.add(id);while(seenIds.size>100)seenIds.delete(seenIds.values().next().value);
  try{localStorage.setItem('ec_seen_'+session.code,JSON.stringify([...seenIds]));}catch(_){}
}
function applyHistory(messages,notifyUnseen){
  if(!session||!Array.isArray(messages))return;
  const newMessages=messages.filter(m=>m&&m.id&&!seenIds.has(m.id));
  historyItems=messages.slice(-50).reverse();renderHistory();
  if(historyItems.length)renderAnswer(historyItems[0]);
  if(notifyUnseen&&session.role==='receiver'&&newMessages.length){
    // Replay only messages that were not displayed on this device previously.
    for(const m of newMessages)receiveOne(m,false);
    if(newMessages.length>1)toast('Пока тебя не было, пришло сообщений: '+newMessages.length);
  }else for(const m of newMessages)markSeen(m.id);
}
function receiveOne(message,fromLive){
  if(!session||seenIds.has(message.id))return;
  markSeen(message.id);
  if(!historyItems.some(m=>m.id===message.id))historyItems.unshift(message);
  historyItems=historyItems.slice(0,50);
  renderHistory();renderAnswer(message);
  if(fullscreenEnabled)openAlert(message);else toast('Новое слово: '+message.word);
  if(soundEnabled)playMessage(message);
  if(fromLive && document.visibilityState==='hidden'){
    // A background page may be frozen; no promise of OS-level notifications.
  }
}
function renderHistory(){
  const list=$('historyList');list.replaceChildren();text('historyCount',historyItems.length);
  if(!historyItems.length){const p=document.createElement('li');p.className='empty-history';p.textContent='Пока нет сообщений';list.append(p);return;}
  for(const m of historyItems){
    const li=document.createElement('li'),b=document.createElement('button'),name=document.createElement('b'),time=document.createElement('time');
    b.type='button';name.textContent=m.word;time.textContent=fmtTime(m.at);b.append(name,time);
    b.addEventListener('click',()=>{renderAnswer(m);if(fullscreenEnabled&&session?.role==='receiver')openAlert(m);});
    li.append(b);list.append(li);
  }
}
function fmtTime(value){try{return new Date(value).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'});}catch(_){return '';}}
function renderAnswer(message){
  latestMessage=message;
  show('answerEmpty',false);show('answerData',true);
  text('lastTime',fmtTime(message.at));text('latestRu',message.word);
  const c=contentFor(message);
  text('latestEn',c.en);text('latestPron',c.pron);text('latestLocation',locationLabel(c.locations));
  text('latestWarning',!c.match?'Слова нет в словаре':c.exact?'':'Похожий вариант: проверь значение');
  const options=$('latestOptions');options.replaceChildren();
  if(!c.exact && c.options.length>1){
    for(const entry of c.options){
      const button=document.createElement('button');button.type='button';button.textContent=entry.en+' — '+entry.ru;
      button.addEventListener('click',()=>{chosenMatches.set(message.id,entry.id);renderAnswer(message);if(alertMessage?.id===message.id)paintAlert(message);});
      options.append(button);
    }
  }
}
function renderSuggestions(){
  const wrap=$('suggestions');wrap.replaceChildren();
  const q=$('word').value.trim();
  if(!lexicon.length){text('suggestionStatus','Словарь загружается или недоступен…');return;}
  if(q.length<2){text('suggestionStatus','Введи 2–3 буквы для подсказок');return;}
  const hits=searchDictionaryDetailed(lexicon,q,6);
  text('suggestionStatus',hits.length?'Нажми на вариант — он сразу отправится':'Не найдено. Можно отправить свой текст.');
  for(const {entry,kind} of hits){
    const b=document.createElement('button');b.type='button';b.className='suggestion-option';b.disabled=sending;
    const top=document.createElement('span');top.className='suggestion-top';
    const ru=document.createElement('span');ru.className='suggestion-russian';ru.textContent=entry.ru;
    const k=document.createElement('span');k.className='suggestion-type';k.textContent=kind;
    top.append(ru,k);
    const en=document.createElement('span');en.className='suggestion-english';en.textContent=entry.en;
    const pron=document.createElement('span');pron.className='suggestion-pron';pron.textContent=entry.pron;
    b.append(top,en,pron);
    b.addEventListener('click',()=>sendWord(entry.ru,entry.id));wrap.append(b);
  }
}
$('word').addEventListener('input',()=>{text('wordCount',$('word').value.length+' / 220');renderSuggestions();});
$('word').addEventListener('keydown',e=>{
  if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();$('sendForm').requestSubmit();}
});
$('sendForm').addEventListener('submit',e=>{e.preventDefault();sendWord($('word').value.trim(),null);});
async function sendWord(word,entryId){
  if(sending||!session||session.role!=='sender'||!word)return;
  sending=true;$('sendWord').disabled=true;for(const b of $('suggestions').children)b.disabled=true;
  text('sendFeedback','Отправка…');
  try{
    const data=await api('/api/messages',{word,entryId});
    text('sendFeedback',data.delivered?'✓ Передано другу онлайн':'✓ Сохранено в комнате. Друг увидит при возвращении.');
    $('word').value='';text('wordCount','0 / 220');renderSuggestions();
    $('word').focus({preventScroll:true});
  }catch(e){text('sendFeedback','Ошибка: '+e.message);toast(e.message,'error');}
  finally{sending=false;$('sendWord').disabled=false;if($('word').value.trim())renderSuggestions();}
}
const receiverSearch=$('receiverSearch');
receiverSearch.addEventListener('input',renderReceiverSearch);
function renderReceiverSearch(){
  const target=$('receiverResults');target.replaceChildren();
  const q=receiverSearch.value.trim();if(q.length<2||!lexicon.length)return;
  const hits=searchDictionaryDetailed(lexicon,q,6);
  for(const {entry} of hits){
    const div=document.createElement('div');div.className='receiver-hit';
    const ru=document.createElement('div');ru.textContent=entry.ru;
    const en=document.createElement('b');en.textContent=entry.en;
    const pron=document.createElement('div');pron.textContent=entry.pron;
    div.append(ru,en,pron);target.append(div);
  }
}

// Full-screen alert queue, and optional speech using local device TTS.
function openAlert(message){
  if(alertMessage){alertQueue.unshift(alertMessage);alertQueue=alertQueue.slice(0,25);}
  alertMessage=message;paintAlert(message);
  show('alertLayer',true);document.body.classList.add('modal-open');
  $('closeAlert').focus({preventScroll:true});
}
function paintAlert(message){
  const c=contentFor(message);
  text('alertRu',message.word);text('alertEn',c.en);text('alertPron',c.pron);
  text('alertLocation',locationLabel(c.locations,true));
  text('alertWarning',c.match&&!c.exact?'Похожий вариант — проверь значение':'');
  text('alertQueue',alertQueue.length?'Ещё сообщений: '+alertQueue.length:'');
  text('closeAlert',alertQueue.length?'Следующее сообщение':'Понятно · Закрыть');
}
function closeAlert(all=false){
  if(!all && alertQueue.length){alertMessage=alertQueue.shift();paintAlert(alertMessage);return;}
  alertMessage=null;alertQueue=[];show('alertLayer',false);document.body.classList.remove('modal-open');
  if(speechOkay)window.speechSynthesis.cancel();
}
$('closeAlert').addEventListener('click',()=>closeAlert());
$('closeAlertTop').addEventListener('click',()=>closeAlert());
$('showLatest').addEventListener('click',()=>{if(latestMessage)openAlert(latestMessage);});
$('repeatAlert').addEventListener('click',()=>{if(alertMessage)playMessage(alertMessage);});
$('speakLatest').addEventListener('click',()=>{if(latestMessage)playMessage(latestMessage);});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$('alertLayer').classList.contains('hidden'))closeAlert();});
function pronounce(en){
  if(!speechOkay||!en)return;
  const synth=window.speechSynthesis;
  try{
    synth.cancel();
    const u=new SpeechSynthesisUtterance(en);u.lang='en-US';u.rate=.9;u.pitch=1;
    const voices=synth.getVoices();u.voice=voices.find(v=>v.lang.toLowerCase()==='en-us')||voices.find(v=>v.lang.toLowerCase().startsWith('en'))||null;
    synth.speak(u);
  }catch(_){toast('В этом браузере озвучивание недоступно','warn');}
}
function playMessage(message){
  const {match}=contentFor(message);
  if(match)pronounce(match.en);
  else toast('Нет английского соответствия для озвучивания','warn');
}
function syncToggles(){
  $('soundToggle').textContent=soundEnabled?'🔊 Автозвук · ВКЛ':'🔊 Включить звук';
  $('soundToggle').classList.toggle('active',soundEnabled);
  $('soundToggle').disabled=!speechOkay;
  $('fullscreenToggle').textContent=fullscreenEnabled?'На весь экран · ВКЛ':'На весь экран · ВЫКЛ';
  $('fullscreenToggle').classList.toggle('active',fullscreenEnabled);
  text('soundHint',speechOkay?soundEnabled?'При новых сообщениях телефон произносит английский ответ.':'Один раз нажми «Включить звук» после открытия страницы.':'Браузер не поддерживает озвучивание.');
}
$('soundToggle').addEventListener('click',()=>{
  if(!speechOkay)return;
  soundEnabled=!soundEnabled;syncToggles();
  if(soundEnabled)pronounce('integrated circuit');else window.speechSynthesis.cancel();
});
$('fullscreenToggle').addEventListener('click',()=>{
  fullscreenEnabled=!fullscreenEnabled;
  try{localStorage.setItem('ec_fullscreen_v2',String(fullscreenEnabled));}catch(_){}
  syncToggles();if(!fullscreenEnabled)closeAlert(true);
});
syncToggles();renderHistory();restore();
