'use strict';
/*
 * English Connect voice input. Speech is recognized by the browser; this file
 * NEVER uploads microphone audio to the English Connect server. Only the
 * matched dictionary entry is sent through the existing message API.
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
  // Return the single highest-ranking dictionary entry, including when multiple
  // English words share the exact same Russian phrase. One utterance -> one ID.
  function voiceMatch(transcript, rows) {
    const q = normalized(transcript);
    if (!q || !rows || !rows.length) return {best:null, ambiguous:false, alternatives:[], transcript:q};
    const found = new Map();
    const padded = ' ' + q + ' ';
    const qCount = q.split(' ').length;
    for (const doc of buildIndex(rows)) {
      if (doc.words === 1 && STOP.has(doc.phrase)) continue;
      const exact = q === doc.phrase;
      // Longer phrases can be heard inside a natural Russian sentence.
      const embedded = doc.words >= 2 && doc.phrase.length >= 10 &&
        qCount <= doc.words + 9 && padded.includes(' ' + doc.phrase + ' ');
      const paddedSingle = doc.words === 1 && noSingleWordPadding(q,doc.phrase);
      if (!exact && !embedded && !paddedSingle) continue;
      const rank = (exact ? 10000 : embedded ? 3000 : 1500) +
        doc.words*80 + Math.min(doc.phrase.length,100);
      const prior=found.get(doc.entry.id);
      if (!prior || rank > prior.rank) found.set(doc.entry.id,{...doc,rank,exact,kind:exact?'exact':'embedded'});
    }
    const sorted=[...found.values()].sort((a,b)=>b.rank-a.rank || a.entry.id-b.entry.id);
    return {best:sorted[0]||null, ambiguous:sorted.length>1,
      alternatives:sorted.slice(0,3), transcript:q};
  }
  // If the teacher uses a slightly different Russian formulation, use the
  // existing offline typo/synonym search; pick ONE of its top three hits.
  // A conservative cutoff prevents random background conversation from firing.
  function fuzzyVoiceMatch(transcript, rows) {
    const q = normalized(transcript);
    if (!q || !rows || !rows.length || typeof root.searchDictionaryDetailed !== 'function') return null;
    const words=q.split(' ');
    if (q.length < 5 || words.length > 13) return null;
    const options=root.searchDictionaryDetailed(rows,q,3);
    if (!options.length) return null;
    for (const hit of options.slice(0,3)) {
      const score=Number(hit.score);
      if (!Number.isFinite(score)) continue;
      const maxScore=words.length===1 ? 0.40 : words.length<=3 ? 0.50 : 0.44;
      if (score>maxScore) continue;
      // Avoid matching a short dictionary item to unrelated long speech.
      const entryWords=normalized(hit.entry.ru).split(' ').length;
      if (words.length>entryWords+5 && words.length>=5) continue;
      return {entry:hit.entry,text:hit.entry.ru,phrase:normalized(hit.entry.ru),
        words:entryWords,exact:score<=0.02,kind:'similar',rank:600-score*300,score};
    }
    return null;
  }
  function bestOfHypotheses(transcripts,rows) {
    let chosen=null;
    for (let i=0;i<Math.min(3,transcripts.length);i++) {
      const transcript=String(transcripts[i]||'');
      const direct=voiceMatch(transcript,rows);
      const candidate=direct.best || fuzzyVoiceMatch(transcript,rows);
      if(!candidate)continue;
      // Exact dictionary match wins over approximate; primary recognizer
      // hypothesis wins ties. Never send all variants.
      const score=candidate.rank-i*4;
      if (!chosen || score>chosen.score)chosen={doc:candidate,transcript,score};
    }
    return chosen;
  }
  // Find every non-overlapping dictionary phrase in one recognition segment.
  // A longer phrase beats a shorter word inside it ("компьютерная сеть" > "сеть").
  const phraseLookupCache = new WeakMap();
  function phraseLookup(rows) {
    let cached=phraseLookupCache.get(rows);
    if(cached)return cached;
    const byPhrase=new Map();let maxWords=1;
    for(const doc of buildIndex(rows)){
      if(doc.words===1 && STOP.has(doc.phrase))continue;
      maxWords=Math.max(maxWords,doc.words);
      if(!byPhrase.has(doc.phrase))byPhrase.set(doc.phrase,[]);
      byPhrase.get(doc.phrase).push(doc);
    }
    // Prefer the most stable dictionary ID if multiple English answers match.
    for(const docs of byPhrase.values())docs.sort((a,b)=>a.entry.id-b.entry.id);
    cached={byPhrase,maxWords};phraseLookupCache.set(rows,cached);
    return cached;
  }
  function findPhraseMatches(transcript, rows) {
    const q=normalized(transcript);
    if(!q||!rows?.length)return [];
    const tokens=q.split(' ');
    const {byPhrase,maxWords}=phraseLookup(rows);
    const found=[];
    for(let start=0;start<tokens.length;){
      let best=null;
      for(let size=Math.min(maxWords,tokens.length-start);size>0;size--){
        const phrase=tokens.slice(start,start+size).join(' ');
        const docs=byPhrase.get(phrase);
        if(!docs?.length)continue;
        const doc=docs[0];
        best={...doc,start,end:start+size,kind:'exact',exact:true,rank:10000+size*80,score:0};
        break;
      }
      if(best){found.push(best);start=best.end;}
      else start++;
    }
    return found;
  }
  function chooseSequentialHypothesis(transcripts, rows) {
    let chosen=null;
    for(let i=0;i<Math.min(3,transcripts?.length||0);i++){
      const transcript=String(transcripts[i]||'');
      let matches=findPhraseMatches(transcript,rows);
      // Fuzzy matching is allowed only when no exact words were found. Do not
      // guess extra words from unrelated conversational filler.
      if(!matches.length){
        const fuzzy=fuzzyVoiceMatch(transcript,rows);
        if(fuzzy)matches=[{...fuzzy,start:0,end:normalized(transcript).split(' ').length}];
      }
      if(!matches.length)continue;
      const coverage=matches.reduce((sum,m)=>sum+m.words,0);
      const confidence=matches.every(m=>m.kind==='exact')?50:0;
      const score=coverage*35+matches.length*11+confidence-i*8;
      if(!chosen||score>chosen.score)chosen={matches,transcript,score,alternative:i};
    }
    return chosen;
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
    const $=id=>root.document.getElementById(id);
    let recognition=null,wanted=false,active=false,startInFlight=false;
    let restartTimer=null,lastStarts=[],networkErrors=0;
    const segments=new Map();
    const outgoing=[];
    let draining=false,sentCount=0;
    function setStatus(value,warning=false){
      const el=$('voiceStatus');if(!el)return;
      el.textContent=value;el.classList.toggle('voice-error',!!warning);
    }
    function updateButton(){
      const btn=$('voiceToggle');if(!btn)return;
      btn.disabled=!SpeechRec;
      btn.classList.toggle('is-listening',wanted);
      btn.setAttribute('aria-pressed',String(wanted));
      btn.textContent=wanted?'■ Остановить прослушивание':'🎙 Включить микрофон';
      const badge=$('voiceBadge');
      if(badge)badge.textContent=wanted?(active?'● Слушаем без паузы':'◌ Переподключаем микрофон'):'○ Микрофон выключен';
    }
    function isEligible(){return wanted&&config.canListen()&&root.document.visibilityState==='visible';}
    function clearPending(state){
      for(const timer of state.pending.values())clearTimeout(timer);
      state.pending.clear();
    }
    function clearSegments(){for(const state of segments.values())clearPending(state);segments.clear();}
    function clearRestart(){if(restartTimer){clearTimeout(restartTimer);restartTimer=null;}}
    function showPicked(doc){
      const target=$('voiceOptions');if(!target)return;
      target.replaceChildren();
      if(!doc)return;
      const div=root.document.createElement('div');div.className='voice-choice voice-auto-picked';
      div.textContent='Последний автовыбор: '+doc.entry.en+' · '+doc.text;
      target.append(div);
    }
    // Requests must be sequential because the site's original sendWord() has
    // a sending flag. Without this queue, a second rapidly recognized word is
    // silently rejected while the first network request is still in flight.
    async function drain(){
      if(draining)return;
      draining=true;
      try{
        while(outgoing.length && isEligible()){
          const item=outgoing.shift();
          try{
            const ok=await config.send(item.doc.entry,item.doc.text);
            if(ok===false){setStatus('Не отправлено: '+item.doc.text+'. Проверь соединение.',true);}
            else{sentCount++;setStatus('✓ Отправлено '+sentCount+': '+item.doc.text+' → '+item.doc.entry.en+' · слушаю дальше');}
          }catch(_){setStatus('Ошибка отправки: '+item.doc.text+'. Проверь соединение.',true);}
        }
      }finally{draining=false;}
    }
    function enqueue(doc){
      if(!isEligible()||!doc)return;
      if(outgoing.length>=35){setStatus('Очередь переполнена. Проверь связь.',true);return;}
      outgoing.push({doc});
      showPicked(doc);
      setStatus('↗ Распознано: '+doc.text+' → '+doc.entry.en+' · отправляю, продолжаю слушать');
      void drain();
    }
    // Each recognition result index is an independent speech segment. Its sent
    // keys survive interim -> final changes. Repeating the same word in a NEW
    // segment sends it again, without the old global seven-second cooldown.
    function processSegment(index,result){
      if(!result||!result[0])return;
      let state=segments.get(index);
      if(!state){state={final:false,sent:new Set(),pending:new Map(),current:new Map()};segments.set(index,state);}
      if(state.final)return;
      const transcripts=[];
      for(let j=0;j<Math.min(3,result.length);j++){
        if(result[j]?.transcript)transcripts.push(String(result[j].transcript));
      }
      if(!transcripts.length)return;
      const first=$('voiceTranscript');if(first)first.textContent=transcripts[0];
      const selection=chooseSequentialHypothesis(transcripts,config.rows());
      const matches=selection?.matches||[];
      const counter=new Map();
      const present=new Map();
      for(const doc of matches){
        const ordinal=counter.get(doc.entry.id)||0;
        counter.set(doc.entry.id,ordinal+1);
        const key=String(doc.entry.id)+':'+ordinal;
        present.set(key,doc);
      }
      state.current=present;
      for(const [key,timer] of state.pending){
        if(!present.has(key)){clearTimeout(timer);state.pending.delete(key);}
      }
      if(result.isFinal){
        clearPending(state);
        state.final=true;
        for(const [key,doc] of present){
          if(state.sent.has(key))continue;
          state.sent.add(key);enqueue(doc);
        }
        return;
      }
      const fast=$('voiceSpeed')?.value!=='accurate';
      if(!fast)return;
      for(const [key,doc] of present){
        if(state.sent.has(key)||state.pending.has(key))continue;
        // A short 1-word match is especially likely to grow into a longer
        // phrase, so give it slightly longer to stabilize on interim results.
        const delay=doc.words===1?430:210;
        const timer=setTimeout(()=>{
          state.pending.delete(key);
          if(!isEligible()||state.final||state.sent.has(key)||!state.current.has(key))return;
          state.sent.add(key);enqueue(state.current.get(key));
        },delay);
        state.pending.set(key,timer);
      }
      if(matches.length)setStatus('Услышал: '+matches.map(x=>x.text).join(' · ')+' · отправляю автоматически');
    }
    function startRecognition(){
      if(!SpeechRec||!isEligible()||active||startInFlight)return;
      const now=Date.now();lastStarts=lastStarts.filter(t=>now-t<60000);
      if(lastStarts.length>=12){
        wanted=false;setStatus('Браузер слишком часто останавливает микрофон. Включи его снова.',true);updateButton();return;
      }
      clearRestart();clearSegments();
      try{
        recognition=new SpeechRec();
        recognition.lang='ru-RU';recognition.continuous=true;
        recognition.interimResults=true;recognition.maxAlternatives=3;
        recognition.onstart=()=>{active=true;startInFlight=false;networkErrors=0;updateButton();setStatus('🎙 Слушаю непрерывно. Каждое найденное слово отправляется отдельно.');};
        recognition.onresult=e=>{
          if(!isEligible())return;
          for(let i=e.resultIndex;i<e.results.length;i++)processSegment(i,e.results[i]);
        };
        recognition.onerror=e=>{
          const code=String(e.error||'');
          setStatus(allowedErrors[code]||'Ошибка распознавания: '+code,code!=='no-speech');
          if(['not-allowed','service-not-allowed','audio-capture','language-not-supported'].includes(code)){
            wanted=false;updateButton();
          }
          if(code==='network'&&++networkErrors>=3){wanted=false;updateButton();}
        };
        recognition.onend=()=>{
          active=false;startInFlight=false;
          if(isEligible()){
            // Mobile recognizers sometimes end a segment without isFinal.
            // Flush already-detected words, then resume listening.
            for(const state of segments.values()){
              if(state.final)continue;
              clearPending(state);
              for(const [key,doc] of state.current){
                if(!state.sent.has(key)){state.sent.add(key);enqueue(doc);}
              }
            }
            clearSegments();
            restartTimer=setTimeout(()=>{restartTimer=null;startRecognition();},350);
          }else clearSegments();
          updateButton();
        };
        startInFlight=true;lastStarts.push(now);recognition.start();
      }catch(e){
        startInFlight=false;active=false;wanted=false;
        setStatus('Не удалось запустить микрофон: '+e.message,true);updateButton();
      }
    }
    function stop(reason){
      wanted=false;clearRestart();clearSegments();outgoing.length=0;
      const old=recognition;recognition=null;
      if(old){old.onend=null;old.onerror=null;old.onresult=null;old.onstart=null;try{old.abort();}catch(_){}}
      active=false;startInFlight=false;updateButton();setStatus(reason||'Микрофон выключен.');
    }
    function init(){
      const button=$('voiceToggle');if(!button)return;
      button.addEventListener('click',()=>{
        if(wanted){stop();return;}
        if(!SpeechRec){setStatus('Браузер не поддерживает распознавание речи.',true);return;}
        if(!config.canListen()){setStatus('Сначала войди в комнату как отправитель.',true);return;}
        if(!config.rows().length){setStatus('Дождись загрузки словаря.',true);return;}
        wanted=true;updateButton();setStatus('Запрашиваю доступ к микрофону…');startRecognition();
      });
      if($('voiceSpeed'))$('voiceSpeed').addEventListener('change',()=>{
        for(const state of segments.values())clearPending(state);
      });
      root.document.addEventListener('visibilitychange',()=>{
        if(root.document.visibilityState!=='visible'&&wanted)
          stop('Страница свёрнута. После возвращения снова включи микрофон.');
      });
      setStatus(SpeechRec?'Нажми кнопку для непрерывного голосового поиска.':'Этот браузер не поддерживает распознавание речи. Используй клавиатуру.',!SpeechRec);
      updateButton();
    }
    return {init,stop,isEnabled:()=>wanted,match:voiceMatch,bestOfHypotheses,chooseSequentialHypothesis};
  }
  root.ECVoice={createController,voiceMatch,buildIndex,bestOfHypotheses,findPhraseMatches,chooseSequentialHypothesis};
  if(typeof module!=='undefined'&&module.exports)
    module.exports={createController,voiceMatch,buildIndex,normalized,bestOfHypotheses,findPhraseMatches,chooseSequentialHypothesis};
})(typeof window!=='undefined'?window:globalThis);
