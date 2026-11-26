'use strict';
/*
 * English Connect voice input. Speech is recognized by the browser; this file
 * NEVER uploads microphone audio to the English Connect server. Only the
 * confirmed dictionary entry is sent through the existing message API.
 */
(function (root) {
  const STOP = new Set(['и','а','но','это','ну','в','на','от','до','для','не','как','что','по','из','с','или']);
  const indexCache = new WeakMap();
  function normalized(s) {
    return String(s || '').toLocaleLowerCase('ru-RU').replace(/ё/g,'е')
      .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^а-яa-z0-9]+/gi, ' ').trim().replace(/\s+/g, ' ');
  }
  function phrasesFor(entry) {
    const raw = [entry.ru, ...(entry.ruVariants || []), ...(entry.aliases || []),
      ...(entry.locations || []).map(l => l.ruOverride).filter(Boolean)];
    const phrases = new Map();
    for (const original of raw) {
      for (const part of [original, ...String(original).split(/[,;]+/u)]) {
        const s = normalized(part);
        if (!s || s.length < 4 || /^\d+$/.test(s)) continue;
        if (!phrases.has(s)) phrases.set(s, part.trim());
      }
    }
    return [...phrases].map(([phrase, text]) => ({phrase, text, words:phrase.split(' ').length}));
  }
  function buildIndex(rows) {
    let out = indexCache.get(rows);
    if (out) return out;
    out=[];
    for (const entry of rows) {
      for (const p of phrasesFor(entry)) out.push({...p, entry});
    }
    indexCache.set(rows,out);
    return out;
  }
  function noSingleWordPadding(whole, phrase) {
    if (whole === phrase) return true;
    const escaped=phrase.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    return new RegExp('^(?:что значит|как переводится|как перевести|как будет|переведи|перевод слова|что означает) '+escaped+'$','u').test(whole);
  }
  function canonicalEnglish(en) {
    // Abbreviations in parentheses don't create a different translation.
    return String(en||'').toLowerCase().replace(/\s*\([a-z]{2,6}\)\s*$/,'').trim();
  }
  function voiceMatch(transcript, rows) {
    const q = normalized(transcript);
    if (!q || !rows || !rows.length) return {best:null, ambiguous:false, alternatives:[], transcript:q};
    const found = new Map();
    const padded = ' ' + q + ' ';
    const qCount=q.split(' ').length;
    for (const doc of buildIndex(rows)) {
      if (doc.words === 1 && STOP.has(doc.phrase)) continue;
      const exact = q === doc.phrase;
      // Don't fire just because a topic is mentioned inside a long sentence.
      const embedded = doc.words >= 2 && doc.phrase.length >= 10 &&
        qCount <= doc.words + 6 && padded.includes(' ' + doc.phrase + ' ') &&
        (q.startsWith(doc.phrase) || q.endsWith(doc.phrase));
      if (!exact && !embedded) {
        if (doc.words !== 1 || !noSingleWordPadding(q,doc.phrase)) continue;
      }
      const rank = (exact ? 10000 : 1000) + doc.words*80 + Math.min(doc.phrase.length,100);
      const foundBefore=found.get(doc.entry.id);
      if (!foundBefore || rank > foundBefore.rank) found.set(doc.entry.id,{...doc,rank,exact});
    }
    const sorted=[...found.values()].sort((a,b) => b.rank-a.rank || a.entry.id-b.entry.id);
    if (!sorted.length) return {best:null, ambiguous:false, alternatives:[], transcript:q};
    // If two distinct English entries match the same phrase, never arbitrarily
    // choose one. The user picks a result manually instead.
    const first=sorted[0];
    const ambiguity=sorted.some(c=>c.entry.id!==first.entry.id &&
      c.phrase===first.phrase && canonicalEnglish(c.entry.en)!==canonicalEnglish(first.entry.en));
    return {best:ambiguity?null:first, ambiguous:ambiguity, alternatives:sorted.slice(0,4), transcript:q};
  }
  const allowedErrors = {
    'not-allowed':'Микрофон запрещён. Разреши доступ к нему в настройках браузера.',
    'service-not-allowed':'Браузер запретил распознавание. Проверь разрешения и настройки.',
    'audio-capture':'Микрофон недоступен или занят другим приложением.',
    'network':'Ошибка службы распознавания. Проверь интернет.',
    'language-not-supported':'Русский язык не поддерживается службой распознавания.',
    'no-speech':'Речь пока не распознана. Продолжаем слушать…',
    'aborted':'Распознавание остановлено.'
  };
  function createController(config) {
    const SpeechRec = root.SpeechRecognition || root.webkitSpeechRecognition;
    const $ = id=>root.document.getElementById(id);
    let recognition=null, wanted=false, active=false, startInFlight=false;
    let restartTimer=null, stableTimer=null, lastHypothesis='';
    let stableId=null, lastStarts=[], silenceErrors=0;
    const sentRecently = new Map();
    function setStatus(value, warning=false) {
      const el=$('voiceStatus'); if(!el) return;
      el.textContent=value;
      el.classList.toggle('voice-error', !!warning);
    }
    function updateButton() {
      const btn=$('voiceToggle');if(!btn)return;
      btn.disabled=!SpeechRec;
      btn.classList.toggle('is-listening',wanted);
      btn.setAttribute('aria-pressed',String(wanted));
      btn.textContent=wanted?'■ Остановить прослушивание':'🎙 Включить микрофон';
      const badge=$('voiceBadge');if(badge)badge.textContent=wanted ? (active?'● Слушаем':'◌ Подключаем микрофон'):'○ Микрофон выключен';
    }
    function clearTimers() { if(stableTimer){clearTimeout(stableTimer);stableTimer=null;} if(restartTimer){clearTimeout(restartTimer);restartTimer=null;} }
    function isEligible(){return wanted && config.canListen() && root.document.visibilityState==='visible';}
    function startRecognition() {
      if(!SpeechRec || !isEligible() || active || startInFlight) return;
      const now=Date.now();lastStarts=lastStarts.filter(t=>now-t<60000);
      if(lastStarts.length>=12){
        wanted=false;setStatus('Браузер слишком часто останавливает микрофон. Нажми «Включить» ещё раз.',true);updateButton();return;
      }
      clearTimers();
      try {
        recognition = new SpeechRec();
        recognition.lang='ru-RU'; recognition.continuous=true; recognition.interimResults=true;
        recognition.maxAlternatives=1;
        recognition.onstart=()=>{active=true;startInFlight=false;silenceErrors=0;updateButton();setStatus('Слушаю русскую речь. Найденное слово отправлю автоматически.');};
        recognition.onresult=e=>{
          if(!isEligible())return;
          for(let i=e.resultIndex;i<e.results.length;i++){
            const r=e.results[i]; if(!r || !r[0])continue;
            processText(String(r[0].transcript||''),!!r.isFinal);
          }
        };
        recognition.onerror=e=>{
          const code=String(e.error||'');setStatus(allowedErrors[code]||'Не удалось распознать речь: '+code,code!=='no-speech');
          if(code==='not-allowed'||code==='service-not-allowed'||code==='audio-capture'||code==='language-not-supported'){
            wanted=false;updateButton();
          }
          if(code==='network'){silenceErrors++;if(silenceErrors>=3){wanted=false;updateButton();}}
        };
        recognition.onend=()=>{
          active=false;startInFlight=false;updateButton();
          if(isEligible()){
            // Microphone sessions can end after a pause, particularly on mobile.
            // Re-open without touching the message transport.
            restartTimer=setTimeout(()=>{restartTimer=null;startRecognition();},450);
          }else if(wanted && root.document.visibilityState!=='visible'){
            setStatus('Страница свёрнута. Для безопасности прослушивание остановлено.');
          }
        };
        startInFlight=true;lastStarts.push(now);recognition.start();
      }catch(e){startInFlight=false;active=false;setStatus('Не удалось запустить микрофон: '+e.message,true);wanted=false;updateButton();}
    }
    function stop(reason) {
      wanted=false;clearTimers();stableId=null;lastHypothesis='';
      const old=recognition;recognition=null;
      if(old){old.onend=null;old.onerror=null;old.onresult=null;old.onstart=null;try{old.abort();}catch(_){}}
      active=false;startInFlight=false;updateButton();
      setStatus(reason||'Микрофон выключен.');
    }
    function dispatch(doc, transcript) {
      if(!isEligible() || !doc)return;
      const key=String(doc.entry.id);const now=Date.now();
      for(const [k,time] of sentRecently)if(now-time>12000)sentRecently.delete(k);
      if(now-(sentRecently.get(key)||0)<7000)return;
      sentRecently.set(key,now);
      setStatus('✓ Найдено: '+doc.text+' → '+doc.entry.en+'. Отправляю…');
      lastHypothesis='';stableId=null;clearTimeout(stableTimer);stableTimer=null;
      // This invokes the original message endpoint without any extra round trip.
      Promise.resolve(config.send(doc.entry,doc.text)).then(ok=>{
        if(ok===false){sentRecently.delete(key);setStatus('Не отправлено. Попробуй ещё раз.',true);}
        else setStatus('✓ Отправлено: '+doc.text+' → '+doc.entry.en);
      }).catch(()=>{sentRecently.delete(key);setStatus('Ошибка отправки. Попробуй ещё раз.',true);});
    }
    function previewOptions(docs) {
      const target=$('voiceOptions');if(!target)return;
      target.replaceChildren();
      for(const doc of docs.slice(0,3)){
        const b=root.document.createElement('button');b.type='button';b.className='voice-choice';
        b.textContent=doc.text+'  →  '+doc.entry.en;
        b.addEventListener('click',()=>{
          const ok=config.send(doc.entry,doc.text);
          Promise.resolve(ok).then(sent=>{if(sent===false)setStatus('Не отправлено. Попробуй ещё раз.',true);}).catch(()=>setStatus('Ошибка отправки',true));
        });
        target.append(b);
      }
    }
    function processText(s,final) {
      const normalizedText=normalized(s);
      if(!normalizedText)return;
      const transcript=$('voiceTranscript');if(transcript)transcript.textContent=s;
      const rows=config.rows();
      const match=voiceMatch(s,rows);
      let candidates=match.alternatives;
      if(match.best && !match.ambiguous){
        const doc=match.best;
        previewOptions([doc]);
        if(final){dispatch(doc,s);return;}
        // Fast mode: do not auto-send a one-word interim hypothesis or a
        // phrase merely *contained* inside a much longer unfinished sentence.
        // Give the recognizer 600ms to correct provisional text.
        const fast=$('voiceSpeed')?.value!=='accurate';
        if(fast && doc.words>=2 && doc.phrase.length>=14 && doc.exact){
          if(lastHypothesis!==normalizedText || stableId!==doc.entry.id){
            lastHypothesis=normalizedText;stableId=doc.entry.id;
            if(stableTimer)clearTimeout(stableTimer);
            stableTimer=setTimeout(()=>{
              stableTimer=null;
              if(isEligible()&&lastHypothesis===normalizedText&&stableId===doc.entry.id)dispatch(doc,s);
            },600);
          }
        }else{lastHypothesis=normalizedText;stableId=null;if(stableTimer)clearTimeout(stableTimer);}
        setStatus('Услышал: '+doc.text+' → '+doc.entry.en+(final?'':' · проверяю распознавание…'));
        return;
      }
      if(stableTimer){clearTimeout(stableTimer);stableTimer=null;}stableId=null;lastHypothesis=normalizedText;
      if(!candidates.length && final && typeof root.searchDictionaryDetailed==='function'){
        // Fuzzy results are NEVER sent without a tap: transcription errors
        // and alternative Russian phrasings can be ambiguous.
        const rough=root.searchDictionaryDetailed(rows,normalizedText,3);
        candidates=rough.filter(x=>x.score<0.60).map(x=>({entry:x.entry,text:x.entry.ru}));
      }
      previewOptions(candidates);
      setStatus(match.ambiguous?'Несколько одинаково подходящих вариантов — нажми нужный.':
        candidates.length?'Нашёл похожие варианты. Нажми нужный для отправки.':'Пока нет точного совпадения в словаре.');
    }
    function init() {
      const button=$('voiceToggle'); if(!button)return;
      button.addEventListener('click',()=>{
        if(wanted){stop();return;}
        if(!SpeechRec){setStatus('Браузер не поддерживает распознавание речи.',true);return;}
        if(!config.canListen()){setStatus('Сначала войди в комнату как отправитель.',true);return;}
        if(!config.rows().length){setStatus('Дождись загрузки словаря.',true);return;}
        wanted=true;updateButton();setStatus('Запрашиваю доступ к микрофону…');startRecognition();
      });
      if($('voiceSpeed'))$('voiceSpeed').addEventListener('change',()=>{if(stableTimer)clearTimeout(stableTimer);stableId=null;});
      root.document.addEventListener('visibilitychange',()=>{
        // A background phone cannot reliably listen; do not pretend it can.
        if(root.document.visibilityState!=='visible' && wanted)stop('Страница свёрнута. Нажми «Включить микрофон» после возвращения.');
      });
      setStatus(SpeechRec?'Нажми кнопку, чтобы начать слушать русский язык.':'Распознавание недоступно в этом браузере. Используй ввод с клавиатуры или её микрофон.',!SpeechRec);
      updateButton();
    }
    return {init,stop,isEnabled:()=>wanted,match:voiceMatch};
  }
  root.ECVoice = {createController,voiceMatch,buildIndex};
  if (typeof module !== 'undefined' && module.exports) module.exports={voiceMatch,buildIndex,normalized};
})(typeof window !== 'undefined' ? window : globalThis);
