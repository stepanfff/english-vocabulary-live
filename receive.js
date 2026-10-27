'use strict';
const STORAGE_ROOM='voc_room_key_v1';
const queryRoom=getQueryRoom();
let savedRoom;
try{savedRoom=localStorage.getItem(STORAGE_ROOM);}catch(_){}
const room=queryRoom || (savedRoom && ROOM_PATTERN.test(savedRoom)?savedRoom:makeRoom());
try{localStorage.setItem(STORAGE_ROOM,room);}catch(_){}
if(location.search !== '?room='+room) history.replaceState(null,'','/receive?room='+room);
const sendURL=location.origin+'/send?room='+room;
document.getElementById('sendLink').value=sendURL;
document.getElementById('copyLink').addEventListener('click',async()=>{
 const ok=await copyText(sendURL,document.getElementById('sendLink'));
 setText('copyState',ok?'✓ Ссылка скопирована. Отправь её другу.':'Выдели ссылку и скопируй вручную.');
});

let lexicon=[];let connected=false;
fetch('/dictionary.json').then(resp=>{if(!resp.ok)throw Error('Нет файла словаря');return resp.json();}).then(data=>{
 lexicon=data;
 setText('searchStatus','Загружено '+data.length+' слов и выражений');
 renderSearch();
 if(latestMessage)renderLatest(latestMessage);
 if(currentFullscreenMessage)populateFullscreen(currentFullscreenMessage);
 if(pendingSoundMessage && autoSoundOn){
  const pending=pendingSoundMessage;pendingSoundMessage=null;
  playMessage(pending);
 }
}).catch(()=>setText('searchStatus','Не удалось загрузить словарь. Обнови страницу.'));

function renderMatch(el,entry){
 const box=addEl('div','word-result');
 box.append(addEl('div','rus',entry.ru));
 box.append(addEl('div','english',entry.en));
 box.append(addEl('div','pron',entry.pron));
 const tags=addEl('div','tags');
 (entry.locations||[]).forEach(loc=>tags.append(addEl('span',null,'стр. '+loc.page+' · '+loc.exercise)));
 box.append(tags);el.append(box);
}
const search=document.getElementById('search');
search.addEventListener('input',renderSearch);
function renderSearch(){
 const out=document.getElementById('searchResults');out.replaceChildren();
 const q=search.value.trim();if(!q)return;
 const matches=searchDictionary(lexicon,q,8);
 setText('searchStatus',!lexicon.length?'Загрузка словаря…':matches.length?'Найдено вариантов: '+matches.length+(matches.length===8?' (показаны первые 8)':''):'Совпадений нет. Попробуй другое слово или его часть.');
 for(const item of matches)renderMatch(out,item);
}

let latestMessage;
function renderLatest(message){
 latestMessage=message;
 document.getElementById('noMessage').classList.add('hidden');
 document.getElementById('latest').classList.remove('hidden');
 setText('latestWord',message.word);
 setText('lastTime',new Date(message.at).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'}));
 const out=document.getElementById('latestMatches');out.replaceChildren();
 const matches=searchDictionary(lexicon,message.word,5);
 if(matches.length){out.append(addEl('div','small','Возможные английские эквиваленты:'));matches.forEach(x=>renderMatch(out,x));}
 else out.append(addEl('div','notice warn',lexicon.length?'В словаре точного совпадения нет. Попробуй поиск по части фразы.':'Словарь ещё загружается…'));
}

function showToast(message){
 const matches=searchDictionary(lexicon,message.word,1);
 const el=addEl('div','toast');el.setAttribute('role','status');
 el.append(addEl('strong',null,'НОВОЕ СООБЩЕНИЕ ОТ ДРУГА'));
 el.append(addEl('div','toast-ru',message.word));
 if(matches.length){el.append(addEl('div','toast-en',matches[0].en));el.append(addEl('div','toast-pron',matches[0].pron));}
 else el.append(addEl('div','small',lexicon.length?'Совпадения в словаре нет':'Словарь загружается…'));
 const close=addEl('button',null,'×');close.type='button';close.setAttribute('aria-label','Закрыть уведомление');close.addEventListener('click',()=>el.remove());el.append(close);
 const area=document.getElementById('toastArea');area.prepend(el);
 while(area.children.length>3)area.lastChild.remove();
 setTimeout(()=>el.remove(),14000);
}

// Speech uses the phone/browser's speech-synthesis engine, not our Render server.
// Mobile browsers usually require a user tap to unlock sound. We intentionally
// start OFF on every page load, rather than promising unattended autoplay.
const soundSupported=('speechSynthesis' in window && 'SpeechSynthesisUtterance' in window);
const soundMode=document.getElementById('soundMode');
const previewSound=document.getElementById('previewSound');
let autoSoundOn=false;
let pendingSoundMessage=null;
function syncSoundControls(){
 soundMode.setAttribute('aria-pressed',String(autoSoundOn));
 soundMode.textContent=autoSoundOn?'🔊 Автозвук · ВКЛ':'🔊 Включить звук';
 soundMode.classList.toggle('primary',autoSoundOn);
 soundMode.classList.toggle('ghost',!autoSoundOn);
 if(!soundSupported){
  soundMode.disabled=true;previewSound.disabled=true;
  setText('soundStatus','Этот браузер не поддерживает озвучивание текста.');
 }else if(autoSoundOn){
  setText('soundStatus','Автозвук включён. Новые слова читаются вслух, пока страница открыта.');
 }else{
  setText('soundStatus','Автозвук выключен. Нажми «Включить звук» перед занятием.');
 }
}
function pickVoice(lang){
 const all=window.speechSynthesis.getVoices();
 if(!all.length)return null;
 const target=lang.toLowerCase();
 return all.find(v=>v.lang.toLowerCase()===target)
  ||all.find(v=>v.lang.toLowerCase().startsWith(target.slice(0,2)))
  ||null;
}
function pronounce(text,lang='en-US'){
 if(!soundSupported || !text)return false;
 try{
  const synth=window.speechSynthesis;
  synth.cancel(); // New message gets priority; never build up an audio queue.
  const utterance=new SpeechSynthesisUtterance(text);
  utterance.lang=lang;
  utterance.rate=0.90; utterance.pitch=1; utterance.volume=1;
  const voice=pickVoice(lang);if(voice)utterance.voice=voice;
  utterance.onerror=event=>{
   if(event.error==='canceled'||event.error==='interrupted')return;
   setText('soundStatus','Не удалось воспроизвести звук ('+event.error+'). Попробуй нажать «Проверить звук» и проверь громкость.');
  };
  synth.speak(utterance);
  return true;
 }catch(_){
  setText('soundStatus','Не удалось запустить озвучивание в этом браузере.');
  return false;
 }
}
function textToPronounce(message){
 const match=searchDictionary(lexicon,message.word,1)[0];
 return match ? {text:match.en,lang:'en-US'} : {text:message.word,lang:'ru-RU'};
}
function playMessage(message){
 if(!message || !soundSupported)return;
 const {text,lang}=textToPronounce(message);
 pronounce(text,lang);
}
function handleIncomingSpeech(message){
 if(!autoSoundOn)return;
 if(!lexicon.length){pendingSoundMessage=message;return;}
 playMessage(message);
}
syncSoundControls();
soundMode.addEventListener('click',()=>{
 if(!soundSupported)return;
 autoSoundOn=!autoSoundOn;
 pendingSoundMessage=null;
 syncSoundControls();
 if(autoSoundOn){
  // A direct tap authorizes sound on mobile browsers where background autoplay is blocked.
  pronounce('integrated circuit','en-US');
 }else{
  window.speechSynthesis.cancel();
 }
});
previewSound.addEventListener('click',()=>{
 if(!soundSupported)return;
 // Even if auto mode is OFF, a user tap can play a test phrase.
 pronounce('integrated circuit','en-US');
});
document.getElementById('repeatSound').addEventListener('click',()=>{
 if(currentFullscreenMessage)playMessage(currentFullscreenMessage);
});

// Display an in-page viewport-covering alert by default. Browsers cannot show
// this over other apps or the lock screen; the receive page must remain open.
const FULLSCREEN_KEY='voc_fullscreen_v1';
let fullscreenEnabled=true;
try {const v=localStorage.getItem(FULLSCREEN_KEY);if(v!==null)fullscreenEnabled=v==='true';}catch(_){}
const fullscreenAlert=document.getElementById('fullscreenAlert');
const fullscreenMode=document.getElementById('fullscreenMode');
let currentFullscreenMessage=null;
let queuedFullscreenMessages=[];
let previousFocus=null;
function syncFullscreenMode(){
 fullscreenMode.setAttribute('aria-pressed',String(fullscreenEnabled));
 fullscreenMode.textContent=fullscreenEnabled?'На весь экран · ВКЛ':'На весь экран · ВЫКЛ';
 fullscreenMode.classList.toggle('primary',fullscreenEnabled);
 fullscreenMode.classList.toggle('ghost',!fullscreenEnabled);
}
syncFullscreenMode();
fullscreenMode.addEventListener('click',()=>{
 fullscreenEnabled=!fullscreenEnabled;
 try{localStorage.setItem(FULLSCREEN_KEY,String(fullscreenEnabled));}catch(_){}
 syncFullscreenMode();
 if(!fullscreenEnabled)closeFullscreen(true);
});
function populateFullscreen(message){
 setText('alertHeading',message.preview?'ПРОВЕРКА УВЕДОМЛЕНИЯ':'НОВОЕ СООБЩЕНИЕ ОТ ДРУГА');
 setText('alertRu',message.word);
 setText('alertTime',message.preview?'Пример отображения':new Date(message.at).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'}));
 const matches=searchDictionary(lexicon,message.word,1);
 setText('alertEn',matches.length?matches[0].en:lexicon.length?'В словаре нет совпадения':'Загрузка словаря…');
 setText('alertPron',matches.length?matches[0].pron:'');
 setText('alertLocation',matches.length?(matches[0].locations||[]).map(x=>'стр. '+x.page+' · '+x.exercise).join('    |    '):'');
 setText('alertQueue',queuedFullscreenMessages.length?'Осталось сообщений: '+queuedFullscreenMessages.length:'');
 document.getElementById('dismissFullscreen').textContent=queuedFullscreenMessages.length?'Следующее сообщение':'Понятно · Закрыть';
}
function showFullscreen(message){
 if(currentFullscreenMessage){
  queuedFullscreenMessages.unshift(currentFullscreenMessage);
  queuedFullscreenMessages=queuedFullscreenMessages.slice(0,25);
 } else {
  previousFocus=document.activeElement;
 }
 currentFullscreenMessage=message;
 populateFullscreen(message);
 fullscreenAlert.classList.remove('hidden');
 document.body.classList.add('alert-open');
 document.getElementById('dismissFullscreen').focus({preventScroll:true});
}
function closeFullscreen(all=false){
 if(!all && queuedFullscreenMessages.length){
  currentFullscreenMessage=queuedFullscreenMessages.shift();
  populateFullscreen(currentFullscreenMessage);
  if(autoSoundOn)playMessage(currentFullscreenMessage);
  return;
 }
 queuedFullscreenMessages=[];
 currentFullscreenMessage=null;
 fullscreenAlert.classList.add('hidden');
 document.body.classList.remove('alert-open');
 if(previousFocus && previousFocus.isConnected)previousFocus.focus({preventScroll:true});
 previousFocus=null;
 if(soundSupported)window.speechSynthesis.cancel();
}
document.getElementById('dismissFullscreen').addEventListener('click',()=>closeFullscreen());
document.getElementById('dismissFullscreenTop').addEventListener('click',()=>closeFullscreen());
document.getElementById('previewFullscreen').addEventListener('click',()=>{
 const demo={word:'интегральная схема',at:new Date().toISOString(),preview:true};
 showFullscreen(demo);
 if(autoSoundOn)playMessage(demo);
});
document.addEventListener('keydown',event=>{
 if(fullscreenAlert.classList.contains('hidden'))return;
 if(event.key==='Escape'){event.preventDefault();closeFullscreen();}
 if(event.key==='Tab'){
  const buttons=[document.getElementById('dismissFullscreenTop'),document.getElementById('repeatSound'),document.getElementById('dismissFullscreen')];
  if(event.shiftKey&&document.activeElement===buttons[0]){event.preventDefault();buttons[buttons.length-1].focus();}
  else if(!event.shiftKey&&document.activeElement===buttons[buttons.length-1]){event.preventDefault();buttons[0].focus();}
 }
});
function incomingAlert(message){
 if(fullscreenEnabled)showFullscreen(message);
 else showToast(message);
 handleIncomingSpeech(message);
 if(document.visibilityState==='hidden' && 'Notification' in window && Notification.permission==='granted'){
  try {const n=new Notification('Новое слово от друга',{body:message.word});n.onclick=()=>{window.focus();n.close();};}catch(_){}
 }
}

const HISTORY_KEY='voc_history_'+room;
let historyItems=[];
try{const h=JSON.parse(localStorage.getItem(HISTORY_KEY)||'[]'); if(Array.isArray(h))historyItems=h.slice(0,25);}catch(_){}
function storeHistory(){try{localStorage.setItem(HISTORY_KEY,JSON.stringify(historyItems));}catch(_){}}
function drawHistory(){
 const ul=document.getElementById('historyList');ul.replaceChildren();
 if(!historyItems.length){ul.append(addEl('li','small','Сообщений пока нет'));return;}
 historyItems.forEach(m=>{
  const li=document.createElement('li');const link=addEl('button',null,m.word);
  link.type='button';link.title='Показать английские эквиваленты';
  link.style.cssText='border:0;background:transparent;text-align:left;font:inherit;color:#1d4c62;font-weight:650;cursor:pointer;padding:0;overflow-wrap:anywhere;';
  link.addEventListener('click',()=>{search.value=m.word;renderSearch();search.scrollIntoView({behavior:'smooth',block:'center'});});
  li.append(link,addEl('time',null,new Date(m.at).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'})));ul.append(li);
 });
}
drawHistory();
document.getElementById('clearHistory').addEventListener('click',()=>{
 if(!historyItems.length)return;
 if(confirm('Очистить историю сообщений на этом устройстве?')){historyItems=[];storeHistory();drawHistory();}
});

const status=document.getElementById('liveStatus');
function showConnection(state,txt){connected=state;status.className='status '+(state?'live':'offline');status.textContent=txt;}
const stream=new EventSource('/events?room='+encodeURIComponent(room));
stream.addEventListener('ready',()=>showConnection(true,'Подключено · в реальном времени'));
stream.addEventListener('error',()=>showConnection(false,'Переподключение…'));
stream.addEventListener('message',evt=>{
 let data;try{data=JSON.parse(evt.data);}catch(_){return;}
 if(!data || typeof data.word!=='string' || typeof data.at!=='string')return;
 renderLatest(data);incomingAlert(data);
 historyItems.unshift(data);historyItems=historyItems.slice(0,25);storeHistory();drawHistory();
});
// A small incoming request periodically keeps free Render services awake while the page is open.
setInterval(()=>{if(document.visibilityState==='visible')fetch('/healthz',{cache:'no-store'}).catch(()=>{});},4*60*1000);
const notifyButton=document.getElementById('notifications');
if(!('Notification' in window)||!window.isSecureContext){notifyButton.disabled=true;notifyButton.title='Доступно в браузере по HTTPS';}
else if(Notification.permission==='granted')notifyButton.textContent='✓ Уведомления браузера разрешены';
notifyButton.addEventListener('click',async()=>{
 if(!('Notification' in window))return;
 try{
  const permission=await Notification.requestPermission();
  notifyButton.textContent=permission==='granted'?'✓ Уведомления браузера разрешены':'Уведомления не разрешены';
 }catch(_){notifyButton.textContent='Не удалось включить';}
});
