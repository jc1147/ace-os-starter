// sitemap.js - your memory map. Reads /api/sitemap (the build-sitemap data) and /api/note; posts
// corrections to /api/corrections. Hash routes: #/ (home), #/s/<section>[/<topic>], #/n/<note stem>.
// Everything that comes from the data is escaped here; a note body arrives as HTML the server built after
// escaping the note text.
(function () {
  'use strict';
  var INBOX_SLUG = 'unsorted/needs-a-home';
  var MAX_TEXT = 2000;
  var view = document.getElementById('view');
  var qEl = document.getElementById('q');
  var hitsEl = document.getElementById('hits');
  var themeBtn = document.getElementById('theme');
  var D = null, stale = null, loadError = null;
  var secBySlug = {}, topicBySlug = {}, byStem = {}, searchIndex = [];

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function stemOf(file) { return String(file).replace(/\.md$/i, ''); }
  function noteHref(file) { return '#/n/' + encodeURIComponent(stemOf(file)); }
  function secHref(slug, topic) { return '#/s/' + encodeURIComponent(slug) + (topic ? '/' + encodeURIComponent(topic.split('/').pop()) : ''); }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function niceDate(d) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || ''));
    if (!m) return d ? String(d) : 'no date';
    return Number(m[3]) + ' ' + MONTHS[Number(m[2]) - 1] + ' ' + m[1];
  }
  var DATE_SOURCE = {
    'metadata': 'the date set in the note',
    'note-text': 'the newest date written in the note',
    'mtime': 'the file time',
    'mtime-restamped': 'the file time, which may be unreliable (a bulk copy or checkout restamps it)'
  };
  function homeParts(slug) {
    if (!slug || slug === INBOX_SLUG) return { sec: null, topic: null, label: 'Needs a home' };
    var t = topicBySlug[slug];
    if (!t) return { sec: null, topic: null, label: slug };
    return { sec: t.sec, topic: t.topic, label: t.sec.name + ' > ' + t.topic.name };
  }

  // ---------- theme (per viewer; the dashboard itself is dark) ----------
  function currentTheme() { return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'; }
  function paintThemeBtn() { themeBtn.textContent = currentTheme() === 'light' ? 'Dark' : 'Light'; }
  themeBtn.addEventListener('click', function () {
    var next = currentTheme() === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('sitemap-theme', next); } catch (e) { /* storage blocked: the switch still works for this view */ }
    paintThemeBtn();
  });
  paintThemeBtn();
  try { new MutationObserver(paintThemeBtn).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] }); } catch (e) { /* the button still works without it */ }

  // ---------- data ----------
  function indexData() {
    secBySlug = {}; topicBySlug = {}; byStem = {}; searchIndex = [];
    (D.sections || []).forEach(function (s) {
      secBySlug[s.slug] = s;
      (s.topics || []).forEach(function (t) { topicBySlug[t.slug] = { sec: s, topic: t }; });
    });
    Object.keys(D.notes || {}).forEach(function (f) {
      var n = D.notes[f];
      byStem[stemOf(f).toLowerCase()] = f;
      var h = homeParts(n.home);
      searchIndex.push({ kind: 'note', file: f, title: n.title || stemOf(f), desc: n.description || '', where: h.label, typeLabel: n.typeLabel || '',
        hay: [(n.title || ''), stemOf(f).replace(/[_-]+/g, ' '), (n.description || ''), h.topic ? h.topic.name : ''].join(' \u0001 ').toLowerCase() });
    });
    (D.sections || []).forEach(function (s) {
      (s.topics || []).forEach(function (t) {
        searchIndex.push({ kind: 'topic', sec: s, topic: t, title: t.name, desc: t.scope || '', where: s.name, hay: [t.name, t.scope || '', s.name].join(' \u0001 ').toLowerCase() });
      });
    });
  }
  function load() {
    return fetch('/api/sitemap', { cache: 'no-store', headers: { Accept: 'application/json' } }).then(function (r) {
      stale = r.headers.get('X-Sitemap-Stale') ? (r.headers.get('X-Sitemap-Error') || 'the last rebuild failed') : null;
      return r.json().then(function (j) { if (!r.ok) throw new Error(j && j.error ? j.error : 'HTTP ' + r.status); return j; });
    }).then(function (j) { D = j; loadError = null; indexData(); }, function (e) { loadError = e.message || String(e); });
  }

  // ---------- search ----------
  var hitList = [], hitSel = -1;
  function highlight(text, terms) {
    var s = String(text || '');
    if (!terms.length) return esc(s);
    var low = s.toLowerCase(), marks = [];
    terms.forEach(function (t) { var i = 0; while (t && (i = low.indexOf(t, i)) >= 0) { marks.push([i, i + t.length]); i += t.length; } });
    marks.sort(function (a, b) { return a[0] - b[0]; });
    var out = '', pos = 0;
    marks.forEach(function (m) { if (m[0] < pos) return; out += esc(s.slice(pos, m[0])) + '<mark>' + esc(s.slice(m[0], m[1])) + '</mark>'; pos = m[1]; });
    return out + esc(s.slice(pos));
  }
  function runSearch(q) {
    var terms = q.toLowerCase().replace(/^\s*(what do i know about|about)\s+/, '').split(/\s+/).filter(function (t) { return t.length > 0; });
    if (!terms.length || !D) { hitList = []; return terms; }
    var phrase = terms.join(' ');
    var scored = [];
    searchIndex.forEach(function (e) {
      for (var i = 0; i < terms.length; i++) if (e.hay.indexOf(terms[i]) < 0) return;
      var tl = e.title.toLowerCase(), score = 0;
      terms.forEach(function (t) { if (tl.indexOf(t) >= 0) score += 3; else if (e.desc.toLowerCase().indexOf(t) >= 0) score += 1; else score += 0.5; });
      if (tl.indexOf(phrase) >= 0) score += 4;
      if (e.kind === 'topic') score += 1.5;
      scored.push({ e: e, s: score });
    });
    scored.sort(function (a, b) { return b.s - a.s || a.e.title.localeCompare(b.e.title); });
    hitList = scored.slice(0, 40).map(function (x) { return x.e; });
    return terms;
  }
  function paintHits(terms) {
    hitSel = -1;
    if (!qEl.value.trim()) { hitsEl.classList.remove('on'); hitsEl.innerHTML = ''; return; }
    if (!hitList.length) { hitsEl.innerHTML = '<div class="hits-empty">Nothing in memory matches that yet.</div>'; hitsEl.classList.add('on'); return; }
    hitsEl.innerHTML = hitList.map(function (h, i) {
      var href = h.kind === 'note' ? noteHref(h.file) : secHref(h.sec.slug, h.topic.slug);
      var where = h.kind === 'note' ? (h.typeLabel ? h.typeLabel + ' in ' : 'In ') + h.where : 'Topic in ' + h.where;
      return '<a class="hit" role="option" data-i="' + i + '" href="' + esc(href) + '"><b>' + highlight(h.title, terms) + '</b><span>' + esc(where) +
        (h.desc ? ' · ' + highlight(h.desc, terms) : '') + '</span></a>';
    }).join('');
    hitsEl.classList.add('on');
  }
  function moveSel(d) {
    var items = hitsEl.querySelectorAll('.hit');
    if (!items.length) return;
    hitSel = (hitSel + d + items.length) % items.length;
    items.forEach(function (el, i) { el.classList.toggle('sel', i === hitSel); });
    items[hitSel].scrollIntoView({ block: 'nearest' });
  }
  qEl.addEventListener('input', function () { paintHits(runSearch(qEl.value)); });
  qEl.addEventListener('focus', function () { if (qEl.value.trim()) paintHits(runSearch(qEl.value)); });
  qEl.addEventListener('keydown', function (ev) {
    if (ev.key === 'ArrowDown') { ev.preventDefault(); moveSel(1); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); moveSel(-1); }
    else if (ev.key === 'Enter') { var items = hitsEl.querySelectorAll('.hit'); var el = items[hitSel >= 0 ? hitSel : 0]; if (el) { location.hash = el.getAttribute('href'); closeHits(); } }
    else if (ev.key === 'Escape') { qEl.value = ''; closeHits(); qEl.blur(); }
  });
  function closeHits() { hitsEl.classList.remove('on'); }
  hitsEl.addEventListener('click', function (ev) { if (ev.target.closest('.hit')) closeHits(); });
  document.addEventListener('click', function (ev) { if (!ev.target.closest('.search')) closeHits(); });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === '/' && document.activeElement !== qEl && !/^(INPUT|TEXTAREA)$/.test((document.activeElement || {}).tagName || '')) { ev.preventDefault(); qEl.focus(); }
  });

  // ---------- views ----------
  function staleBanner() { return stale ? '<p class="err" style="margin:0 0 18px">This map may be out of date: ' + esc(stale) + '</p>' : ''; }
  function noteLi(f, small) {
    var n = D.notes[f];
    if (!n) return '<li><span class="muted">' + esc(f) + '</span></li>';
    if (small) return '<li><a href="' + esc(noteHref(f)) + '">' + esc(n.title) + '</a> <span class="muted">' + esc(n.typeLabel || '') + '</span></li>';
    return '<li><a class="t" href="' + esc(noteHref(f)) + '" title="' + esc(n.title) + '">' + esc(n.title) + '</a>' +
      '<span class="r"><span class="tlabel t-' + esc(n.type) + '">' + esc(n.typeLabel || n.type) + '</span><span class="d" title="Last update, from ' + esc(DATE_SOURCE[n.dateSource] || n.dateSource || 'unknown') + '">' + esc(niceDate(n.date)) + '</span></span>' +
      (n.description ? '<span class="desc" title="' + esc(n.description) + '">' + esc(n.description) + '</span>' : '') + '</li>';
  }
  function alertBox(title, sub, files, extra) {
    if (!files.length) return '';
    return '<details class="alert"><summary><b>' + esc(title) + ' (' + files.length + ')</b><span>' + esc(sub) + '</span><i>show</i></summary><ul>' +
      files.map(function (f) { var n = D.notes[f]; return '<li><a href="' + esc(noteHref(f)) + '">' + esc(n ? n.title : f) + '</a><span class="muted">' + esc(extra(f)) + '</span></li>'; }).join('') + '</ul></details>';
  }
  function renderHome() {
    document.title = 'Memory sitemap';
    var inbox = (D.inbox || []).map(function (x) { return x.file; });
    var since = {}; (D.inbox || []).forEach(function (x) { since[x.file] = x.since; });
    var review = D.needsReview || [];
    var topics = 0; (D.sections || []).forEach(function (s) { topics += (s.topics || []).length; });
    var week = 0; (D.sections || []).forEach(function (s) { week += s.changedThisWeek || 0; });
    var h = staleBanner();
    if (inbox.length || review.length) {
      h += '<div class="alerts">' +
        alertBox('Needs a home', 'new notes the filing step could not place', inbox, function (f) { return 'since ' + niceDate(since[f]); }) +
        alertBox('Needs a second look', 'placed, but the filing was a guess', review, function (f) { var p = homeParts(D.notes[f] && D.notes[f].home); return p.label; }) +
        '</div>';
    }
    h += '<div class="stats"><span><b>' + (D.noteCount || 0) + '</b> notes</span><span><b>' + (D.sections || []).length + '</b> sections</span><span><b>' + topics +
      '</b> topics</span><span><b>' + week + '</b> changed this week</span><span>map built ' + esc(niceDate(D.built)) + ' ' + esc(String(D.built || '').slice(11, 16)) + ' UTC</span></div>';
    h += '<div class="cards">' + (D.sections || []).map(function (s) {
      return '<a class="card" href="' + esc(secHref(s.slug)) + '"><div class="ch"><h3>' + esc(s.name) + '</h3><span class="n" title="Notes filed here">' + (s.count || 0) + '</span></div>' +
        '<p class="scope">' + esc(s.scope || '') + '</p>' +
        '<div class="topics">' + (s.topics || []).map(function (t) { return '<span title="' + esc(t.scope || '') + '">' + esc(t.name) + '<em>' + (t.count || 0) + '</em></span>'; }).join('') + '</div>' +
        '<div class="foot">' + (s.changedThisWeek ? '<span class="chip new">' + plural(s.changedThisWeek, 'changed this week', 'changed this week') + '</span>' : '<span class="chip">no changes this week</span>') +
        ((s.skills || []).length ? '<span class="chip">' + plural(s.skills.length, 'playbook') + '</span>' : '') + '</div></a>';
    }).join('') + '</div>';
    view.innerHTML = h;
  }
  function renderSection(slug, topicTail) {
    var s = secBySlug[slug];
    if (!s) { view.innerHTML = '<p class="err">There is no section called "' + esc(slug) + '". <a href="#/">See all sections</a>.</p>'; return; }
    document.title = s.name + ' - Memory sitemap';
    var skills = (D.skills || []).filter(function (k) { return k.section === s.slug; });
    var h = staleBanner() + '<nav class="crumbs"><a href="#/">All sections</a><span class="sep">/</span><span>' + esc(s.name) + '</span></nav>' +
      '<div class="pagehead"><h2>' + esc(s.name) + '</h2><p>' + esc(s.scope || '') + '</p><div class="meta"><span class="chip">' + plural(s.count || 0, 'note') + '</span><span class="chip">' +
      plural((s.topics || []).length, 'topic') + '</span>' + (s.changedThisWeek ? '<span class="chip new">' + s.changedThisWeek + ' changed this week</span>' : '') + '</div></div>';
    h += '<div class="groups">' + (s.topics || []).map(function (t) {
      var tail = t.slug.split('/').pop();
      return '<section class="group" id="t-' + esc(tail) + '"><h3>' + esc(t.name) + '<span class="chip">' + (t.count || 0) + '</span></h3><p class="scope">' + esc(t.scope || '') + '</p>' +
        ((t.notes || []).length ? '<ul class="notes">' + t.notes.map(function (f) { return noteLi(f, false); }).join('') + '</ul>' : '<p class="muted">No notes filed here yet.</p>') +
        ((t.also || []).length ? '<div class="also"><h4>Also relevant here</h4><ul>' + t.also.map(function (f) { return noteLi(f, true); }).join('') + '</ul></div>' : '') +
        '</section>';
    }).join('') + '</div>';
    if (skills.length) {
      h += '<div class="playbooks"><h3>Playbooks</h3><p>The skills that do the work this section is about.</p><div class="list">' + skills.map(function (k) {
        var t = topicBySlug[k.topic];
        return '<span>/' + esc(k.skill) + (t ? '<em>' + esc(t.topic.name) + '</em>' : '') + '</span>';
      }).join('') + '</div></div>';
    }
    view.innerHTML = h;
    if (topicTail) { var el = document.getElementById('t-' + topicTail); if (el) el.scrollIntoView({ block: 'start' }); }
  }
  function renderNote(stem) {
    var file = byStem[String(stem).toLowerCase()] || (stem + '.md');
    var n0 = D.notes[file];
    document.title = (n0 ? n0.title : stem) + ' - Memory sitemap';
    view.innerHTML = '<p class="empty">Loading the note...</p>';
    var token = stem;
    fetch('/api/note?id=' + encodeURIComponent(stemOf(file)), { cache: 'no-store', headers: { Accept: 'application/json' } }).then(function (r) {
      return r.json().then(function (j) { if (!r.ok) throw new Error(j && j.error ? j.error : 'HTTP ' + r.status); return j; });
    }).then(function (n) {
      if (currentRoute.stem !== token) return;
      paintNote(n);
    }, function (e) {
      if (currentRoute.stem !== token) return;
      view.innerHTML = '<nav class="crumbs"><a href="#/">All sections</a></nav><p class="err">Could not open "' + esc(stem) + '": ' + esc(e.message || e) + '.</p>';
    });
  }
  function linkList(files) {
    files = (files || []).filter(function (f) { return D.notes[f]; });
    if (!files.length) return '<p class="muted" style="margin:0;font-size:13px">None</p>';
    return '<ul>' + files.map(function (f) { return '<li><a href="' + esc(noteHref(f)) + '" title="' + esc(D.notes[f].title) + '">' + esc(D.notes[f].title) + '</a></li>'; }).join('') + '</ul>';
  }
  function paintNote(n) {
    var hp = homeParts(n.home);
    var crumbs = '<nav class="crumbs"><a href="#/">All sections</a><span class="sep">/</span>' +
      (hp.sec ? '<a href="' + esc(secHref(hp.sec.slug)) + '">' + esc(hp.sec.name) + '</a><span class="sep">&gt;</span><a href="' + esc(secHref(hp.sec.slug, hp.topic.slug)) + '">' + esc(hp.topic.name) + '</a>'
        : '<span>' + esc(hp.label) + '</span>') + '</nav>';
    var also = (n.also || []).map(function (t) { var p = homeParts(t); return p.sec ? '<li><a href="' + esc(secHref(p.sec.slug, p.topic.slug)) + '">' + esc(p.label) + '</a></li>' : ''; }).join('');
    var h = crumbs + '<div class="pagehead"><h2>' + esc(n.title || n.id) + '</h2>' + (n.description ? '<p class="lede">' + esc(n.description) + '</p>' : '') +
      '<div class="meta"><span class="tlabel t-' + esc(n.type) + '">' + esc(n.typeLabel || n.type || 'Note') + '</span><span class="chip">Updated ' + esc(niceDate(n.date)) + '</span>' +
      (n.confidence === 'low' ? '<span class="chip warn">filing is a guess</span>' : '') + (n.inSitemap === false ? '<span class="chip warn">not in the map yet</span>' : '') + '</div></div>' +
      '<div class="notepage"><article class="body">' + (n.html || '<p class="muted">This note has no text.</p>') + '</article><aside class="side">' +
      '<div class="box wrong" id="wrong"><h4>Is this note wrong?</h4><p>Tell Claude what is wrong. It is saved and shown at the start of the next session.</p>' +
      '<button class="btn primary" type="button" id="wrongOpen">This is wrong</button></div>' +
      '<div class="box"><h4>Where it lives</h4><dl><dt>Home</dt><dd>' + (hp.sec ? '<a href="' + esc(secHref(hp.sec.slug, hp.topic.slug)) + '">' + esc(hp.label) + '</a>' : esc(hp.label)) + '</dd>' +
      '<dt>Updated</dt><dd>' + esc(niceDate(n.date)) + '<br><span class="muted">from ' + esc(DATE_SOURCE[n.dateSource] || n.dateSource || 'unknown') + '</span></dd>' +
      '<dt>File</dt><dd><span class="muted">' + esc(n.file || '') + '</span></dd></dl>' + (also ? '<h4 style="margin-top:12px">Also filed under</h4><ul>' + also + '</ul>' : '') + '</div>' +
      '<div class="box"><h4>Links to</h4>' + linkList(n.links) + '</div>' +
      '<div class="box"><h4>Linked from</h4>' + linkList(n.linkedFrom) + '</div>' +
      '</aside></div>';
    view.innerHTML = h;
    // a bare [[stem]] link shows the linked note's readable title instead of its file stem
    view.querySelectorAll('article.body a.wl').forEach(function (a) {
      var m = /^#\/n\/(.+)$/.exec(a.getAttribute('href') || ''), f = m ? byStem[decodeURIComponent(m[1]).toLowerCase()] : null;
      if (f && D.notes[f] && a.textContent.toLowerCase() === stemOf(f).toLowerCase()) { a.textContent = D.notes[f].title; a.title = stemOf(f); }
    });
    wireWrong(n);
  }
  function wireWrong(n) {
    var box = document.getElementById('wrong');
    document.getElementById('wrongOpen').addEventListener('click', function () {
      box.innerHTML = '<h4>What is wrong with this note?</h4><textarea id="wrongText" maxlength="' + MAX_TEXT + '" placeholder="For example: this changed in October, the price is now ..."></textarea>' +
        '<div class="row"><button class="btn primary" type="button" id="wrongSend" disabled>Save</button><button class="btn" type="button" id="wrongCancel">Cancel</button>' +
        '<span class="count" id="wrongCount">0 / ' + MAX_TEXT + '</span></div><div class="fail" id="wrongFail" role="alert"></div>';
      var ta = document.getElementById('wrongText'), send = document.getElementById('wrongSend'), cnt = document.getElementById('wrongCount');
      ta.focus();
      ta.addEventListener('input', function () {
        var len = ta.value.trim().length;
        cnt.textContent = ta.value.length + ' / ' + MAX_TEXT; cnt.classList.toggle('over', ta.value.length > MAX_TEXT);
        send.disabled = !len || len > MAX_TEXT;
      });
      document.getElementById('wrongCancel').addEventListener('click', function () { paintNote(n); });
      send.addEventListener('click', function () {
        send.disabled = true; send.textContent = 'Saving...';
        fetch('/api/corrections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: n.id, text: ta.value }) })
          .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j && j.error ? j.error : 'HTTP ' + r.status); return j; }); })
          .then(function () {
            box.innerHTML = '<h4>Is this note wrong?</h4><p class="saved">Saved. Claude will see it at the start of the next session.</p><button class="btn" type="button" id="wrongOpen">Add another</button>';
            wireWrong(n);
          }, function (e) {
            send.disabled = false; send.textContent = 'Save';
            document.getElementById('wrongFail').textContent = 'Not saved: ' + (e.message || e);
          });
      });
    });
  }

  // ---------- router ----------
  var currentRoute = {};
  function route() {
    closeHits();
    if (loadError) { view.innerHTML = '<p class="err">Could not load the memory sitemap: ' + esc(loadError) + '</p>'; return; }
    if (!D) return;
    var hash = location.hash || '#/';
    var parts = hash.replace(/^#\/?/, '').split('/').map(function (p) { try { return decodeURIComponent(p); } catch (e) { return p; } });
    var prev = currentRoute;
    if (parts[0] === 's' && parts[1]) { currentRoute = { kind: 's', slug: parts[1] }; renderSection(parts[1], parts[2]); if (!parts[2]) window.scrollTo(0, 0); }
    else if (parts[0] === 'n' && parts[1]) { currentRoute = { kind: 'n', stem: parts.slice(1).join('/') }; renderNote(currentRoute.stem); window.scrollTo(0, 0); }
    else { currentRoute = { kind: 'home' }; renderHome(); if (prev.kind !== 'home') window.scrollTo(0, 0); }
  }
  window.addEventListener('hashchange', route);
  load().then(route);
})();
