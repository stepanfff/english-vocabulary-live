'use strict';
const room=getQueryRoom();
const form=document.getElementById('sendForm');
const input=document.getElementById('word');
const submit=document.getElementById('submit');
if (!room) { submit.disabled=true;setText('error','Ссылка неполная. Попроси друга скопировать ссылку заново.');setText('roomState','Нет комнаты');document.getElementById('roomState').classList.add('offline'); }
else { setText('roomState','Комната готова');document.getElementById('roomState').classList.add('live'); }
input.addEventListener('input',()=>{setText('count',input.value.length+' / 220 символов');setText('error','');setText('success','');});
form.addEventListener('submit',async ev=>{
  ev.preventDefault();if(!room)return;
  const word=input.value.trim();if(!word){setText('error','Введите слово или фразу.');return;}
  submit.disabled=true;setText('error','');setText('success','Отправка…');
  try{
    const response=await fetch('/api/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({room,word})});
    const data=await response.json();
    if(!response.ok) throw new Error(data.error||'Ошибка отправки');
    if(data.delivered>0) setText('success','✓ Отправлено на страницу получателя!');
    else setText('success','Отправлено, но получатель сейчас не подключён. Сообщение не сохранено.');
    input.value='';setText('count','0 / 220 символов');input.focus();
  }catch(e){setText('success','');setText('error','Не удалось отправить: '+e.message);}
  finally{submit.disabled=false;}
});
