/* ============================================================================
   Harness Learning — shared reader engine (reader.js)
   Document-style reading: left-anchored column + right "on this page" rail
   (scroll-spy), reading progress, code copy buttons, Mermaid click-to-zoom.
   Each project/paper page sets `window.READER` then loads this script.
   ============================================================================ */
(function(){
  const R = window.READER;
  if(!R){ console.error('reader.js: window.READER not set'); return; }
  const IS_SOURCE = R.kind === 'source';

  const view=document.getElementById('view'), topbar=document.getElementById('topbar'),
        crumb=document.getElementById('crumb'), crumbSep=document.getElementById('crumbSep'),
        progBar=document.getElementById('progBar'), volToc=document.getElementById('volToc'),
        volDiv=document.getElementById('volDiv'), volLabel=document.getElementById('volLabel'),
        spine=document.getElementById('spine'), scrim=document.getElementById('scrim');

  /* ── mermaid palette follows the active theme ── */
  let mermaidReady=false;
  /* ── cross-ref chapter deep-link state ── */
  let currentPart=null, pendingChapter=null;
  const cssVar=n=>getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  function hexLum(h){ h=h.replace('#',''); if(h.length===3)h=h.split('').map(c=>c+c).join(''); const r=parseInt(h.slice(0,2),16)/255,g=parseInt(h.slice(2,4),16)/255,b=parseInt(h.slice(4,6),16)/255; return 0.2126*r+0.7152*g+0.0722*b; }
  function initMermaid(){
    if(mermaidReady) return;
    const ink=cssVar('--ink'), ink3=cssVar('--ink-3'), bone=cssVar('--bone'), boneDim=cssVar('--bone-dim'), deep=cssVar('--accent-deep')||'#8a7456';
    const onLight = hexLum(ink||'#15110c') > 0.5;
    const fg=bone, line=boneDim;
    try{
      mermaid.initialize({startOnLoad:false, securityLevel:'loose', theme:onLight?'default':'dark', themeVariables:{
        background:ink3, primaryColor:ink3, primaryTextColor:fg, primaryBorderColor:deep, lineColor:line,
        secondaryColor:ink3, tertiaryColor:ink3, textColor:fg, edgeLabelBackground:ink3,
        fontFamily:'JetBrains Mono, monospace', fontSize:'14px', clusterBkg:ink3, clusterBorder:line,
        mainBkg:ink3, nodeBorder:deep, actorBkg:ink3, actorBorder:deep, actorTextColor:fg,
        signalColor:fg, labelTextColor:fg, labelBoxBkgColor:ink3, labelBoxBorderColor:deep
      }});
      mermaidReady=true;
    }catch(e){}
  }

  /* ── spine (this volume's parts) ── */
  function buildVolToc(current){
    if(!IS_SOURCE){ volDiv&&(volDiv.style.display='none'); volLabel&&(volLabel.style.display='none'); volToc&&(volToc.innerHTML=''); return; }
    volDiv&&(volDiv.style.display=''); volLabel&&(volLabel.style.display='');
    volToc.innerHTML=R.parts.map(pt=>{const [file,num,title]=pt,on=file===current;
      return `<a href="#${file}" data-part style="display:block;color:${on?'var(--accent)':'var(--mute)'};text-decoration:none;padding:3px 0">${num}　${title}</a>`;}).join('');
  }

  /* ── router ── */
  function route(){ closeSpine();
    if(IS_SOURCE){ const h=location.hash.replace(/^#/,''); if(h&&R.parts.some(p=>p[0]===h)) return loadPart(h); return renderCover(); }
    return loadPaper();
  }
  addEventListener('hashchange', route);

  /* ── project cover ── */
  function renderCover(){
    currentPart=null; topbar.classList.remove('show'); window.scrollTo(0,0); buildVolToc(null);
    crumb.textContent=R.home.title; crumbSep.style.display='inline';
    const total=R.parts.length;
    const vols=R.parts.map((pt,i)=>{const [file,num,title,essence,kw,size]=pt;
      return `<a class="vol stagger" style="animation-delay:${.08+i*.04}s" href="#${file}">
        <div class="numeral">${num}<span class="sub">PART · ${String(i).padStart(2,'0')} / ${String(total-1).padStart(2,'0')}</span></div>
        <div class="body"><h3>${title}</h3><p>${essence}</p><div class="kw">${kw.map(k=>`<span>${k}</span>`).join('')}</div></div>
        <div class="size"><b>${size}</b><span>chars</span><div class="arrow">→ read</div></div></a>`;}).join('');
    const tp=R.home.title.split(' ');
    view.innerHTML=`<section class="wrap"><header class="proj-head">
        <div class="pmark">${R.home.mark}</div><div class="pkw">source monograph</div>
        <h1>${tp[0]} <i>${tp.slice(1).join(' ')||''}</i></h1>
        <p class="blurb">${R.home.blurb}</p>
        <div class="auth"><span>作者 <b>${R.home.author}</b></span><span>更新 <b>${R.home.updated}</b></span>
        ${R.home.repo?`<span><a href="${R.home.repo}" target="_blank" rel="noopener">↗ upstream</a></span>`:''}<span>${R.home.statsLabel||''}</span></div>
      </header>
      <div class="shead"><span class="n">§ 目录</span><h2>Table of contents</h2><span class="rule"></span><span class="count">${total} 篇</span></div>
      <div class="toc">${vols}</div></section>`;
  }

  /* ── load + render a markdown doc ── */
  async function renderDoc(file,{num,idx,total,prev,next,isPart}){
    view.innerHTML=`<div class="read-layout"><div class="load"><span class="cad">${R.home.mark}</span><span class="t">opening</span></div></div>`;
    window.scrollTo(0,0); topbar.classList.add('show');
    let md;
    try{ const res=await fetch(file,{cache:'force-cache'}); if(!res.ok) throw new Error(res.status); md=await res.text(); }
    catch(e){ view.innerHTML=`<div class="read-layout"><div class="load" style="color:#bb6253"><span class="cad">${R.home.mark}</span><span class="t">failed · ${file}</span><br><span style="font-family:var(--f-mono);font-size:11px;color:var(--mute)">${e.message} — 本地预览需 http 服务器</span></div></div>`; return; }
    md=md.replace(/^\*\s*作者：[^\n]*\n+/m,'');
    const tm=md.match(/^#\s+.+/m); if(tm) md=md.slice(tm.index+tm[0].length).replace(/^\s+/,'');
    const clean=DOMPurify.sanitize(marked.parse(md),{ADD_ATTR:['target','rel','data']});
    const pnav=isPart?`<nav class="partnav">
      ${prev?`<a class="prev" href="#${prev[0]}"><span class="dir">← 第${prev[1]}篇</span><span class="ttl">${prev[2]}</span></a>`:'<a class="phantom"></a>'}
      ${next?`<a class="next" href="#${next[0]}"><span class="dir">第${next[1]}篇 →</span><span class="ttl">${next[2]}</span></a>`:'<a class="phantom"></a>'}</nav>`:'';
    const eyebrow=isPart?`PART ${num} · ${String(idx).padStart(2,'0')} / ${String(total-1).padStart(2,'0')}`:'PAPER · ARTICLE';

    view.innerHTML=`<div class="read-layout">
      <article class="reader">
        <header class="part-head">
          <div class="part-eyebrow">${eyebrow}</div>
          <h1>${isPart?R.parts[idx][2]:R.home.title}</h1>
          <div class="auth"><span>作者 <b>${R.home.author}</b></span><span>更新 <b>${R.home.updated}</b></span>${R.home.repo?`<span><a href="${R.home.repo}" target="_blank" rel="noopener">↗ source</a></span>`:''}</div>
        </header>
        <div class="prose" id="prose">${clean}</div>
        ${pnav}
      </article>
      <aside class="toc-rail" id="tocRail"><div class="toc-rail-inner"><p class="rail-label">本章</p><ul id="railList"></ul></div></aside>
    </div>`;
    postProcess(); buildRail(); setupScrollSpy(); trackScroll();
    if(pendingChapter!=null){ const ch=pendingChapter; pendingChapter=null; setTimeout(()=>scrollToChapter(ch),80); }
  }
  function loadPart(file){const idx=R.parts.findIndex(p=>p[0]===file); if(idx<0){renderCover();return;}
    currentPart=file;
    const total=R.parts.length,[,num]=R.parts[idx],prev=idx>0?R.parts[idx-1]:null,next=idx<total-1?R.parts[idx+1]:null;
    crumb.textContent=`${R.home.title} · 第${num}篇`; crumbSep.style.display='inline'; buildVolToc(file);
    renderDoc(`./${file}.md`,{num,idx,total,prev,next,isPart:true});}
  function loadPaper(){crumb.textContent=R.home.title; crumbSep.style.display='inline'; buildVolToc(null); renderDoc(`./${R.paper.file}.md`,{isPart:false});}

  /* ── post-process rendered markdown ── */
  function postProcess(){
    initMermaid();
    const prose=document.getElementById('prose'); if(!prose) return;
    const slugs=new Set();
    prose.querySelectorAll('h2,h3').forEach(h=>{
      let s=(h.textContent||'').trim().toLowerCase().replace(/[^\p{L}\p{N}一-鿿]+/gu,'-').replace(/^-|-$/g,'').slice(0,60)||'sec';
      let base=s,i=2; while(slugs.has(s)){s=base+'-'+i++} slugs.add(s); h.id=s;
    });
    const merms=[];
    prose.querySelectorAll('pre code.language-mermaid').forEach(code=>{const pre=code.closest('pre'),div=document.createElement('div'); div.className='mermaid'; div.textContent=code.textContent; pre.replaceWith(div); merms.push(div);});
    prose.querySelectorAll('pre code:not(.language-mermaid)').forEach(b=>{try{hljs.highlightElement(b)}catch(e){}});
    // code copy buttons + lang labels
    prose.querySelectorAll('pre').forEach(pre=>{
      const code=pre.querySelector('code'); if(!code) return;
      pre.classList.add('codeblock');
      const langM=(code.className.match(/language-([\w-]+)/)||[])[1];
      if(langM) pre.dataset.lang=langM;
      const btn=document.createElement('button'); btn.className='code-copy'; btn.type='button'; btn.textContent='复制'; btn.setAttribute('aria-label','复制代码');
      btn.addEventListener('click',()=>{const txt=code.textContent; (navigator.clipboard?navigator.clipboard.writeText(txt):Promise.reject()).then(()=>{btn.textContent='已复制';setTimeout(()=>btn.textContent='复制',1400);}).catch(()=>{const ta=document.createElement('textarea');ta.value=txt;document.body.appendChild(ta);ta.select();try{document.execCommand('copy');btn.textContent='已复制';setTimeout(()=>btn.textContent='复制',1400);}catch(e){}ta.remove();});});
      pre.appendChild(btn);
    });
    prose.querySelectorAll('a[href^="http"]').forEach(a=>{a.target='_blank';a.rel='noopener';});
    if(IS_SOURCE){ prose.querySelectorAll('a[href]').forEach(a=>{
      const m=(a.getAttribute('href')||'').match(/^(part-[\w-]+)\.md(?:#(.*))?$/);
      if(!m) return;
      const file=m[1], ch=parseChapterNum(m[2]||'');
      a.title='在本卷中打开 · '+file+(ch?(' · 第 '+ch+' 章'):'');
      a.addEventListener('click',e=>{
        e.preventDefault();
        if(currentPart===file) scrollToChapter(ch);          // same part → scroll now
        else { pendingChapter=ch; location.hash='#'+file; }  // other part → load, then scroll
      });
    }); }
    if(merms.length&&mermaidReady){ merms.forEach((d,i)=>d.id='m-'+i);
      mermaid.run({nodes:merms}).then(()=>merms.forEach(attachZoom)).catch(()=>merms.forEach(d=>{d.classList.add('mermaid-error');d.textContent='♢ diagram render error';}));
    }
    // also allow clicking mermaid even if render resolves later
    setTimeout(()=>merms.forEach(attachZoom), 500);
  }

  /* ── right rail outline + scroll-spy ── */
  function buildRail(){
    const list=document.getElementById('railList'),prose=document.getElementById('prose'),rail=document.getElementById('tocRail');
    if(!list||!prose) return;
    const hs=prose.querySelectorAll('h2,h3');
    if(hs.length<3){ if(rail) rail.style.display='none'; return; }
    list.innerHTML=Array.from(hs).map(h=>`<li class="${h.tagName==='H3'?'lvl3':''}"><a href="#${h.id}" data-target="${h.id}">${h.textContent.replace(/^§\s*/,'').slice(0,40)}</a></li>`).join('');
    // Rail clicks scroll within the page; they must NOT touch location.hash —
    // the router is hash-driven, so an unknown (heading) hash would reload the cover.
    list.querySelectorAll('a').forEach(a=>a.addEventListener('click',e=>{
      e.preventDefault();
      const t=document.getElementById(a.dataset.target);
      if(t) t.scrollIntoView({behavior:'smooth',block:'start'}); /* scroll-margin-top:78px offsets the fixed topbar */
    }));
  }
  function setupScrollSpy(){
    const rail=document.getElementById('tocRail'); if(!rail||rail.style.display==='none') return;
    const links=[...document.querySelectorAll('#railList a')];
    const heads=[...document.querySelectorAll('#prose h2, #prose h3')];
    if(!heads.length) return;
    let activeId=null;
    const setActive=id=>{ if(id===activeId) return; activeId=id; links.forEach(a=>a.classList.toggle('active', a.dataset.target===id)); };
    const io=new IntersectionObserver((ents)=>{ ents.forEach(en=>{ if(en.isIntersecting) setActive(en.target.id); }); }, {rootMargin:'-72px 0px -68% 0px', threshold:0});
    heads.forEach(h=>io.observe(h));
  }

  /* ── chapter deep-link helpers ── */
  // parse "第 N 章" out of an explicit href fragment (#第4章, #第 4 章, #第1章).
  // Cross-refs MUST carry the fragment; link text is not consulted.
  function parseChapterNum(s){
    if(!s) return null;
    let m=s.match(/第\s*(\d+)\s*章/); if(m) return parseInt(m[1],10);     // 第 4 章
    m=s.match(/第\s*(\d+)[^第]*章/); if(m) return parseInt(m[1],10);       // 第 1、4 章 → first
    const cn=s.match(/第\s*([一二三四五六七八九十]+)\s*章/); if(cn){
      const t=cn[1], v={一:1,二:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};
      if(t==='十') return 10;
      if(t[0]==='十') return 10+(v[t[1]]||0);
      if(t[t.length-1]==='十') return (v[t[0]]||0)*10;
      const i=t.indexOf('十'); if(i>0) return (v[t[0]]||0)*10+(v[t[i+1]]||0);
      return v[t]||null;
    }
    return null;
  }
  function scrollToChapter(ch){
    if(ch==null) return;
    const prose=document.getElementById('prose'); if(!prose) return;
    const h=[...prose.querySelectorAll('h2')].find(el=>parseChapterNum(el.textContent)===ch);
    if(h) h.scrollIntoView({behavior:'smooth',block:'start'}); /* scroll-margin-top:78px offsets the fixed topbar */
  }

  function trackScroll(){ const f=()=>{const h=document.documentElement.scrollHeight-innerHeight;progBar.style.width=(h>0?Math.min(1,scrollY/h):0)*100+'%';}; f(); addEventListener('scroll',f,{passive:true}); }

  /* ── Mermaid click-to-zoom lightbox ── */
  function ensureLightbox(){
    let lb=document.getElementById('lightbox'); if(lb) return lb;
    lb=document.createElement('div'); lb.id='lightbox'; lb.className='lightbox'; lb.innerHTML='<button class="lb-close" aria-label="关闭">×</button><div class="lb-stage"></div><div class="lb-hint">滚轮缩放 · 拖动平移 · ESC 关闭</div>';
    document.body.appendChild(lb);
    const close=()=>{ lb.classList.remove('show'); document.body.style.overflow=''; lb._stage.firstChild&&(lb._stage.firstChild.remove()); };
    lb._stage=lb.querySelector('.lb-stage');
    lb.addEventListener('click',e=>{ if(e.target===lb||e.target.classList.contains('lb-stage')||e.target.classList.contains('lb-close')) close(); });
    addEventListener('keydown',e=>{ if(e.key==='Escape'&&lb.classList.contains('show')) close(); });
    // wheel zoom
    lb._stage.addEventListener('wheel',e=>{ if(!lb.classList.contains('show'))return; e.preventDefault(); const s=lb._scale; lb._scale=Math.max(.4,Math.min(6, s*(e.deltaY<0?1.12:0.89))); applyLb(lb); },{passive:false});
    // drag pan
    let drag=false,sx=0,sy=0,ox=0,oy=0;
    lb._stage.addEventListener('mousedown',e=>{ drag=true; sx=e.clientX; sy=e.clientY; ox=lb._tx; oy=lb._ty; lb._stage.style.cursor='grabbing'; });
    addEventListener('mousemove',e=>{ if(!drag)return; lb._tx=ox+(e.clientX-sx); lb._ty=oy+(e.clientY-sy); applyLb(lb); });
    addEventListener('mouseup',()=>{ drag=false; lb._stage.style.cursor=''; });
    lb._close=close; return lb;
  }
  function applyLb(lb){ const el=lb._stage.firstChild; if(el) el.style.transform=`translate(${lb._tx||0}px, ${lb._ty||0}px) scale(${lb._scale||1})`; }
  function attachZoom(node){
    if(node.__zoom) return; node.__zoom=true; node.classList.add('zoomable'); node.title='点击放大';
    const svg=()=>node.querySelector('svg');
    node.addEventListener('click',()=>{ const s=svg(); if(!s) return; const lb=ensureLightbox(); lb._stage.innerHTML=''; const c=s.cloneNode(true); c.style.maxWidth='92vw'; c.style.maxHeight='82vh'; c.style.width=''; c.style.height=''; lb._stage.appendChild(c); lb._scale=1; lb._tx=0; lb._ty=0; applyLb(lb); lb.classList.add('show'); document.body.style.overflow='hidden'; });
  }

  /* ── mobile spine ── */
  function closeSpine(){ spine&&spine.classList.remove('open'); scrim&&scrim.classList.remove('show'); }
  const menuBtn=document.getElementById('menuBtn');
  menuBtn&&menuBtn.addEventListener('click',()=>spine.classList.add('open'));
  scrim&&scrim.addEventListener('click',closeSpine);
  if(spine) new MutationObserver(()=>scrim.classList.toggle('show',spine.classList.contains('open'))).observe(spine,{attributes:true,attributeFilter:['class']});

  marked.use({gfm:true,breaks:false});

  /* ── dark/light scheme toggle (overlays any data-theme) ── */
  const SUN='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.4M12 19.1v2.4M4.3 4.3l1.7 1.7M18 18l1.7 1.7M2.5 12h2.4M19.1 12h2.4M4.3 19.7 6 18M18 6l1.7-1.7"/></svg>';
  const MOON='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.6 14.2A8.6 8.6 0 0 1 9.8 3.4a8.6 8.6 0 1 0 10.8 10.8Z"/></svg>';
  function currentScheme(){ return document.documentElement.dataset.scheme==='dark' ? 'dark' : 'light'; }
  function applyScheme(s, save){
    if(s==='dark') document.documentElement.dataset.scheme='dark';
    else delete document.documentElement.dataset.scheme;
    if(save){ try{ localStorage.setItem('hl-scheme', s); }catch(e){} }
    document.querySelectorAll('.scheme-btn').forEach(b=>{ b.innerHTML = s==='dark' ? SUN : MOON; b.title = s==='dark' ? '切换到亮色' : '切换到暗色'; b.setAttribute('aria-label', b.title); });
  }
  function makeSchemeBtn(){
    const b=document.createElement('button');
    b.className='scheme-btn'; b.type='button';
    b.addEventListener('click',()=>{
      const next = currentScheme()==='dark' ? 'light' : 'dark';
      applyScheme(next, true);
      mermaidReady=false;                    // force re-init with the new palette
      route();                               // re-render current page (mermaid redraws)
    });
    return b;
  }
  if(topbar && !topbar.querySelector('.scheme-btn')){
    const btn=makeSchemeBtn();
    // place before the GitHub link so icons sit together at the right end
    const gh=topbar.querySelector('.gh-link');
    gh ? topbar.insertBefore(btn, gh) : topbar.appendChild(btn);
  }
  const spineFoot=document.querySelector('.spine .foot');
  if(spineFoot && !spineFoot.querySelector('.scheme-btn')) spineFoot.prepend(makeSchemeBtn());

  /* initial scheme: saved pref, else system preference (page head already set it pre-CSS) */
  let savedScheme=null; try{ savedScheme=localStorage.getItem('hl-scheme'); }catch(e){}
  applyScheme(savedScheme || currentScheme(), false);

  /* ── GitHub icon in the topbar (links to this site's repo) ── */
  if(topbar && !topbar.querySelector('.gh-link')){
    const gh=document.createElement('a');
    gh.className='gh-link';
    gh.href='https://github.com/amlei/harness-learning';
    gh.target='_blank'; gh.rel='noopener';
    gh.title='GitHub 仓库';
    gh.setAttribute('aria-label','GitHub 仓库');
    gh.innerHTML='<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>';
    topbar.appendChild(gh);
  }

  buildVolToc(null);
  route();
})();
