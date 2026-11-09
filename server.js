'use strict';
// English Connect 2 — two-person rooms with short codes and live role switching.
// No external dependencies; compatible with Node 20+ / Render.
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const LIFETIME = 2 * 60 * 60 * 1000;
const MAX_MESSAGES = 50;
const ROOM_CODE_RE = /^\d{6}$/;
const SESSION_RE = /^[a-f0-9]{64}$/;
const rooms = new Map();
const tokenRoom = new Map();
// Validate entry IDs against the actual dictionary rather than the previous 236-item limit.
const validEntryIds = new Set(JSON.parse(require('node:fs').readFileSync(path.join(ROOT, 'dictionary.json'), 'utf8')).map(row => row.id));
const hits = new Map();
const assets = {
  '/': ['index.html','text/html; charset=utf-8'],
  '/index.html': ['index.html','text/html; charset=utf-8'],
  '/app.js': ['app.js','application/javascript; charset=utf-8'],
  '/common.js': ['common.js','application/javascript; charset=utf-8'],
  '/style.css': ['style.css','text/css; charset=utf-8'],
  '/dictionary.json': ['dictionary.json','application/json; charset=utf-8'],
  '/dictionary': ['dictionary.html','text/html; charset=utf-8'],
  '/dictionary.html': ['dictionary.html','text/html; charset=utf-8']
};
function json(res,code,payload) {
  res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
  res.end(JSON.stringify(payload));
}
function headers(res,pathname) {
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  res.setHeader('Cache-Control','no-store');
  if(pathname !== '/dictionary' && pathname !== '/dictionary.html') {
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  }
}
function cookie(req,name){
  const m = String(req.headers.cookie||'').match(new RegExp('(?:^|;\\s*)'+name+'=([^;]*)'));
  return m ? m[1] : null;
}
function sessionToken(req){
  const token=cookie(req,'english_connect_session');
  return token && SESSION_RE.test(token) ? token : null;
}
function setCookie(req,res,token){
  const secure = !!req.socket.encrypted || String(req.headers['x-forwarded-proto']||'').split(',')[0].trim()==='https';
  const val=token ? token : '';
  res.setHeader('Set-Cookie',`english_connect_session=${val}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${token?Math.floor(LIFETIME/1000):0}${secure?'; Secure':''}`);
}
function validOrigin(req){
  const origin=req.headers.origin;
  if(!origin)return true; // Curl and other non-browser test clients may omit Origin.
  try{return new URL(origin).host===req.headers.host;}catch(_){return false;}
}
function tooMany(req,bucket,max,windowMs=60_000){
  const key=bucket+'|'+String(req.socket.remoteAddress||'unknown');
  const now=Date.now();
  let x=hits.get(key)||[];x=x.filter(t=>now-t<windowMs);
  if(x.length>=max){hits.set(key,x);return true;}
  x.push(now);hits.set(key,x);return false;
}
function readJson(req,limit=4096){
  return new Promise((resolve,reject)=>{
    let data='',size=0,ended=false;
    req.on('data',chunk=>{
      if(ended)return;
      size+=chunk.length;
      if(size>limit){ended=true;reject(new Error('Слишком длинный запрос'));req.destroy();return;}
      data+=chunk.toString('utf8');
    });
    req.on('end',()=>{
      if(ended)return;
      try{resolve(JSON.parse(data));}catch(_){reject(new Error('Ошибка формата данных'));}
    });
    req.on('error',reject);
  });
}
function sendEvent(res,event,payload){
  if(!res.destroyed && !res.writableEnded){
    try{res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);}catch(_){}
  }
}
function roleOf(room,token){
  if(room.participants.sender===token)return 'sender';
  if(room.participants.receiver===token)return 'receiver';
  return null;
}
function roomOf(req){
  const token=sessionToken(req);
  const code=token && tokenRoom.get(token);
  const room=code&&rooms.get(code);
  if(!room || room.expiresAt <= Date.now() || !roleOf(room,token))return null;
  return {room,token,role:roleOf(room,token)};
}
function peerOf(role){return role==='sender'?'receiver':'sender';}
function countConnected(room,token){
  let count=0;
  for(const client of room.clients)if(client.token===token&&!client.res.destroyed&&!client.res.writableEnded)count++;
  return count;
}
function state(room,token){
  const role=roleOf(room,token);
  const peer=room.participants[peerOf(role)];
  return {
    code:room.code,role,expiresAt:new Date(room.expiresAt).toISOString(),
    peerJoined:!!peer,peerOnline:!!peer&&countConnected(room,peer)>0,
    messages:room.messages
  };
}
function broadcast(room,event,payload){for(const c of room.clients)sendEvent(c.res,event,payload);}
function presence(room){
  for(const c of room.clients){
    const role=roleOf(room,c.token);if(!role)continue;
    const peer=room.participants[peerOf(role)];
    sendEvent(c.res,'presence',{peerJoined:!!peer,peerOnline:!!peer&&countConnected(room,peer)>0});
  }
}
function disconnectToken(room,token){
  for(const c of [...room.clients])if(c.token===token){room.clients.delete(c);c.res.end();}
}
function leaveToken(token){
  const code=tokenRoom.get(token);
  if(!code)return;
  tokenRoom.delete(token);
  const room=rooms.get(code);
  if(!room)return;
  const role=roleOf(room,token);
  if(role)room.participants[role]=null;
  disconnectToken(room,token);
  if(!room.participants.sender&&!room.participants.receiver)rooms.delete(code);
  else presence(room);
}
function createCode(){
  for(let i=0;i<60;i++){
    const code=String(crypto.randomInt(0,1_000_000)).padStart(6,'0');
    if(!rooms.has(code))return code;
  }
  return null;
}
const server=http.createServer(async(req,res)=>{
  let u;try{u=new URL(req.url,'http://localhost');}catch(_){json(res,400,{error:'Некорректный адрес'});return;}
  const p=u.pathname;
  headers(res,p);
  if(req.method==='GET' && (p==='/receive'||p==='/send'||p==='/receive.html'||p==='/send.html')){
    res.writeHead(302,{Location:'/'});res.end();return;
  }
  if(req.method==='GET' && p==='/healthz'){json(res,200,{ok:true});return;}
  if(req.method==='GET' && p==='/api/session'){
    const user=roomOf(req);
    if(!user){json(res,200,{active:false});return;}
    json(res,200,{active:true,...state(user.room,user.token)});return;
  }
  if(req.method==='GET' && p==='/events'){
    const user=roomOf(req);
    if(!user){json(res,401,{error:'Сессия истекла. Создай комнату заново.'});return;}
    res.writeHead(200,{
      'Content-Type':'text/event-stream; charset=utf-8',
      'Cache-Control':'no-cache, no-transform','Connection':'keep-alive',
      'X-Accel-Buffering':'no'
    });
    res.write('retry: 1600\n: connected\n\n');
    const client={token:user.token,res};
    user.room.clients.add(client);
    sendEvent(res,'sync',state(user.room,user.token));
    presence(user.room);
    res.on('close',()=>{user.room.clients.delete(client);presence(user.room);});
    return;
  }
  if(p.startsWith('/api/') && req.method==='POST'){
    if(!validOrigin(req)){json(res,403,{error:'Неверный источник запроса'});return;}
    if(!String(req.headers['content-type']||'').startsWith('application/json')){
      json(res,415,{error:'Нужен JSON-запрос'});return;
    }
    if(tooMany(req,p==='/api/rooms/join'?'join':'write',p==='/api/rooms/join'?12:45)){
      json(res,429,{error:'Слишком много попыток. Попробуй через минуту.'});return;
    }
    let body;try{body=await readJson(req);}catch(e){if(!res.destroyed&&!res.writableEnded)json(res,400,{error:e.message});return;}
    if(!body||typeof body!=='object'||Array.isArray(body)){json(res,400,{error:'Неверные данные'});return;}
    if(p==='/api/rooms/create'){
      if(body.role!=='sender'&&body.role!=='receiver'){json(res,400,{error:'Выбери роль'});return;}
      const code=createCode();if(!code){json(res,503,{error:'Нет свободных комнат'});return;}
      const existing=sessionToken(req);if(existing)leaveToken(existing);
      const token=crypto.randomBytes(32).toString('hex');
      const room={code,createdAt:Date.now(),expiresAt:Date.now()+LIFETIME,
        participants:{sender:null,receiver:null},messages:[],clients:new Set()};
      room.participants[body.role]=token;
      rooms.set(code,room);tokenRoom.set(token,code);setCookie(req,res,token);
      json(res,201,{ok:true,...state(room,token)});return;
    }
    if(p==='/api/rooms/join'){
      const code=String(body.code||'').replace(/\s/g,'');
      if(!ROOM_CODE_RE.test(code)||!['sender','receiver'].includes(body.role)){
        json(res,400,{error:'Выбери роль и введи 6 цифр'});return;
      }
      const room=rooms.get(code);
      if(!room || room.expiresAt<=Date.now()){
        json(res,404,{error:'Комната не найдена или срок её действия истёк'});return;
      }
      if(room.participants[body.role]){
        json(res,409,{error:'Роль уже занята. Выбери другую роль.'});return;
      }
      const existing=sessionToken(req);if(existing)leaveToken(existing);
      const token=crypto.randomBytes(32).toString('hex');
      room.participants[body.role]=token;
      tokenRoom.set(token,code);setCookie(req,res,token);
      const payload={ok:true,...state(room,token)};
      json(res,200,payload);presence(room);return;
    }
    const user=roomOf(req);
    if(!user){json(res,401,{error:'Сессия истекла. Войди в комнату заново.'});return;}
    if(p==='/api/rooms/swap'){
      const room=user.room;
      const oldSender=room.participants.sender;
      room.participants.sender=room.participants.receiver;
      room.participants.receiver=oldSender;
      for(const c of room.clients){
        sendEvent(c.res,'role',{role:roleOf(room,c.token)});
      }
      presence(room);
      json(res,200,{ok:true,...state(room,user.token)});return;
    }
    if(p==='/api/rooms/leave'){
      leaveToken(user.token);setCookie(req,res,null);
      json(res,200,{ok:true});return;
    }
    if(p==='/api/messages'){
      if(user.role!=='sender'){
        json(res,403,{error:'Сейчас ты получатель. Поменяй роли, чтобы отправлять.'});return;
      }
      const word=typeof body.word==='string'?body.word.trim():'';
      if(!word||word.length>220||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(word)){
        json(res,400,{error:'Введи текст длиной до 220 символов'});return;
      }
      const entryId=Number.isInteger(body.entryId)&&validEntryIds.has(body.entryId)?body.entryId:null;
      const msg={id:crypto.randomUUID(),word,entryId,at:new Date().toISOString()};
      user.room.messages.push(msg);
      if(user.room.messages.length>MAX_MESSAGES)user.room.messages.shift();
      let delivered=0;
      for(const client of user.room.clients){
        if(client.token===user.room.participants.receiver&&!client.res.destroyed&&!client.res.writableEnded){
          sendEvent(client.res,'message',msg);delivered++;
        }
      }
      json(res,200,{ok:true,delivered,queued:!delivered,message:msg});return;
    }
    json(res,404,{error:'Команда не найдена'});return;
  }
  if(req.method==='GET' && assets[p]){
    const [filename,mime]=assets[p];
    try{const bytes=await fs.readFile(path.join(ROOT,filename));res.writeHead(200,{'Content-Type':mime});res.end(bytes);}
    catch(e){console.error(e);json(res,500,{error:'Не удалось открыть страницу'});}
    return;
  }
  json(res,404,{error:'Страница не найдена'});
});
server.requestTimeout=15_000;
// SSE keep-alives and cleanup. Room contents stay in memory only.
setInterval(()=>{
  const now=Date.now();
  for(const [code,room] of rooms){
    if(room.expiresAt<now){
      broadcast(room,'expired',{reason:'Время работы комнаты закончилось'});
      for(const client of room.clients)client.res.end();
      for(const token of Object.values(room.participants))if(token)tokenRoom.delete(token);
      rooms.delete(code);
    }else for(const c of room.clients){try{c.res.write(': heartbeat\n\n');}catch(_){}}
  }
  for(const [key,events] of hits)if(events.every(t=>now-t>60_000))hits.delete(key);
},20_000).unref();
server.listen(PORT,'0.0.0.0',()=>console.log(`English Connect: http://localhost:${PORT}`));
