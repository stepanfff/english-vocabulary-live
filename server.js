'use strict';
// Minimal, dependency-free real-time server (Node.js 20+).
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3000);
const ROOM_RE = /^[a-f0-9]{32}$/i;
const files = {
  '/receive': ['receive.html','text/html; charset=utf-8'],
  '/receive.html': ['receive.html','text/html; charset=utf-8'],
  '/send': ['send.html','text/html; charset=utf-8'],
  '/send.html': ['send.html','text/html; charset=utf-8'],
  '/dictionary': ['dictionary.html','text/html; charset=utf-8'],
  '/dictionary.html': ['dictionary.html','text/html; charset=utf-8'],
  '/style.css': ['style.css','text/css; charset=utf-8'],
  '/common.js': ['common.js','text/javascript; charset=utf-8'],
  '/send.js': ['send.js','text/javascript; charset=utf-8'],
  '/receive.js': ['receive.js','text/javascript; charset=utf-8'],
  '/dictionary.json': ['dictionary.json','application/json; charset=utf-8']
};
// Room data is NOT persisted: if the receiver is offline, there is no message backlog.
const sessions = new Map();
const rateLimits = new Map();

function sendJson(res,status,data,more={}) {
  res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...more });
  res.end(JSON.stringify(data));
}
function secureHeaders(res,pathname) {
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  res.setHeader('Cache-Control','no-store');
  if (pathname !== '/dictionary' && pathname !== '/dictionary.html') {
    // The existing standalone dictionary has inline JS/CSS and keeps its original functionality.
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  }
}
function getRoom(room) { return typeof room === 'string' && ROOM_RE.test(room) ? room.toLowerCase() : null; }
function sendEvent(res,name,obj) {
  if (res.destroyed || res.writableEnded) return;
  try { res.write(`event: ${name}\ndata: ${JSON.stringify(obj)}\n\n`); } catch (_) { /* socket close handler cleans up */ }
}
function readPost(req,limit=2048) {
  return new Promise((resolve,reject)=> {
    let data='';let size=0;
    req.on('data',chunk=>{
      size += chunk.length;
      if (size>limit) { reject(new Error('too large')); req.destroy(); return; }
      data+=chunk.toString('utf8');
    });
    req.on('end',()=>resolve(data));
    req.on('error',reject);
  });
}
function limited(req) {
  const ip = req.socket.remoteAddress || 'unknown';
  const now=Date.now();
  const hits=(rateLimits.get(ip)||[]).filter(t=>now-t < 60000);
  if(hits.length >= 30) { rateLimits.set(ip,hits); return true; }
  hits.push(now);rateLimits.set(ip,hits);return false;
}
const server = http.createServer(async(req,res)=>{
  let u;
  try{u=new URL(req.url, 'http://localhost');}catch(_){res.writeHead(400);res.end();return;}
  const pathname=u.pathname;
  secureHeaders(res,pathname);
  if (pathname === '/' && req.method==='GET') {
    res.writeHead(302,{'Location':'/receive'});res.end();return;
  }
  if (pathname === '/healthz' && req.method==='GET') { sendJson(res,200,{ok:true});return; }
  if (pathname === '/events' && req.method==='GET') {
    const room=getRoom(u.searchParams.get('room'));
    if(!room){sendJson(res,400,{error:'Некорректная ссылка комнаты'});return;}
    res.writeHead(200,{
      'Content-Type':'text/event-stream; charset=utf-8',
      'Cache-Control':'no-cache, no-transform',
      'Connection':'keep-alive',
      'X-Accel-Buffering':'no'
    });
    res.write(': connected\n\n');
    if(!sessions.has(room)) sessions.set(room,new Set());
    const group=sessions.get(room);
    group.add(res);
    sendEvent(res,'ready',{connected:true,receivers:group.size});
    res.on('close',()=>{group.delete(res);if(group.size===0)sessions.delete(room);});
    return;
  }
  if (pathname === '/api/send' && req.method==='POST') {
    const origin=req.headers.origin;
    const host=req.headers.host;
    if(origin) {
      try{ if(new URL(origin).host!==host) {sendJson(res,403,{error:'Неверный источник запроса'});return;} }
      catch(_){sendJson(res,403,{error:'Неверный источник запроса'});return;}
    }
    if(!String(req.headers['content-type']||'').startsWith('application/json')){
      sendJson(res,415,{error:'Нужен JSON-запрос'});return;
    }
    if(limited(req)) {sendJson(res,429,{error:'Слишком много сообщений. Попробуйте позже.'});return;}
    let payload;
    try { payload=JSON.parse(await readPost(req)); }
    catch(_) { if(!res.destroyed && !res.writableEnded)sendJson(res,400,{error:'Не удалось прочитать сообщение'});return; }
    const room=getRoom(payload.room);
    const word=typeof payload.word==='string'?payload.word.trim():'';
    if(!room || !word || word.length>220 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(word)) {
      sendJson(res,400,{error:'Проверьте ссылку и текст (до 220 символов)'});return;
    }
    const message={id:crypto.randomUUID(),word,at:new Date().toISOString()};
    const recipients=sessions.get(room);
    let delivered=0;
    if(recipients) for(const client of recipients) {
      if(!client.destroyed && !client.writableEnded) {sendEvent(client,'message',message);delivered++;}
    }
    sendJson(res,200,{ok:true,delivered});
    return;
  }
  if(req.method==='GET' && files[pathname]) {
    const [filename,type]=files[pathname];
    try { const content=await fs.readFile(path.join(ROOT,filename));
      res.writeHead(200,{'Content-Type':type});res.end(content);
    } catch(e) {console.error('Static file error',filename,e.message);sendJson(res,500,{error:'Ошибка чтения файла'});}
    return;
  }
  sendJson(res,404,{error:'Страница не найдена'});
});
server.requestTimeout=15000;
// Keep browser EventSource connections from being silently dropped by idle proxies.
setInterval(()=>{
  for(const clients of sessions.values()) {
    for(const res of clients){try{res.write(': heartbeat\n\n');}catch(_){}}
  }
},20000).unref();
setInterval(()=>{
  const now=Date.now();
  for(const [ip,hits] of rateLimits) if(hits.every(t=>now-t>=60000)) rateLimits.delete(ip);
},60000).unref();
server.listen(PORT,'0.0.0.0',()=> console.log(`Сайт запущен: http://localhost:${PORT}/receive`));
