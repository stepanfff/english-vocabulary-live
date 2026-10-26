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
 renderLatest(data);showToast(data);
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
