/* Brain: the memory brain as a 3D cortex ring that fires with live session activity.
   Data: brain-data.json?fresh=1 when served, window.BRAIN_DATA (brain-data.js) from disk. Same schema.
   Rendering: three.js r160 global build, one LineSegments for every fibre, custom shaders, small hand-made bloom. */
(function () {
  'use strict';
  const THREE = window.THREE, SH = window.BRAIN_SHADERS;
  const $ = (id) => document.getElementById(id);
  // ?embed=1: the page runs inside the OS dashboard (an iframe over its Calm window). It starts "mini" (only the ring and its
  // labels, on a transparent page); the dashboard switches it to the full UI and back by postMessage (see "embedded" below)
  const EMBED = new URLSearchParams(location.search).get('embed') === '1';
  let MINI = EMBED;
  if (EMBED) document.documentElement.classList.add('embed');
  if (MINI) document.documentElement.classList.add('mini');
  function fatal(msg) { const e = $('err'); e.style.display = 'grid'; e.textContent = msg; const l = $('loading'); if (l) l.style.display = 'none'; }
  if (!THREE) { fatal('three.min.js did not load (expected ../vendor/three.min.js)'); return; }
  if (!SH) { fatal('shaders.js did not load'); return; }
  THREE.ColorManagement.enabled = false;

  // ---------- constants & helpers ----------
  const TAU = Math.PI * 2, DAY = 864e5;
  const R = 100;                 // rim radius (world units)
  const RI = 0.30 * R, YI = -0.12 * R, YC = 0; // inner ring radius and height, core height
  const NP = 32;                 // points per fibre
  const NPER = 48;               // peripheral fibres: session activity that touches no note
  const GAP = 0.018;             // radians between lobes
  const EL0 = 0.62;              // default camera elevation
  const FOV = 24;
  const SERVED = /^https?:$/.test(location.protocol);
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const fmtN = (v) => Number(v).toLocaleString('en-US');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  // an instant (the scrubber, generatedAt) reads in local time like the card; week and day keys are UTC dates
  const fmtD = (ms) => { const d = new Date(ms); return d.getDate() + ' ' + MON[d.getMonth()] + ' ' + d.getFullYear(); };
  const fmtDU = (ms) => { const d = new Date(ms); return d.getUTCDate() + ' ' + MON[d.getUTCMonth()] + ' ' + d.getUTCFullYear(); };
  const fmtDs = (ms) => { const d = new Date(ms); return d.getUTCDate() + ' ' + MON[d.getUTCMonth()]; };
  const fmtLocal = (iso) => { if (!iso) return null; const d = new Date(iso); if (isNaN(d)) return null; return d.getDate() + ' ' + MON[d.getMonth()] + ' ' + d.getFullYear() + ', ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const wrapPi = (a) => { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; };
  function hexRgb(h) { h = String(h).replace('#', ''); if (h.length === 3) h = h.split('').map((c) => c + c).join(''); const v = parseInt(h, 16); return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]; }
  const rgba = (h, a) => { const c = hexRgb(h); return `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`; };
  function hash01(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967295; }
  const TYPE_NAME = { core: 'Memory index', feedback: 'Feedback', project: 'Project', reference: 'Reference', user: 'User', skill: 'Skill', domain: 'Skill domain', moc: 'Index map', note: 'Note' };
  const TYPE_ORDER = ['feedback', 'project', 'reference', 'user', 'note', 'skill', 'domain', 'moc', 'core'];
  const NOTE_TYPES = ['feedback', 'project', 'reference', 'user'];
  const SRC = { file: 'the file’s date on this computer, within the session that made it','session-start': 'approximate: start of the session that made it', 'earliest-date-in-note': 'approximate: earliest date written in the note', git: 'from the git commit that added it', 'git-bulk-upper-bound': 'only known to be before a bulk import', 'file-approx': 'approximate file date' };
  // pulse colours: 0 ambient, 1 read, 2 write, 3 error, 4 skill, 5 spawn, 6 peripheral
  const PCOL = ['#cbbcff', '#49c7ff', '#ffd49a', '#ff4d7d', '#a77bff', '#d24bff', '#8f80d8'];
  const ACT = { read: 1, search: 1, run: 1, write: 2, error: 3, skill: 4, spawn: 5 };
  const ACT_TXT = { read: '#49c7ff', search: '#49c7ff', run: '#7fd6ff', write: '#ffcf8a', error: '#ff4d7d', skill: '#b48cff', spawn: '#d24bff' };

  // ---------- renderer / scene / post ----------
  const canvas = $('gl');
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, premultipliedAlpha: true, powerPreference: 'high-performance' }); }
  catch (e) { fatal('WebGL is not available: ' + e.message); return; }
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.setClearColor(0x000000, 0);
  const GL2 = renderer.capabilities.isWebGL2;
  const HALF = GL2 && (renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float'));
  // software rasteriser (headless checks, no GPU): skip MSAA so a frame stays affordable, and leave idle time between frames
  let SOFT_GAP = 140;
  const SOFT = (() => { try { const gl = renderer.getContext(), x = gl.getExtension('WEBGL_debug_renderer_info'); return /swiftshader|llvmpipe|software/i.test(String(gl.getParameter(x ? x.UNMASKED_RENDERER_WEBGL : gl.RENDERER))); } catch (e) { return false; } })();
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 1, 8000);
  const tmpCam = new THREE.PerspectiveCamera(FOV, 1, 1, 8000);
  const postScene = new THREE.Scene(), postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2)); quad.frustumCulled = false; postScene.add(quad);
  const mkPost = (frag, uniforms) => new THREE.ShaderMaterial({ vertexShader: SH.quadVert, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false, blending: THREE.NoBlending });
  const matDown = mkPost(SH.downFrag, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uThr: { value: 0 } });
  const matBlur = mkPost(SH.blurFrag, { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } });
  const matComp = mkPost(SH.compFrag, { tMain: { value: null }, tB1: { value: null }, tB2: { value: null }, uB1: { value: 0.7 }, uB2: { value: 0.55 } });
  const RT = {};
  function mkRT(w, h, samples) {
    return new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), { type: HALF ? THREE.HalfFloatType : THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: false, samples: GL2 ? (samples || 0) : 0, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false });
  }
  function sizeRTs(w, h) {
    Object.values(RT).forEach((r) => r.dispose());
    RT.main = mkRT(w, h, SOFT ? 0 : 4); RT.half = mkRT(w >> 1, h >> 1);
    RT.q1 = mkRT(w >> 2, h >> 2); RT.q2 = mkRT(w >> 2, h >> 2);
    RT.e1 = mkRT(w >> 3, h >> 3); RT.e2 = mkRT(w >> 3, h >> 3);
  }
  function pass(mat, target) { quad.material = mat; renderer.setRenderTarget(target); renderer.render(postScene, postCam); }
  function down(src, dst, thr) { matDown.uniforms.tSrc.value = src.texture; matDown.uniforms.uTexel.value.set(1 / src.width, 1 / src.height); matDown.uniforms.uThr.value = thr; pass(matDown, dst); }
  function blur(a, b) {
    matBlur.uniforms.tSrc.value = a.texture; matBlur.uniforms.uDir.value.set(1 / a.width, 0); pass(matBlur, b);
    matBlur.uniforms.tSrc.value = b.texture; matBlur.uniforms.uDir.value.set(0, 1 / b.height); pass(matBlur, a);
  }
  function renderFrame() {
    renderer.setRenderTarget(RT.main); renderer.render(scene, camera);
    down(RT.main, RT.half, 0.035); down(RT.half, RT.q1, 0); blur(RT.q1, RT.q2);
    down(RT.q1, RT.e1, 0); blur(RT.e1, RT.e2);
    matComp.uniforms.tMain.value = RT.main.texture; matComp.uniforms.tB1.value = RT.q1.texture; matComp.uniforms.tB2.value = RT.e1.texture;
    pass(matComp, null);
  }

  // ---------- page state ----------
  let D = null, M = null;
  let W = 1, H = 1, DPR = 1, GPR = 1, UPX = 1000; // GPR = GL pixel ratio; UPX = GL px per world unit at depth 1
  const LITE = new URLSearchParams(location.search).get('lite') === '1';
  if (LITE) document.documentElement.classList.add('lite');
  // ?freeze=N (headless checks only): stop the frame loop N seconds in; __brain.run(s) resumes it for s seconds
  const FREEZE = parseFloat(new URLSearchParams(location.search).get('freeze')) || 0;
  let freezeAt = FREEZE || Infinity, frozen = false;
  const DBG = new URLSearchParams(location.search).get('debug') === '1';
  const dbg = (...a) => { if (DBG) console.log('[brain]', ...a); };
  const RSCALE = clamp(parseFloat(new URLSearchParams(location.search).get('scale')) || 1, 0.25, 2); // optional internal render scale (?scale=0.5)
  const FREE = { x0: 0, y0: 0, x1: 1, y1: 1 };
  // mini: the scene fades out over the window's outer FE px (brain.css masks #gl and #lead with --fe, drawLabels fades the
  // inner-ring and core names to match), so a zoomed ring or a lobe in front has no hard edge along the window. 0 = none.
  let FE = 0;
  // screen boxes of the page chrome that note titles must stay out of (bar and card set on resize, ticker on every re-render)
  const CHROME = { bar: null, card: null, ticker: null };
  const LHL = 38; // height of a lobe label (heading + anchor line; 38 so 17 stacked section labels never touch)
  const lobeLH = () => (MINI ? 24 : LHL); // mini shows the heading only (brain.css hides the anchor line)
  function cardWidth() { return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--cardW')) || 400; }
  function measureTicker() {
    if (MINI) { CHROME.ticker = null; return; } // mini: the ticker is not shown, so it covers nothing
    const r = $('ticker').getBoundingClientRect(); CHROME.ticker = { x0: r.left, y0: r.top, x1: r.right, y1: r.bottom };
  }
  const hitsBox = (b, x0, y0, x1, y1) => !!b && x0 < b.x1 && x1 > b.x0 && y0 < b.y1 && y1 > b.y0;
  const cam = { tx: 0, ty: 0, tz: 0, az: 0.0, el: EL0, dist: 400 };
  let goal = null, fitDistance = 400, lastInput = -1e9, elDefault = EL0;
  let hover = -1, hoverLobe = -1, pinned = -1, focus = -1, preview = -1;
  let matches = null, askRes = [], askSel = -1;
  let T = 0, tStart = 0, genMs = 0, playing = false;
  // embedded: paused while the dashboard does not show us (no frames); a note clicked in mini, pinned once the full view opens
  let paused = false, pendingPin = -1;
  let now = 0; const t0 = performance.now();
  let layoutMoving = false, targetsDirty = true;
  let mouse = { x: -1, y: -1, in: false, moved: false };

  // per-model GPU objects and arrays (rebuilt on data refresh)
  let G = null;

  // ---------- model ----------
  function buildModel(data, prev) {
    const P = data.palette || {}, TC = P.types || {};
    const nodes = data.nodes, links = data.links, comms = data.communities || [];
    const colorOf = (t) => TC[t] || TC.note || '#a78bfa';
    const byId = new Map(); nodes.forEach((n) => byId.set(n.id, n.i));
    const adj = nodes.map(() => []);
    links.forEach((l, k) => { adj[l[0]].push(k); adj[l[1]].push(k); });
    const domainOf = {};
    links.forEach((l) => {
      if (l[2] !== 1) return;
      const a = nodes[l[0]], b = nodes[l[1]];
      if (a.type === 'skill' && b.type === 'domain') domainOf[a.i] = b.i; else if (b.type === 'skill' && a.type === 'domain') domainOf[b.i] = a.i;
    });
    // sections (data.layout 'sections'): one lobe per sitemap section, in the tree's order, with its fixed name and colour;
    // beads grouped by home topic, the section's skills last as its playbooks. Otherwise the link clusters, as before.
    const SEC = data.layout === 'sections' && Array.isArray(data.sections) && data.sections.length > 0;
    if (SEC) return buildSectionModel(data, P, TC, colorOf, nodes, links, comms, byId, adj);
    const isInner = (n) => n.type === 'core' || n.type === 'moc' || n.type === 'domain';
    const skilly = new Set();
    comms.forEach((c) => { const t = c.types || {}; if (c.key !== 'structure' && ((t.skill || 0) + (t.domain || 0)) / Math.max(1, c.size) > 0.5) skilly.add(c.id); });
    const lobeByComm = {}; let lobes = [];
    comms.forEach((c) => {
      if (skilly.has(c.id)) return;
      const lb = { key: 'a:' + c.anchor, comm: c, label: c.label, anchorLabel: c.anchorLabel, members: [], absorbed: [] };
      lobeByComm[c.id] = lb; lobes.push(lb);
    });
    const skillsLobe = { key: 'skills', comm: null, label: 'Skills · by domain', anchorLabel: '', members: [], absorbed: [...skilly].map((id) => comms[id]), skills: true };
    lobes.push(skillsLobe);
    const fallback = { key: 'other', comm: null, label: 'Unassigned', anchorLabel: '', members: [], absorbed: [] };
    const inner = []; let core = null;
    nodes.forEach((n) => {
      if (n.type === 'core') { core = n; return; }
      if (isInner(n)) { inner.push(n); return; }
      if (n.type === 'skill' || skilly.has(n.community)) { skillsLobe.members.push(n); return; }
      (lobeByComm[n.community] || fallback).members.push(n);
    });
    if (fallback.members.length) lobes.push(fallback);
    lobes = lobes.filter((l) => l.members.length);
    lobes.forEach((lb) => {
      const g = {};
      lb.members.forEach((n) => { const key = lb.skills && n.type === 'skill' ? 'd:' + (domainOf[n.i] != null ? domainOf[n.i] : 'none') : 't:' + n.type; (g[key] = g[key] || []).push(n); });
      const keys = Object.keys(g).sort((a, b) => {
        const ad = a.startsWith('d:'), bd = b.startsWith('d:');
        if (ad && bd) return g[b].length - g[a].length || a.localeCompare(b);
        if (ad !== bd) return ad ? -1 : 1;
        return TYPE_ORDER.indexOf(a.slice(2)) - TYPE_ORDER.indexOf(b.slice(2));
      });
      lb.groups = keys.map((k) => ({ key: k, members: g[k].sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id)), domain: k.startsWith('d:') && k !== 'd:none' ? nodes[+k.slice(2)] : null }));
      lb.members = lb.groups.flatMap((gr) => gr.members);
      if (lb.skills) { const doms = lb.groups.filter((gr) => gr.domain).map((gr) => gr.domain); lb.anchorLabel = doms.length ? doms.slice().sort((a, b) => b.deg - a.deg)[0].label + ' (largest domain)' : ''; }
    });
    return finishModel(data, P, TC, colorOf, nodes, links, comms, byId, adj, lobes, inner, core, skillsLobe, prev, false);
  }
  function buildSectionModel(data, P, TC, colorOf, nodes, links, comms, byId, adj) {
    const inner = []; let core = null;
    const lobes = data.sections.map((s) => ({ key: 'sec:' + s.slug, sec: s, comm: comms[s.i] || null, label: s.name, color: s.color || '#a78bfa', anchorLabel: '', members: [], absorbed: [] }));
    const other = { key: 'other', sec: null, comm: null, label: 'Unassigned', color: '#8b7fb4', anchorLabel: '', members: [], absorbed: [] };
    nodes.forEach((n) => {
      if (n.type === 'core') { core = n; return; }
      if (n.type === 'moc') { inner.push(n); return; }
      (n.section >= 0 && lobes[n.section] ? lobes[n.section] : other).members.push(n);
    });
    if (other.members.length) lobes.push(other);
    const shown = lobes.filter((l) => l.members.length);
    shown.forEach((lb) => {
      const tOrder = {}; ((lb.sec && lb.sec.topics) || []).forEach((t, k) => { tOrder[t.slug] = k; });
      const tName = {}; ((lb.sec && lb.sec.topics) || []).forEach((t) => { tName[t.slug] = t.name; });
      const g = {};
      lb.members.forEach((n) => { const key = n.type === 'skill' ? 'p:' : 't:' + (n.home || ''); (g[key] = g[key] || []).push(n); });
      const rank = (k) => (k === 'p:' ? 1e6 : tOrder[k.slice(2)] != null ? tOrder[k.slice(2)] : 1e5);
      const keys = Object.keys(g).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
      lb.groups = keys.map((k) => ({ key: k, topic: k === 'p:' ? 'Playbooks' : tName[k.slice(2)] || k.slice(2), members: g[k].sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id)), domain: null }));
      lb.members = lb.groups.flatMap((gr) => gr.members);
      const nt = lb.groups.filter((gr) => gr.key !== 'p:').length, np = g['p:'] ? g['p:'].length : 0;
      lb.anchorLabel = nt + (nt === 1 ? ' topic' : ' topics') + (np ? ' · ' + np + (np === 1 ? ' playbook' : ' playbooks') : '');
    });
    return finishModel(data, P, TC, colorOf, nodes, links, comms, byId, adj, shown, inner, core, null, null, true);
  }
  function finishModel(data, P, TC, colorOf, nodes, links, comms, byId, adj, lobes, inner, core, skillsLobe, prev, SEC) {
    const NN = nodes.length;
    const nodeLobe = new Int16Array(NN).fill(-1), nodeGroup = new Int16Array(NN).fill(-1);
    const indexLobes = () => lobes.forEach((lb, li) => { lb.idx = li; lb.groups.forEach((gr, gi) => gr.members.forEach((n) => { nodeLobe[n.i] = li; nodeGroup[n.i] = gi; })); });
    indexLobes();
    const prevOrder = prev ? prev.lobes.map((l) => l.key) : null;
    if (SEC) { /* sections keep the tree's order */ }
    else if (prevOrder) {
      // stable on refresh: lobes we already show keep their order, new ones go after their strongest neighbour
      const known = lobes.filter((l) => prevOrder.includes(l.key)).sort((a, b) => prevOrder.indexOf(a.key) - prevOrder.indexOf(b.key));
      lobes.filter((l) => !prevOrder.includes(l.key)).forEach((l) => known.push(l));
      lobes = known;
    } else {
      // first load: greedy, so strongly linked lobes sit next to each other
      const L = lobes.length, A = Array.from({ length: L }, () => new Array(L).fill(0));
      links.forEach((l) => { const a = nodeLobe[l[0]], b = nodeLobe[l[1]]; if (a >= 0 && b >= 0 && a !== b) { A[a][b]++; A[b][a]++; } });
      const order = [0], used = new Set([0]);
      while (order.length < L) {
        const last = order[order.length - 1]; let best = -1, bv = -1;
        for (let j = 0; j < L; j++) if (!used.has(j)) { const v = A[last][j] * 1000 + lobes[j].members.length; if (v > bv) { bv = v; best = j; } }
        order.push(best); used.add(best);
      }
      lobes = order.map((i) => lobes[i]);
    }
    indexLobes();
    const NL = lobes.length, NLK = links.length;
    const cls = new Uint8Array(NLK);
    lobes.forEach((lb) => { lb.internal = 0; lb.flows = 0; lb.toInner = 0; });
    links.forEach((l, k) => {
      const a = nodeLobe[l[0]], b = nodeLobe[l[1]];
      cls[k] = a < 0 || b < 0 ? 2 : a === b ? 0 : 1;
      if (a >= 0 && b >= 0) { if (a === b) lobes[a].internal++; else { lobes[a].flows++; lobes[b].flows++; } } else if (a >= 0) lobes[a].toInner++; else if (b >= 0) lobes[b].toInner++;
    });
    // per lobe pair: up or down (dome or bowl) and a height jitter, so each flow sits at its own height
    const pairSgn = new Float32Array(NL * NL), pairJit = new Float32Array(NL * NL), lobeSgn = new Float32Array(NL);
    for (let i = 0; i < NL; i++) {
      lobeSgn[i] = hash01(lobes[i].key + '/s') < 0.5 ? 1 : -1;
      for (let j = 0; j < NL; j++) { const key = [lobes[i].key, lobes[j].key].sort().join('|'); pairSgn[i * NL + j] = hash01(key) < 0.6 ? 1 : -1; pairJit[i * NL + j] = 0.9 + 0.2 * hash01(key + '#'); }
    }
    // sections: every note link between two sections runs along ONE shared arc for that pair; each link is one strand of
    // it, set side by side across the arc's width, and the width grows with the number of links (sqrt), so a pair's arc
    // is as thick as its link count. A pulse still runs along its own link's strand.
    const pairOff = new Float32Array(NLK), pairN = new Map();
    if (SEC) {
      const byPair = new Map(), pos = new Map(); lobes.forEach((lb) => lb.members.forEach((n, s) => pos.set(n.i, s)));
      links.forEach((l, k) => { const a = nodeLobe[l[0]], b = nodeLobe[l[1]]; if (a < 0 || b < 0 || a === b) return; const key = Math.min(a, b) * NL + Math.max(a, b); if (!byPair.has(key)) byPair.set(key, []); byPair.get(key).push(k); });
      byPair.forEach((ks, key) => {
        const lo = Math.floor(key / NL), end = (k) => (nodeLobe[links[k][0]] === lo ? links[k][0] : links[k][1]);
        ks.sort((x, y) => pos.get(end(x)) - pos.get(end(y)) || x - y);
        const w = Math.min(10, 1.15 * Math.sqrt(ks.length)), n = ks.length;
        ks.forEach((k, r) => { pairOff[k] = n > 1 ? (r / (n - 1) - 0.5) * w : 0; });
        pairN.set(key, n);
      });
    }
    const ms = new Float64Array(NN);
    nodes.forEach((n) => { ms[n.i] = n.created ? Date.parse(n.created) : NaN; });
    const topicLabel = {}; (data.topics || []).forEach((t) => { topicLabel[t.id] = t.label; });
    const TXT = nodes.map((n) => {
      const c = (SEC ? comms[n.section] : comms[n.community]) || {};
      return { label: String(n.label).toLowerCase(), id: String(n.id).toLowerCase().replace(/[_:\-]+/g, ' '), desc: String(n.desc || '').toLowerCase(), topic: String(topicLabel[n.topic] || n.topic || '').toLowerCase(), comm: ((c.label || '') + ' ' + (c.keywords || []).join(' ')).toLowerCase() };
    });
    const leaves = lobes.flatMap((lb) => lb.members);
    return { data, P, TC, colorOf, nodes, links, comms, byId, adj, lobes, inner, core, leaves, nodeLobe, nodeGroup, cls, NN, NL, NLK, NF: NLK + NPER, pairSgn, pairJit, lobeSgn, ms, topicLabel, TXT, skillsLobe, SEC, pairOff, pairN,
      tAng: new Float64Array(NN), ang: new Float64Array(NN), natMid: [] };
  }

  // ---------- layout ----------
  function spansFor(f) {
    const N = M.leaves.length, avail = TAU - GAP * M.NL;
    const spans = M.lobes.map((lb) => avail * lb.members.length / N);
    if (f >= 0) {
      const nf = M.lobes[f].members.length;
      const fs = Math.min(avail * 0.62, 2.5, Math.max(spans[f], nf * 0.024));
      const restN = N - nf, rest = avail - fs;
      M.lobes.forEach((lb, i) => { spans[i] = i === f ? fs : rest * lb.members.length / Math.max(1, restN); });
    }
    return spans;
  }
  function targetLayout(f) {
    const nat = spansFor(-1), rot0 = -Math.PI / 2 - nat[0] / 2;
    let a = rot0; M.natMid = nat.map((sp) => { const m = a + sp / 2; a += sp + GAP; return m; });
    let spans = nat, rot = rot0;
    if (f >= 0) { spans = spansFor(f); let c = 0; for (let i = 0; i < f; i++) c += spans[i] + GAP; rot = M.natMid[f] - (c + spans[f] / 2); }
    a = rot;
    // sections: a gap of GG beads between topic groups, so the topics read as groups along the lobe
    const GG = M.SEC ? 1.6 : 0;
    M.lobes.forEach((lb, i) => {
      const sp = spans[i], slots = lb.members.length + (lb.groups.length - 1) * GG;
      let s = 0; lb.groups.forEach((gr, gi) => { gr.members.forEach((m) => { M.tAng[m.i] = a + (s + 0.5) / slots * sp; s++; }); if (gi < lb.groups.length - 1) s += GG; });
      a += sp + GAP;
    });
    if (M.SEC) {
      // the section maps sit on the inner ring under their own section; _SITEMAP at the seam between the last and first lobe
      const byKey = {}; M.lobes.forEach((lb, i) => { byKey[lb.key] = i; });
      const secs = M.data.sections || [];
      M.inner.forEach((n) => { const sec = secs[n.section], li = sec ? byKey['sec:' + sec.slug] : null; M.tAng[n.i] = li != null ? M.natMid[li] : rot0 - GAP / 2; });
      if (M.core) M.tAng[M.core.i] = 0;
      return;
    }
    // inner ring: skill domains next to the skills lobe, index maps over the rest (from the natural layout, so it never moves)
    const si = M.lobes.indexOf(M.skillsLobe);
    const doms = si >= 0 ? M.skillsLobe.groups.filter((g) => g.domain).map((g) => g.domain) : [];
    const domOrder = doms.concat(M.inner.filter((n) => n.type === 'domain' && !doms.includes(n)));
    const mocs = M.inner.filter((n) => n.type !== 'domain').sort((x, y) => y.deg - x.deg || x.id.localeCompare(y.id));
    const step = TAU / Math.max(1, domOrder.length + mocs.length);
    const base = si >= 0 ? M.natMid[si] - (domOrder.length - 1) * step / 2 : -Math.PI / 2;
    domOrder.forEach((n, k) => { M.tAng[n.i] = base + k * step; });
    mocs.forEach((n, k) => { M.tAng[n.i] = base + (domOrder.length + k) * step; });
    if (M.core) M.tAng[M.core.i] = 0;
  }
  function setFocus(f, opts) {
    opts = opts || {};
    focus = f;
    targetLayout(f);
    layoutMoving = true;
    if (f >= 0) goal = focusGoal(f, opts.withCard || pinned >= 0);
    else if (!opts.keepCamera) goal = overviewGoal();
    targetsDirty = true; lastInput = now;
  }

  // ---------- geometry (from displayed angles) ----------
  const ctrl = new Float64Array(3 * 8), spt = new Float64Array(3 * 8), dense = new Float64Array(3 * 64), cum = new Float64Array(64);
  let lobeMid, lobeA0, lobeA1, groupMid;
  function nodeXYZ(i, out, o) {
    const n = M.nodes[i], a = M.ang[i];
    if (n.type === 'core') { out[o] = 0; out[o + 1] = YC; out[o + 2] = 0; }
    else if (M.nodeLobe[i] < 0) { out[o] = RI * Math.cos(a); out[o + 1] = YI; out[o + 2] = RI * Math.sin(a); }
    else { out[o] = R * Math.cos(a); out[o + 1] = 0; out[o + 2] = R * Math.sin(a); }
  }
  function lobeAngles() {
    M.lobes.forEach((lb, i) => {
      const n = lb.members.length, a = M.ang[lb.members[0].i], b = M.ang[lb.members[n - 1].i];
      const half = n > 1 ? (b - a) / (n - 1) / 2 : 0.006;
      lobeMid[i] = (a + b) / 2; lobeA0[i] = a - half; lobeA1[i] = b + half;
      lb.groups.forEach((gr, gi) => { groupMid[i][gi] = (M.ang[gr.members[0].i] + M.ang[gr.members[gr.members.length - 1].i]) / 2; });
    });
  }
  function bundle(m, k, beta) {
    // straighten toward the chord (beta), d3 curveBasis through the control points, then resample by arc length to NP points
    const BETA = beta || 0.85, x0 = ctrl[0], y0 = ctrl[1], z0 = ctrl[2], e = (m - 1) * 3, dx = ctrl[e] - x0, dy = ctrl[e + 1] - y0, dz = ctrl[e + 2] - z0;
    for (let i = 0; i < m; i++) { const t = m > 1 ? i / (m - 1) : 0; spt[i * 3] = BETA * ctrl[i * 3] + (1 - BETA) * (x0 + t * dx); spt[i * 3 + 1] = BETA * ctrl[i * 3 + 1] + (1 - BETA) * (y0 + t * dy); spt[i * 3 + 2] = BETA * ctrl[i * 3 + 2] + (1 - BETA) * (z0 + t * dz); }
    let c = 0; const out = (x, y, z) => { dense[c * 3] = x; dense[c * 3 + 1] = y; dense[c * 3 + 2] = z; c++; };
    out(spt[0], spt[1], spt[2]);
    if (m === 2) out(spt[3], spt[4], spt[5]);
    else {
      const SEG = 6;
      let ax = spt[0], ay = spt[1], az = spt[2], bx = spt[3], by = spt[4], bz = spt[5];
      let qx = (5 * ax + bx) / 6, qy = (5 * ay + by) / 6, qz = (5 * az + bz) / 6;
      out(qx, qy, qz);
      for (let i = 2; i <= m; i++) {
        const x = i < m ? spt[i * 3] : bx, y = i < m ? spt[i * 3 + 1] : by, z = i < m ? spt[i * 3 + 2] : bz;
        const ex = (ax + 4 * bx + x) / 6, ey = (ay + 4 * by + y) / 6, ez = (az + 4 * bz + z) / 6;
        const c1x = (2 * ax + bx) / 3, c1y = (2 * ay + by) / 3, c1z = (2 * az + bz) / 3, c2x = (ax + 2 * bx) / 3, c2y = (ay + 2 * by) / 3, c2z = (az + 2 * bz) / 3;
        for (let s = 1; s <= SEG; s++) { const t = s / SEG, u = 1 - t, w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t; out(w0 * qx + w1 * c1x + w2 * c2x + w3 * ex, w0 * qy + w1 * c1y + w2 * c2y + w3 * ey, w0 * qz + w1 * c1z + w2 * c2z + w3 * ez); }
        qx = ex; qy = ey; qz = ez; ax = bx; ay = by; az = bz; bx = x; by = y; bz = z;
      }
      out(spt[e], spt[e + 1], spt[e + 2]);
    }
    cum[0] = 0;
    for (let i = 1; i < c; i++) { const ddx = dense[i * 3] - dense[i * 3 - 3], ddy = dense[i * 3 + 1] - dense[i * 3 - 2], ddz = dense[i * 3 + 2] - dense[i * 3 - 1]; cum[i] = cum[i - 1] + Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz); }
    const total = cum[c - 1] || 1e-6, P = G.fpos, base = k * NP * 3;
    let s = 0;
    for (let j = 0; j < NP; j++) {
      const target = total * j / (NP - 1);
      while (s < c - 2 && cum[s + 1] < target) s++;
      const seg = cum[s + 1] - cum[s], t = seg > 0 ? clamp((target - cum[s]) / seg, 0, 1) : 0, o = base + j * 3;
      P[o] = dense[s * 3] + (dense[s * 3 + 3] - dense[s * 3]) * t; P[o + 1] = dense[s * 3 + 1] + (dense[s * 3 + 4] - dense[s * 3 + 1]) * t; P[o + 2] = dense[s * 3 + 2] + (dense[s * 3 + 5] - dense[s * 3 + 2]) * t;
    }
    G.flen[k] = total;
  }
  function computeGeometry() {
    lobeAngles();
    const NP3 = G.npos;
    for (let i = 0; i < M.NN; i++) nodeXYZ(i, NP3, i * 3);
    const NL = M.NL;
    let m = 0;
    const push = (x, y, z) => { ctrl[m * 3] = x; ctrl[m * 3 + 1] = y; ctrl[m * 3 + 2] = z; m++; };
    const pushPolar = (t, r, y) => push(r * Math.cos(t), y, r * Math.sin(t));
    for (let k = 0; k < M.NLK; k++) {
      const l = M.links[k], a = l[0], b = l[1], la = M.nodeLobe[a], lb = M.nodeLobe[b];
      m = 0; let beta = 0.85;
      push(NP3[a * 3], NP3[a * 3 + 1], NP3[a * 3 + 2]);
      if (la >= 0 && lb >= 0) {
        const ga = M.nodeGroup[a], gb = M.nodeGroup[b];
        if (la === lb) {
          const s = M.lobeSgn[la];
          if (ga === gb) { const d = Math.abs(M.ang[a] - M.ang[b]), f = Math.min(1, d / 0.45); pushPolar((M.ang[a] + M.ang[b]) / 2, R * (1 - 0.22 * f), s * 0.05 * R * f); }
          else { const d = Math.abs(groupMid[la][ga] - groupMid[lb][gb]), f = Math.min(1, d / 0.6), y = s * 0.07 * R * (0.4 + f); pushPolar(groupMid[la][ga], R * 0.82, y); pushPolar(groupMid[lb][gb], R * 0.82, y); }
        } else {
          const pk = la * NL + lb, s = M.pairSgn[pk];
          const ma = lobeMid[la], mb = lobeMid[lb];
          let dd = Math.abs(ma - mb) % TAU; if (dd > Math.PI) dd = TAU - dd;
          const h = R * (0.12 + 0.46 * Math.sin(dd / 2)) * M.pairJit[pk];
          if (M.SEC) {
            // one arc per section pair: every strand leaves through its section's gate and follows the pair's shared path,
            // offset across the arc's width (pairOff; across the chord in the ring's plane, a little in height)
            const o = M.pairOff[k] * (la < lb ? 1 : -1);
            let px = -(Math.sin(mb) - Math.sin(ma)), pz = Math.cos(mb) - Math.cos(ma); const pl = Math.hypot(px, pz) || 1; px /= pl; pz /= pl;
            const oy = s * M.pairOff[k] * 0.35; // height offset: the same side for both directions of travel
            const off = (t, r, y, f) => push(r * Math.cos(t) + px * o * f, y + oy * f, r * Math.sin(t) + pz * o * f);
            off(ma, R * 0.86, s * 0.012 * R, 0.25);
            off(ma, R * 0.64, s * 0.13 * R, 0.8);
            push(R * 0.27 * (Math.cos(ma) + Math.cos(mb)) + px * o, s * h + oy, R * 0.27 * (Math.sin(ma) + Math.sin(mb)) + pz * o);
            off(mb, R * 0.64, s * 0.13 * R, 0.8);
            off(mb, R * 0.86, s * 0.012 * R, 0.25);
            push(NP3[b * 3], NP3[b * 3 + 1], NP3[b * 3 + 2]);
            bundle(m, k, 0.97);
            continue;
          }
          // every flow leaving a lobe on the same side (dome or bowl) shares one exit point, so the lobe's links leave
          // as one river and only fan out to their own arch further in
          pushPolar(groupMid[la][ga], R * 0.86, s * 0.01 * R);
          pushPolar(ma, R * 0.64, s * 0.13 * R);
          push(R * 0.27 * (Math.cos(ma) + Math.cos(mb)), s * h, R * 0.27 * (Math.sin(ma) + Math.sin(mb)));
          pushPolar(mb, R * 0.64, s * 0.13 * R);
          pushPolar(groupMid[lb][gb], R * 0.86, s * 0.01 * R);
          beta = 0.95; // flows bundle tighter, so rivers form with dark gaps between them
        }
      } else if (la >= 0 || lb >= 0) {
        const leaf = la >= 0 ? a : b, L = la >= 0 ? la : lb, Gi = M.nodeGroup[leaf], gr = M.lobes[L].groups[Gi];
        const other = leaf === a ? b : a;
        const isDom = gr && gr.domain && gr.domain.i === other;
        const pts = [];
        if (!isDom) pts.push([lobeMid[L], R * 0.6, YI * 0.55]);
        pts.push([groupMid[L][Gi], R * 0.84, YI * 0.08]);
        if (la >= 0) pts.reverse();
        pts.forEach((p) => pushPolar(p[0], p[1], p[2]));
      } else {
        const coreLink = M.nodes[a].type === 'core' || M.nodes[b].type === 'core';
        if (!coreLink) push((NP3[a * 3] + NP3[b * 3]) * 0.18, YI - 0.07 * R, (NP3[a * 3 + 2] + NP3[b * 3 + 2]) * 0.18);
      }
      push(NP3[b * 3], NP3[b * 3 + 1], NP3[b * 3 + 2]);
      bundle(m, k, beta);
    }
    G.fgeo.attributes.position.needsUpdate = true;
    G.ngeo.attributes.position.needsUpdate = true;
    buildBands();
  }
  function computePeripheral() {
    let m = 0;
    const push = (x, y, z) => { ctrl[m * 3] = x; ctrl[m * 3 + 1] = y; ctrl[m * 3 + 2] = z; m++; };
    for (let p = 0; p < NPER; p++) {
      const t = -Math.PI / 2 + p / NPER * TAU, s = p % 2 ? 1 : -1; m = 0;
      push((R + 22) * Math.cos(t), 0, (R + 22) * Math.sin(t));
      push(R * 0.86 * Math.cos(t + 0.22), s * 0.10 * R, R * 0.86 * Math.sin(t + 0.22));
      push(R * 0.5 * Math.cos(t + 0.55), s * 0.16 * R, R * 0.5 * Math.sin(t + 0.55));
      push(R * 0.16 * Math.cos(t + 0.9), s * 0.07 * R, R * 0.16 * Math.sin(t + 0.9));
      push(0, YC, 0);
      bundle(m, M.NLK + p);
    }
  }

  // ---------- rim band ----------
  const BSEG = 72;
  function buildBands() {
    const pos = G.bpos;
    let v = 0;
    const put = (x, y, z) => { pos[v * 3] = x; pos[v * 3 + 1] = y; pos[v * 3 + 2] = z; v++; };
    for (let i = 0; i < M.NL; i++) {
      const a0 = lobeA0[i], a1 = lobeA1[i];
      for (let s = 0; s <= BSEG; s++) { const t = a0 + (a1 - a0) * s / BSEG, c = Math.cos(t), sn = Math.sin(t); put((R + 5.5) * c, 0, (R + 5.5) * sn); put((R + 10.5) * c, 0, (R + 10.5) * sn); }
      for (let s = 0; s <= BSEG; s++) { const t = a0 + (a1 - a0) * s / BSEG, c = Math.cos(t), sn = Math.sin(t); put((R + 8) * c, -2.4, (R + 8) * sn); put((R + 8) * c, 2.4, (R + 8) * sn); }
    }
    G.bgeo.attributes.position.needsUpdate = true;
  }

  // ---------- GPU objects ----------
  function disposeG() {
    if (!G) return;
    G.objects.forEach((o) => { scene.remove(o); if (o.geometry) o.geometry.dispose(); });
    G.textures.forEach((t) => t.dispose());
  }
  function buildGPU() {
    disposeG();
    const NF = M.NF, NN = M.NN, NL = M.NL;
    G = { objects: [], textures: [] };
    lobeMid = new Float64Array(NL); lobeA0 = new Float64Array(NL); lobeA1 = new Float64Array(NL);
    groupMid = M.lobes.map((lb) => new Float64Array(lb.groups.length));
    // fibres
    const fpos = new Float32Array(NF * NP * 3), fu = new Float32Array(NF * NP), ffi = new Float32Array(NF * NP), fcol = new Float32Array(NF * NP * 3);
    const fidx = new Uint32Array(NF * (NP - 1) * 2);
    const peri = hexRgb('#8f80d8');
    for (let k = 0; k < NF; k++) {
      const ca = k < M.NLK ? hexRgb(M.colorOf(M.nodes[M.links[k][0]].type)) : peri, cb = k < M.NLK ? hexRgb(M.colorOf(M.nodes[M.links[k][1]].type)) : peri;
      for (let j = 0; j < NP; j++) {
        const v = k * NP + j, u = j / (NP - 1), t = clamp((u - 0.36) / 0.28, 0, 1), s = t * t * (3 - 2 * t);
        fu[v] = u; ffi[v] = k;
        fcol[v * 3] = ca[0] + (cb[0] - ca[0]) * s; fcol[v * 3 + 1] = ca[1] + (cb[1] - ca[1]) * s; fcol[v * 3 + 2] = ca[2] + (cb[2] - ca[2]) * s;
        if (j < NP - 1) { const o = (k * (NP - 1) + j) * 2; fidx[o] = v; fidx[o + 1] = v + 1; }
      }
    }
    const fgeo = new THREE.BufferGeometry();
    const pa = new THREE.BufferAttribute(fpos, 3); pa.setUsage(THREE.DynamicDrawUsage);
    fgeo.setAttribute('position', pa); fgeo.setAttribute('aU', new THREE.BufferAttribute(fu, 1)); fgeo.setAttribute('aFib', new THREE.BufferAttribute(ffi, 1)); fgeo.setAttribute('aCol', new THREE.BufferAttribute(fcol, 3));
    fgeo.setIndex(new THREE.BufferAttribute(fidx, 1));
    const TW = 1024, TH = Math.ceil(NF / TW);
    const stateArr = new Float32Array(TW * TH * 4), pulseArr = new Float32Array(TW * TH * 4);
    const mkTex = (arr) => { const t = new THREE.DataTexture(arr, TW, TH, THREE.RGBAFormat, THREE.FloatType); t.minFilter = THREE.NearestFilter; t.magFilter = THREE.NearestFilter; t.generateMipmaps = false; t.needsUpdate = true; G.textures.push(t); return t; };
    const tState = mkTex(stateArr), tPulse = mkTex(pulseArr);
    const fmat = new THREE.ShaderMaterial({ vertexShader: SH.fibreVert, fragmentShader: SH.fibreFrag, transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { tState: { value: tState }, tPulse: { value: tPulse }, uTex: { value: new THREE.Vector2(TW, TH) }, uTime: { value: 0 }, uNear: { value: 0 }, uFar: { value: 1 }, uPC: { value: PCOL.map((c) => new THREE.Color(c)) } } });
    const fmesh = new THREE.LineSegments(fgeo, fmat); fmesh.frustumCulled = false;
    Object.assign(G, { fpos, fgeo, fmat, fmesh, flen: new Float32Array(NF), stateArr, pulseArr, tState, tPulse, fAlpha: new Float32Array(NF), fAT: new Float32Array(NF), fHl: new Float32Array(NF), fHT: new Float32Array(NF), fp: new Uint8Array(NF) });
    // nodes
    const npos = new Float32Array(NN * 3), ncol = new Float32Array(NN * 3), nsize = new Float32Array(NN), nA = new Float32Array(NN), nFlash = new Float32Array(NN * 2), nFC = new Float32Array(NN * 3), nBr = new Float32Array(NN);
    M.nodes.forEach((n) => {
      const c = hexRgb(M.colorOf(n.type)); ncol.set(c, n.i * 3); nFC.set([1, 1, 1], n.i * 3); nFlash[n.i * 2] = -100;
      nsize[n.i] = n.type === 'core' ? 13 : n.type === 'moc' ? 4.2 + Math.min(3.6, Math.sqrt(n.deg) * 0.2) : n.type === 'domain' ? 3.4 + Math.min(2.4, Math.sqrt(n.deg) * 0.35) : 1.7 + Math.min(3.2, Math.sqrt(n.deg) * 0.48);
      nBr[n.i] = n.type === 'core' ? 1 : n.type === 'moc' ? 0.25 : 0;
    });
    const ngeo = new THREE.BufferGeometry();
    const dyn = (arr, k) => { const a = new THREE.BufferAttribute(arr, k); a.setUsage(THREE.DynamicDrawUsage); return a; };
    ngeo.setAttribute('position', dyn(npos, 3)); ngeo.setAttribute('aCol', new THREE.BufferAttribute(ncol, 3)); ngeo.setAttribute('aSize', dyn(nsize, 1)); ngeo.setAttribute('aAlpha', dyn(nA, 1));
    ngeo.setAttribute('aFlash', dyn(nFlash, 2)); ngeo.setAttribute('aFlashCol', dyn(nFC, 3)); ngeo.setAttribute('aBreath', new THREE.BufferAttribute(nBr, 1));
    const nmat = new THREE.ShaderMaterial({ vertexShader: SH.nodeVert, fragmentShader: SH.nodeFrag, transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { uPx: { value: 1000 }, uTime: { value: 0 }, uNear: { value: 0 }, uFar: { value: 1 } } });
    const nmesh = new THREE.Points(ngeo, nmat); nmesh.frustumCulled = false;
    Object.assign(G, { npos, ngeo, nmat, nmesh, nsize, nA, nAT: new Float32Array(NN), nFlash, nFC, present: new Uint8Array(NN), scr: new Float32Array(NN * 3) });
    // sparks
    const SPN = 700, spos = new Float32Array(SPN * 3), scol = new Float32Array(SPN * 3), sA = new Float32Array(SPN), sS = new Float32Array(SPN);
    const sgeo = new THREE.BufferGeometry(); sgeo.setAttribute('position', dyn(spos, 3)); sgeo.setAttribute('aCol', dyn(scol, 3)); sgeo.setAttribute('aA', dyn(sA, 1)); sgeo.setAttribute('aSize', dyn(sS, 1));
    const smat = new THREE.ShaderMaterial({ vertexShader: SH.sparkVert, fragmentShader: SH.sparkFrag, transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { uPx: { value: 1000 }, uNear: { value: 0 }, uFar: { value: 1 } } });
    const smesh = new THREE.Points(sgeo, smat); smesh.frustumCulled = false;
    Object.assign(G, { SPN, spos, scol, sA, sS, sgeo, smat, smesh, sparks: [] });
    // ripples
    const RPN = 64, rpos = new Float32Array(RPN * 3), rst = new Float32Array(RPN).fill(-100), rcol = new Float32Array(RPN * 3), rstr = new Float32Array(RPN);
    const rgeo = new THREE.BufferGeometry(); rgeo.setAttribute('position', dyn(rpos, 3)); rgeo.setAttribute('aStart', dyn(rst, 1)); rgeo.setAttribute('aCol', dyn(rcol, 3)); rgeo.setAttribute('aStr', dyn(rstr, 1));
    const rmat = new THREE.ShaderMaterial({ vertexShader: SH.rippleVert, fragmentShader: SH.rippleFrag, transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { uPx: { value: 1000 }, uTime: { value: 0 } } });
    const rmesh = new THREE.Points(rgeo, rmat); rmesh.frustumCulled = false;
    Object.assign(G, { RPN, rpos, rst, rcol, rstr, rgeo, rmat, rmesh, rNext: 0 });
    // marks (rings around pinned / hovered / matched notes)
    const MKN = 64, mpos = new Float32Array(MKN * 3), mcol = new Float32Array(MKN * 3), msz = new Float32Array(MKN);
    const mgeo = new THREE.BufferGeometry(); mgeo.setAttribute('position', dyn(mpos, 3)); mgeo.setAttribute('aCol', dyn(mcol, 3)); mgeo.setAttribute('aSize', dyn(msz, 1));
    const mmat = new THREE.ShaderMaterial({ vertexShader: SH.markVert, fragmentShader: SH.markFrag, transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { uPx: { value: 1000 }, uTime: { value: 0 } } });
    const mmesh = new THREE.Points(mgeo, mmat); mmesh.frustumCulled = false;
    Object.assign(G, { MKN, mpos, mcol, msz, mgeo, mmat, mmesh, marks: [] });
    // rim band: per lobe a flat ribbon + an upright ribbon; plus one faint glass ring under the beads
    const perLobe = (BSEG + 1) * 4, GS = 240, bN = NL * perLobe + (GS + 1) * 2;
    const bpos = new Float32Array(bN * 3), bv = new Float32Array(bN), bl = new Float32Array(bN), bc = new Float32Array(bN * 3), bidx = [];
    let v = 0;
    const baseC = [0.655, 0.545, 0.98]; // the band's own violet; a section lobe glows in its section's colour
    for (let i = 0; i < NL; i++) {
      const lc = M.lobes[i].color ? hexRgb(M.lobes[i].color) : baseC;
      for (let strip = 0; strip < 2; strip++) {
        const s0 = v;
        for (let s = 0; s <= BSEG; s++) { bc.set(lc, v * 3); bv[v] = -1; bl[v] = i; v++; bc.set(lc, v * 3); bv[v] = 1; bl[v] = i; v++; }
        for (let s = 0; s < BSEG; s++) { const a = s0 + s * 2; bidx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
      }
    }
    const g0 = v;
    for (let s = 0; s <= GS; s++) { const t = s / GS * TAU; bpos.set([(R - 4) * Math.cos(t), -0.3, (R - 4) * Math.sin(t)], v * 3); bc.set(baseC, v * 3); bv[v] = -1; bl[v] = -1; v++; bpos.set([(R + 4) * Math.cos(t), -0.3, (R + 4) * Math.sin(t)], v * 3); bc.set(baseC, v * 3); bv[v] = 1; bl[v] = -1; v++; }
    for (let s = 0; s < GS; s++) { const a = g0 + s * 2; bidx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    const bgeo = new THREE.BufferGeometry(); bgeo.setAttribute('position', dyn(bpos, 3)); bgeo.setAttribute('aV', new THREE.BufferAttribute(bv, 1)); bgeo.setAttribute('aLobe', new THREE.BufferAttribute(bl, 1)); bgeo.setAttribute('aCol', new THREE.BufferAttribute(bc, 3)); bgeo.setIndex(bidx);
    const bmat = new THREE.ShaderMaterial({ vertexShader: SH.bandVert, fragmentShader: SH.bandFrag, transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, uniforms: { uHi: { value: new Array(48).fill(0) }, uNear: { value: 0 }, uFar: { value: 1 } } });
    const bmesh = new THREE.Mesh(bgeo, bmat); bmesh.frustumCulled = false;
    Object.assign(G, { bpos, bgeo, bmat, bmesh, bHi: new Float32Array(48) });
    // faint guide circles inside the ring
    const gl = [], gc = [];
    [[0.30, YI], [0.55, 0], [0.80, 0]].forEach(([f, y]) => { for (let s = 0; s < 160; s++) { const a = s / 160 * TAU, b = (s + 1) / 160 * TAU; gl.push(R * f * Math.cos(a), y, R * f * Math.sin(a), R * f * Math.cos(b), y, R * f * Math.sin(b)); for (let q = 0; q < 2; q++) gc.push(0.07, 0.055, 0.12); } });
    const ggeo = new THREE.BufferGeometry(); ggeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(gl), 3)); ggeo.setAttribute('aCol', new THREE.BufferAttribute(new Float32Array(gc), 3));
    const gmat = new THREE.ShaderMaterial({ vertexShader: SH.lineVert, fragmentShader: SH.lineFrag, transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { uNear: { value: 0 }, uFar: { value: 1 } } });
    const gmesh = new THREE.LineSegments(ggeo, gmat); gmesh.frustumCulled = false;
    G.gmat = gmat;
    G.objects.push(gmesh, bmesh, fmesh, nmesh, rmesh, smesh, mmesh);
    G.objects.forEach((o) => scene.add(o));
  }
  // dust: far points around the scene for parallax (built once)
  (function stars() {
    const N = 1600, p = new Float32Array(N * 3), a = new Float32Array(N), s = new Float32Array(N);
    let seed = 11; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < N; i++) {
      const u = rnd() * 2 - 1, th = rnd() * TAU, r = 380 + rnd() * 900, q = Math.sqrt(1 - u * u);
      p[i * 3] = r * q * Math.cos(th); p[i * 3 + 1] = r * u * 0.7; p[i * 3 + 2] = r * q * Math.sin(th);
      a[i] = 0.12 + rnd() * 0.42; s[i] = rnd() < 0.9 ? 1.6 : 2.6;
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(p, 3)); g.setAttribute('aA', new THREE.BufferAttribute(a, 1)); g.setAttribute('aS', new THREE.BufferAttribute(s, 1));
    const m = new THREE.ShaderMaterial({ vertexShader: SH.starVert, fragmentShader: SH.starFrag, transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending });
    const pts = new THREE.Points(g, m); pts.frustumCulled = false; scene.add(pts);
  })();

  // ---------- presence (the brain as of T) ----------
  function isPresentAt(i, t) { const v = M.ms[i]; return !(v === v) || v <= t; } // undated nodes (skills, domains, maps, index) are always present
  let presentCount = 0, presentLinks = 0;
  function recomputePresence(born) {
    const p = G.present; let births = 0;
    presentCount = 0;
    for (let i = 0; i < M.NN; i++) {
      const v = isPresentAt(i, T) ? 1 : 0;
      if (v && !p[i] && born && births < 14) { births++; flash(i, 2, 1.3); ripple(i, 2, 0.9); }
      p[i] = v; presentCount += v;
    }
    presentLinks = 0;
    const st = G.stateArr;
    for (let k = 0; k < M.NF; k++) {
      const v = k < M.NLK ? (p[M.links[k][0]] && p[M.links[k][1]] ? 1 : 0) : 1;
      if (v && !G.fp[k] && born) st[k * 4 + 2] = now; else if (!v) st[k * 4 + 2] = 0;
      G.fp[k] = v; st[k * 4 + 3] = v;
      if (k < M.NLK) presentLinks += v;
    }
    G.stateDirty = true; targetsDirty = true;
    updateCounts(); updateLobeCounts();
  }

  // ---------- alpha targets ----------
  const BASE = [0.06, 0.2, 0.032], DIM = [0.012, 0.02, 0.008], TIER1 = [0.22, 0.42, 0.15];
  function computeTargets() {
    targetsDirty = false;
    const hl = hover >= 0 ? hover : pinned >= 0 ? pinned : preview;
    const fl = hoverLobe >= 0 ? hoverLobe : focus;
    const nb = new Set(); if (hl >= 0) { nb.add(hl); M.adj[hl].forEach((k) => { const l = M.links[k]; nb.add(l[0] === hl ? l[1] : l[0]); }); }
    for (let k = 0; k < M.NLK; k++) {
      const a = M.links[k][0], b = M.links[k][1], c = M.cls[k];
      let t, h = 0;
      if (!G.fp[k]) t = 0;
      else if (hl >= 0) { if (a === hl || b === hl) { t = 0.95; h = 1; } else t = DIM[c]; }
      else if (matches) t = matches.has(a) || matches.has(b) ? TIER1[c] : DIM[c];
      else if (fl >= 0) t = M.nodeLobe[a] === fl || M.nodeLobe[b] === fl ? TIER1[c] : DIM[c] * 1.4;
      else t = BASE[c];
      G.fAT[k] = t; G.fHT[k] = h;
    }
    for (let k = M.NLK; k < M.NF; k++) { G.fAT[k] = 0; G.fHT[k] = 0; }
    for (let i = 0; i < M.NN; i++) {
      let a;
      if (!G.present[i]) a = 0;
      else if (hl >= 0) a = nb.has(i) ? 1 : 0.18;
      else if (matches) a = matches.has(i) ? 1 : 0.22;
      else if (fl >= 0) a = M.nodeLobe[i] === fl || M.nodeLobe[i] < 0 ? 1 : 0.42;
      else a = 1;
      G.nAT[i] = a;
    }
    for (let i = 0; i < M.NL; i++) G.bHi[i] = i === focus ? 1 : i === hoverLobe ? 0.75 : 0;
    // marks
    G.marks = [];
    if (pinned >= 0) G.marks.push([pinned, '#ffffff', 1.25]);
    if (hover >= 0 && hover !== pinned) G.marks.push([hover, '#e9e0ff', 1.05]);
    if (preview >= 0 && preview !== pinned && preview !== hover) G.marks.push([preview, '#d24bff', 1.1]);
    if (matches && hl < 0) askRes.slice(0, 40).forEach((r) => { if (G.present[r.i] && G.marks.length < G.MKN) G.marks.push([r.i, '#f0b8ff', 0.9]); });
  }
  function stepAlphas(dt) {
    const k = 1 - Math.exp(-dt * 9);
    let fd = false;
    const st = G.stateArr;
    for (let i = 0; i < M.NF; i++) {
      const a = G.fAlpha[i], t = G.fAT[i], h = G.fHl[i], ht = G.fHT[i];
      if (Math.abs(a - t) > 0.001 || Math.abs(h - ht) > 0.002) {
        G.fAlpha[i] = Math.abs(a - t) < 0.002 ? t : a + (t - a) * k; G.fHl[i] = h + (ht - h) * k;
        st[i * 4] = G.fAlpha[i]; st[i * 4 + 1] = G.fHl[i]; fd = true;
      }
    }
    if (fd) G.stateDirty = true;
    let nd = false;
    for (let i = 0; i < M.NN; i++) { const a = G.nA[i], t = G.nAT[i]; if (Math.abs(a - t) > 0.002) { G.nA[i] = a + (t - a) * k; nd = true; } else if (a !== t) { G.nA[i] = t; nd = true; } }
    if (nd) G.ngeo.attributes.aAlpha.needsUpdate = true;
    if (G.stateDirty) { G.tState.needsUpdate = true; G.stateDirty = false; }
    for (let i = 0; i < 48; i++) { const cur = G.bmat.uniforms.uHi.value[i]; G.bmat.uniforms.uHi.value[i] = cur + ((G.bHi[i] || 0) - cur) * k; }
  }

  // ---------- neural activity ----------
  const PC = PCOL.map(hexRgb);
  const arrivals = [];
  function flash(i, ci, str) {
    if (i < 0 || !G.present[i]) return;
    const o = i * 2, age = now - G.nFlash[o], rem = age >= 0 ? G.nFlash[o + 1] * Math.exp(-age * 2.4) : 0;
    G.nFlash[o] = now; G.nFlash[o + 1] = Math.max(str, rem);
    G.nFC.set(PC[ci], i * 3);
    G.ngeo.attributes.aFlash.needsUpdate = true; G.ngeo.attributes.aFlashCol.needsUpdate = true;
  }
  function ripple(i, ci, str) {
    const j = G.rNext; G.rNext = (G.rNext + 1) % G.RPN;
    G.rpos.set([G.npos[i * 3], G.npos[i * 3 + 1], G.npos[i * 3 + 2]], j * 3); G.rst[j] = now; G.rcol.set(PC[ci], j * 3); G.rstr[j] = str;
    ['position', 'aStart', 'aCol', 'aStr'].forEach((a) => { G.rgeo.attributes[a].needsUpdate = true; });
  }
  function pulse(k, from, ci, str, hop) {
    if (!G.fp[k]) return false;
    const o = k * 4, pa = G.pulseArr;
    if (pa[o + 3] > 0 && now < pa[o] + 1 / Math.abs(pa[o + 1] || 1) + 0.4 && pa[o + 3] > str + 0.05) return false;
    const dur = clamp(G.flen[k] / 150, 0.42, 1.6);
    const fwd = k < M.NLK ? M.links[k][0] === from : true;
    pa[o] = now; pa[o + 1] = (fwd ? 1 : -1) / dur; pa[o + 2] = ci; pa[o + 3] = str;
    G.pulseDirty = true;
    if (G.sparks.length < G.SPN) G.sparks.push({ k, t0: now, dur, fwd, ci, str });
    if (k < M.NLK) arrivals.push({ t: now + dur, node: fwd ? M.links[k][1] : M.links[k][0], ci, str, hop, k });
    else arrivals.push({ t: now + dur, node: M.core ? M.core.i : -1, ci, str: str * 0.5, hop: 0, k });
    return true;
  }
  function fireNode(i, act) {
    if (!G.present[i]) return;
    const ci = ACT[act] != null ? ACT[act] : 1;
    flash(i, ci, 1.1); ripple(i, ci, 1);
    let ks = M.adj[i].filter((k) => G.fp[k]);
    if (ks.length > 140) ks = ks.sort(() => Math.random() - 0.5).slice(0, 140);
    ks.forEach((k) => pulse(k, i, ci, 1.0, 1));
  }
  let hop2Budget = 0;
  function processArrivals() {
    for (let j = arrivals.length - 1; j >= 0; j--) {
      const a = arrivals[j];
      if (a.t > now) continue;
      arrivals.splice(j, 1);
      if (a.node < 0) continue;
      if (a.hop === 1) {
        flash(a.node, a.ci, 0.5);
        const ks = M.adj[a.node].filter((k) => k !== a.k && G.fp[k]);
        for (let q = 0; q < 3 && ks.length && hop2Budget > 0; q++) { const k = ks.splice(Math.floor(Math.random() * ks.length), 1)[0]; if (pulse(k, a.node, a.ci, 0.32, 2)) hop2Budget--; }
      } else flash(a.node, a.ci, a.hop === 2 ? 0.3 : a.str * 0.8);
    }
  }
  function stepSparks() {
    const S = G.sparks, P = G.fpos;
    let n = 0;
    for (let j = S.length - 1; j >= 0; j--) { const s = S[j]; if (now > s.t0 + s.dur * 1.18) S.splice(j, 1); }
    for (let j = 0; j < S.length && n < G.SPN; j++) {
      const s = S[j], u = (now - s.t0) / s.dur;
      const uu = clamp(s.fwd ? u : 1 - u, 0, 1), f = uu * (NP - 1), i0 = Math.min(NP - 2, Math.floor(f)), t = f - i0, o = (s.k * NP + i0) * 3;
      G.spos[n * 3] = P[o] + (P[o + 3] - P[o]) * t; G.spos[n * 3 + 1] = P[o + 1] + (P[o + 4] - P[o + 1]) * t; G.spos[n * 3 + 2] = P[o + 2] + (P[o + 5] - P[o + 2]) * t;
      G.scol.set(PC[s.ci], n * 3);
      G.sA[n] = s.str * (u > 1 ? Math.max(0, 1 - (u - 1) * 5.5) : Math.min(1, u * 8 + 0.2));
      G.sS[n] = s.ci === 0 ? 2.6 : s.ci === 6 ? 2.4 : 3.4 * (0.55 + 0.45 * s.str);
      n++;
    }
    for (let j = n; j < G.sparkUsed; j++) G.sA[j] = 0;
    G.sparkUsed = n;
    ['position', 'aCol', 'aA', 'aSize'].forEach((a) => { G.sgeo.attributes[a].needsUpdate = true; });
    if (G.pulseDirty) { G.tPulse.needsUpdate = true; G.pulseDirty = false; }
  }
  let ambientAcc = 0;
  function ambient(dt) {
    ambientAcc += dt;
    while (ambientAcc > 0.27) {
      ambientAcc -= 0.27 * (0.6 + Math.random() * 0.8);
      for (let tries = 0; tries < 6; tries++) {
        const k = Math.floor(Math.random() * M.NLK);
        if (!G.fp[k] || (M.cls[k] === 2 && Math.random() < 0.6)) continue;
        const l = M.links[k];
        pulse(k, Math.random() < 0.5 ? l[0] : l[1], 0, 0.38 + Math.random() * 0.3, 0);
        break;
      }
    }
  }
  // live fires: coalesced, at most ~8 a second
  const fireQ = [];
  let lastFire = 0;
  const PRIO = { error: 5, write: 4, skill: 3, spawn: 3, read: 2, search: 2, run: 1 };
  function enqueue(item) {
    // paused (not on screen): dropped, so stale fires do not play as one burst on resume (the ticker still lists the event)
    if (paused) return;
    const same = fireQ.find((q) => (item.i != null && q.i === item.i) || (item.peri != null && q.peri === item.peri));
    if (same) { if ((PRIO[item.act] || 0) > (PRIO[same.act] || 0)) same.act = item.act; return; }
    fireQ.push(item);
    while (fireQ.length > 24) fireQ.shift();
  }
  function stepFires() {
    if (!fireQ.length || now - lastFire < 0.125) return;
    lastFire = now; hop2Budget = Math.min(hop2Budget + 40, 120);
    const it = fireQ.shift();
    if (it.i != null) fireNode(it.i, it.act);
    else if (it.peri != null) { const k = M.NLK + it.peri; pulse(k, -1, it.act === 'error' ? 3 : 6, it.act === 'error' ? 0.8 : 0.6, 0); }
  }

  // ---------- event -> nodes ----------
  function idsFromEvent(ev) {
    const ids = [];
    const p = ev.path ? String(ev.path).replace(/\\/g, '/') : '';
    if (p) {
      const base = p.split('/').pop();
      if (base === 'MEMORY.md') ids.push('MEMORY');
      else if (/^(_INDEX|_MOC-.+)\.md$/i.test(base)) ids.push(base.replace(/\.md$/i, ''));
      else if (p.includes('/memory/') && /\.md$/i.test(base)) ids.push(base.replace(/\.md$/i, ''));
      const sm = p.match(/\/\.claude\/skills\/([^/]+)\//);
      if (sm) ids.push('skill:' + sm[1]);
    }
    (Array.isArray(ev.notes) ? ev.notes : []).forEach((id) => { if (id) ids.push(String(id).replace(/\.md$/i, '')); });
    if (ev.skill) ids.push('skill:' + String(ev.skill).replace(/^.*:/, ''));
    if (ev.id) ids.push(String(ev.id));
    if (ev.recall) search(String(ev.recall)).results.slice(0, 5).forEach((r) => ids.push(M.nodes[r.i].id));
    return [...new Set(ids)];
  }
  let pendingIds = new Map();
  function handleNeuron(ev, src) {
    if (!M) return;
    const act = ACT[ev.act] != null ? ev.act : 'read';
    const ids = idsFromEvent(ev);
    const hit = [], missing = [];
    ids.forEach((id) => { const i = M.byId.get(id); if (i != null) hit.push(i); else missing.push(id); });
    hit.forEach((i) => enqueue({ i, act }));
    // a memory note we do not have yet: fetch a fresh snapshot (at most every 20 s), then it is born on the rim
    const memMissing = missing.filter((id) => !id.startsWith('skill:') || true);
    if (memMissing.length && SERVED) { memMissing.forEach((id) => pendingIds.set(id, act)); requestRefresh(); }
    if (!hit.length) {
      const key = (ev.path ? String(ev.path).replace(/\\/g, '/').split('/').slice(-2).join('/') : '') + (ev.tool || '') + (ev.folder || '');
      enqueue({ peri: Math.floor(hash01(key || String(Math.random())) * NPER), act });
    }
    tickerAdd(ev, act, hit, src);
  }

  // ---------- camera ----------
  function placeCam(c, cm) {
    const ce = Math.cos(c.el);
    cm.position.set(c.tx + c.dist * ce * Math.sin(c.az), c.ty + c.dist * Math.sin(c.el), c.tz + c.dist * ce * Math.cos(c.az));
    cm.up.set(0, 1, 0); cm.lookAt(c.tx, c.ty, c.tz); cm.updateMatrixWorld(); cm.matrixWorldInverse.copy(cm.matrixWorld).invert();
  }
  const VP = new THREE.Matrix4();
  function projInto(m, x, y, z, out) {
    const e = m.elements, cx = e[0] * x + e[4] * y + e[8] * z + e[12], cy = e[1] * x + e[5] * y + e[9] * z + e[13], cw = e[3] * x + e[7] * y + e[11] * z + e[15];
    out[0] = (cx / cw + 1) / 2 * W; out[1] = (1 - cy / cw) / 2 * H; out[2] = cw; return out;
  }
  const tmpV = [0, 0, 0], tmpM = new THREE.Matrix4();
  function boundsAt(c, pts) {
    placeCam(c, tmpCam); tmpM.multiplyMatrices(tmpCam.projectionMatrix, tmpCam.matrixWorldInverse);
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (let i = 0; i < pts.length; i += 3) { projInto(tmpM, pts[i], pts[i + 1], pts[i + 2], tmpV); if (tmpV[2] <= 0) return null; x0 = Math.min(x0, tmpV[0]); x1 = Math.max(x1, tmpV[0]); y0 = Math.min(y0, tmpV[1]); y1 = Math.max(y1, tmpV[1]); }
    return { x0, x1, y0, y1 };
  }
  function fitPoints() {
    const pts = [];
    for (let s = 0; s < 72; s++) { const t = s / 72 * TAU; pts.push((R + 12) * Math.cos(t), 0, (R + 12) * Math.sin(t)); }
    for (let k = 0; k < M.NLK; k += 3) for (let j = 4; j < NP - 4; j += 4) { const o = (k * NP + j) * 3; pts.push(G.fpos[o], G.fpos[o + 1], G.fpos[o + 2]); }
    return pts;
  }
  // the bead ring itself (radius R): the lobe names in mini need room beside it (overviewGoal)
  const RIMPTS = []; for (let s = 0; s < 72; s++) { const t = s / 72 * TAU; RIMPTS.push(R * Math.cos(t), 0, R * Math.sin(t)); }
  // the widest lobe name as mini draws it: the heading only (.lobe .h at 600 13px, its count in 12px mono 7px after it, 6px of
  // padding each side), measured from the text so it holds before the labels are on screen
  function widestLobeName() {
    let w = 0;
    M.lobes.forEach((lb) => { w = Math.max(w, 12 + (M.SEC ? 14 : 0) + textW(lb.label, "600 13px 'Segoe UI'") + 7 + textW(fmtN(lb.members.length), "12px 'Cascadia Code', Consolas, monospace")); });
    return w;
  }
  function overviewGoal() {
    // mini (embedded): a small window with no chrome. The sides keep up to 140px (the room the lobe names need beside the ring
    // is checked separately, below); the top leaves room for the back row of names below the dashboard's chip,
    // which overlaps the window's top edge; the bottom for the front row of names. Tuned with shots at 832 to 1690 px wide.
    const mx = MINI ? clamp(W * 0.165, 36, 140) : W >= 2400 ? 300 : 230, mt = MINI ? 70 : 38, mb = MINI ? 40 : 30;
    const box = { x0: FREE.x0 + mx, x1: FREE.x1 - mx, y0: FREE.y0 + mt, y1: FREE.y1 - mb };
    const pts = fitPoints();
    const az = goal && goal.az != null ? goal.az : cam.az;
    // mini: only the size has to fit, the view is shifted afterwards so the ring sits in the middle of the box (perspective puts
    // the far rim nearer the centre than the near rim, so centring the ring's middle would leave the top of the window empty)
    const fits = (b) => !!b && (MINI ? b.x1 - b.x0 <= box.x1 - box.x0 && b.y1 - b.y0 <= box.y1 - box.y0 : b.x0 >= box.x0 && b.x1 <= box.x1 && b.y0 >= box.y0 && b.y1 <= box.y1);
    // mini: drawLabels slides a lobe name that would run past the window's side back over the ring, so the beads also leave room
    // for the widest name beside them (8px from the window's edge, 10px clear of the beads) on both sides; without it the long
    // names lie on the rim in a small window. The ring is centred across the window in mini, so its half-width is what counts
    const room = MINI ? W / 2 - 8 - widestLobeName() - 10 : Infinity;
    const roomy = (c) => { const b = boundsAt(c, RIMPTS); return !!b && (b.x1 - b.x0) / 2 <= room; };
    const fitAt = (el, withRoom) => {
      let lo = 60, hi = 4000;
      for (let it = 0; it < 24; it++) {
        const mid = (lo + hi) / 2, c = { tx: 0, ty: 0, tz: 0, az, el, dist: mid }, b = boundsAt(c, pts);
        if (fits(b) && (!withRoom || roomy(c))) hi = mid; else lo = mid;
      }
      return hi;
    };
    // the room for names never takes the ring below about 60% of the size that fits (a very small window keeps a readable ring)
    const fitEl = (el) => { const d = fitAt(el, false); return MINI ? Math.min(fitAt(el, true), d / 0.6) : d; };
    // the tilt that fills the free area best, prefering the lower tilt on a near tie. The range starts at about 34 degrees so the
    // ring reads as a circle seen in perspective (not a thin ellipse) and the dome stays inside the far rim, under the back labels
    const cands = []; for (let el = 0.60; el <= 0.721; el += 0.04) cands.push([el, fitEl(el)]);
    const best = Math.min(...cands.map((c) => c[1]));
    const pick = cands.find((c) => c[1] <= best * 1.03) || [EL0, fitEl(EL0)];
    elDefault = pick[0]; fitDistance = pick[1];
    if (MINI) {
      const b = boundsAt({ tx: 0, ty: 0, tz: 0, az, el: pick[0], dist: pick[1] }, pts);
      if (b) { viewDY += (box.y0 + box.y1) / 2 - (b.y0 + b.y1) / 2; setView(); }
    }
    return { tx: 0, ty: 0, tz: 0, az, el: pick[0], dist: pick[1] };
  }
  // screen box of the lobe's beads with each bead's title to its right (lw = title width in px, fixed at any zoom)
  const tmpB = [0, 0, 0];
  function blockAt(c, pts, lw) {
    placeCam(c, tmpCam); tmpM.multiplyMatrices(tmpCam.projectionMatrix, tmpCam.matrixWorldInverse);
    let x0 = 1e9, xr = -1e9, y0 = 1e9, y1 = -1e9;
    for (let k = 0; k < lw.length; k++) {
      const x = pts[k * 3], z = pts[k * 3 + 2];
      projInto(tmpM, x, 0, z, tmpV); if (tmpV[2] <= 0) return null;
      projInto(tmpM, x * (R + 12) / R, 0, z * (R + 12) / R, tmpB); // titles start past the rim band (as drawLabels places them)
      x0 = Math.min(x0, tmpV[0] - 8); xr = Math.max(xr, Math.max(tmpV[0] + 8, tmpB[0] + 4) + lw[k] - 10); y0 = Math.min(y0, tmpV[1] - 8); y1 = Math.max(y1, tmpV[1] + 8);
    }
    return { x0, xr, y0, y1 };
  }
  function focusGoal(li, withCard) {
    const lb = M.lobes[li], mem = lb.members, a0 = M.tAng[mem[0].i], a1 = M.tAng[mem[mem.length - 1].i], mid = (a0 + a1) / 2;
    const el = 1.0, az = cam.az + wrapPi(-mid - cam.az);
    // the arc and its titles must fit below the Ask bar (with room for the lobe heading above the arc), above the strip,
    // and left of the card when one is open
    const bx0 = FREE.x0 + 8, bx1 = withCard ? W - 16 - cardWidth() - 28 : FREE.x1 - 8;
    const by0 = FREE.y0 + lobeLH() + 16, by1 = FREE.y1 - 10;
    const fw = bx1 - bx0, fh = by1 - by0;
    const pts = [], lw = [];
    const add = (n) => { const t = M.tAng[n.i]; pts.push(R * Math.cos(t), 0, R * Math.sin(t)); lw.push(10 + Math.min(320, textW(n.label, "12px 'Segoe UI'") + 10)); };
    const stepN = Math.max(1, Math.ceil(mem.length / 90));
    for (let s = 0; s < mem.length; s += stepN) add(mem[s]);
    add(mem[mem.length - 1]);
    let tx = Math.cos(mid) * R * 0.6, tz = Math.sin(mid) * R * 0.6, dist = fitDistance * 0.6;
    // small lobes are not blown up to the full height: the arc's height is capped by its angular span
    const span = Math.max(0.12, a1 - a0), capH = fh * clamp(span / 1.2, 0.5, 1);
    for (let it = 0; it < 4; it++) {
      let lo = 30, hi = 4000;
      for (let q = 0; q < 26; q++) { const m = (lo + hi) / 2, b = blockAt({ tx, ty: 0, tz, az, el, dist: m }, pts, lw); if (b && b.y1 - b.y0 <= capH && b.xr - b.x0 <= fw) hi = m; else lo = m; }
      dist = hi;
      const b = blockAt({ tx, ty: 0, tz, az, el, dist }, pts, lw);
      if (!b) break;
      // right-align the arc and its titles against the card (or the right edge), so the ring's inside stays on screen to the left
      const ppu = (H / (2 * Math.tan(FOV * Math.PI / 360))) / dist;
      const sx = (b.xr - bx1) / ppu, sy = ((b.y0 + b.y1) / 2 - (by0 + by1) / 2) / ppu;
      tx += Math.cos(az) * sx; tz += -Math.sin(az) * sx;
      // vertical screen offset: move the target along the ground direction pointing away from the camera
      tx += -Math.sin(az) * -sy / Math.sin(el) * 0.9; tz += -Math.cos(az) * -sy / Math.sin(el) * 0.9;
    }
    return { tx, ty: 0, tz, az, el, dist };
  }
  function stepCamera(dt) {
    if (goal) {
      const k = 1 - Math.exp(-dt * 4.2);
      cam.tx += (goal.tx - cam.tx) * k; cam.ty += (goal.ty - cam.ty) * k; cam.tz += (goal.tz - cam.tz) * k;
      cam.az += wrapPi(goal.az - cam.az) * k; cam.el += (goal.el - cam.el) * k; cam.dist += (goal.dist - cam.dist) * k;
      if (Math.abs(goal.dist - cam.dist) < 0.05 && Math.abs(wrapPi(goal.az - cam.az)) < 0.0005 && Math.abs(goal.el - cam.el) < 0.0005 && Math.hypot(goal.tx - cam.tx, goal.tz - cam.tz) < 0.02) goal = null;
    } else if (focus < 0 && pinned < 0 && !drag && now - lastInput > 6 && !matches) {
      cam.az += dt * 0.045;
    }
    placeCam(cam, camera);
    VP.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const cd = camera.position.length();
    const near = Math.max(1, cd - R * 0.95), far = cd + R * 0.95;
    [G.fmat, G.nmat, G.smat, G.bmat, G.gmat].forEach((m) => { m.uniforms.uNear.value = near; m.uniforms.uFar.value = far; });
  }

  // ---------- input ----------
  let drag = null;
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('mousedown', (e) => {
    // what is under the cursor is decided at the press, so a click that lasts several frames still pins what it was on
    mouse.x = e.clientX; mouse.y = e.clientY; mouse.in = true;
    const hit = M ? nodeAt(e.clientX, e.clientY) : -1;
    drag = { x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, pan: e.button === 2 || e.shiftKey, moved: false, hover: hit, lobe: M && hit < 0 ? lobeAtMouse() : -1 };
    canvas.classList.add('drag');
  });
  window.addEventListener('mouseup', (e) => {
    if (drag && !drag.moved && e.button === 0 && e.target === canvas) click(drag);
    drag = null; canvas.classList.remove('drag');
  });
  window.addEventListener('mousemove', (e) => {
    mouse.x = e.clientX; mouse.y = e.clientY; mouse.moved = true; mouse.in = e.target === canvas;
    if (!drag) return;
    const dx = e.clientX - drag.lx, dy = e.clientY - drag.ly; drag.lx = e.clientX; drag.ly = e.clientY;
    if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 3) drag.moved = true;
    if (!drag.moved) return;
    goal = null; lastInput = now;
    if (drag.pan) {
      const k = cam.dist * 0.0011, ca = Math.cos(cam.az), sa = Math.sin(cam.az);
      cam.tx += (-dx * ca - dy * sa) * k; cam.tz += (dx * sa - dy * ca) * k;
    } else {
      cam.az -= dx * 0.005; cam.el = clamp(cam.el + dy * 0.004, -0.6, 1.42);
    }
  });
  canvas.addEventListener('mouseleave', () => { mouse.in = false; });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault(); goal = null; lastInput = now;
    cam.dist = clamp(cam.dist * Math.exp(e.deltaY * 0.0011), 25, fitDistance * 3);
  }, { passive: false });
  canvas.addEventListener('dblclick', () => { resetView(); });
  function resetView() { pinned = -1; renderCard(); hover = -1; if (focus >= 0) setFocus(-1); else goal = overviewGoal(); targetsDirty = true; }
  function click(d) {
    if (d.hover >= 0) {
      // mini: a note does not pin here, it asks the dashboard to open the full view, where it is pinned (setMini)
      if (MINI) { pendingPin = d.hover; post({ type: 'brain:expand', pin: M.nodes[d.hover].id }); return; }
      pin(d.hover); return;
    }
    const li = d.lobe;
    if (li >= 0) { setFocus(li === focus ? -1 : li); return; }
    if (pinned >= 0) pin(-1); else if (focus >= 0) setFocus(-1);
  }
  const ray = new THREE.Raycaster(), plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hitP = new THREE.Vector3(), ndc = new THREE.Vector2();
  function lobeAtMouse() {
    if (!mouse.in) return -1;
    ndc.set(mouse.x / W * 2 - 1, -(mouse.y / H) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    if (!ray.ray.intersectPlane(plane, hitP)) return -1;
    const r = Math.hypot(hitP.x, hitP.z); if (r < R + 2 || r > R + 24) return -1;
    const t = Math.atan2(hitP.z, hitP.x);
    for (let i = 0; i < M.NL; i++) { const d = ((t - lobeA0[i]) % TAU + TAU) % TAU; if (d <= lobeA1[i] - lobeA0[i]) return i; }
    return -1;
  }
  function nodeAt(mx, my) {
    let best = -1, bd = 1e9;
    for (let i = 0; i < M.NN; i++) {
      if (G.nA[i] < 0.15) continue;
      const sx = G.scr[i * 3], sy = G.scr[i * 3 + 1], w = G.scr[i * 3 + 2]; if (w <= 0) continue;
      const dx = sx - mx, dy = sy - my, d = dx * dx + dy * dy;
      const rr = Math.max(7, G.nsize[i] * 0.16 * UPX / GPR / w);
      if (d < rr * rr && d < bd) { bd = d; best = i; }
    }
    return best;
  }
  function updateHover() {
    // keep tracking during a press that has not moved yet (a click); stop only once it turns into a drag
    const track = mouse.in && (!drag || !drag.moved);
    let best = track ? nodeAt(mouse.x, mouse.y) : -1;
    let lobe = -1;
    if (best < 0 && track) lobe = lobeAtMouse();
    if (lobeLabelHover >= 0) lobe = lobeLabelHover;
    if (best !== hover || lobe !== hoverLobe) {
      hover = best; hoverLobe = lobe; targetsDirty = true;
      canvas.classList.toggle('point', best >= 0 || lobe >= 0);
      if (best >= 0) showNodeTip(best); else if (lobe >= 0) showLobeTip(lobe); else hideTip();
    }
    if (best >= 0 || lobe >= 0) placeTip();
  }
  window.addEventListener('keydown', (e) => {
    // mini: the Ask bar, the timeline and lobe stepping are not on screen; Escape only resets the view
    if (MINI) { if (e.key === 'Escape') { e.preventDefault(); resetView(); } return; }
    const inQ = document.activeElement === qEl;
    if (e.key === '/' && !inQ) { e.preventDefault(); qEl.focus(); qEl.select(); if (askRes.length) resEl.classList.add('on'); return; }
    if (e.key === 'Escape') {
      e.preventDefault();
      if (qEl.value || matches) { qEl.value = ''; runAsk(''); qEl.blur(); return; }
      if (inQ) { qEl.blur(); return; }
      // nothing left to clear: embedded, Escape goes back to the dashboard (post does nothing standalone)
      if (pinned >= 0) pin(-1); else if (focus >= 0) setFocus(-1); else post({ type: 'brain:collapse' });
      return;
    }
    if (inQ) return;
    if (e.key === ' ') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { const d = e.key === 'ArrowRight' ? 1 : -1; setFocus(focus < 0 ? 0 : (focus + d + M.NL) % M.NL); }
  });

  // ---------- labels ----------
  const labLayer = $('labels'), lead = $('lead'), lctx = lead.getContext('2d');
  const meas = document.createElement('canvas').getContext('2d');
  const wCache = new Map();
  function textW(s, font) { const key = font + '|' + s; let w = wCache.get(key); if (w == null) { meas.font = font; w = meas.measureText(s).width; wCache.set(key, w); } return w; }
  let lobeEls = [], innerEls = [], coreEl = null, notePool = [], lobeLabelHover = -1;
  function buildLabels() {
    labLayer.innerHTML = ''; notePool = [];
    lobeEls = M.lobes.map((lb, i) => {
      const el = document.createElement('div'); el.className = 'lab lobe';
      el.innerHTML = M.SEC
        ? `<div class="h"><i class="sw" style="background:${esc(lb.color)};color:${esc(lb.color)}"></i><span class="k">${esc(lb.label)}</span><b>${fmtN(lb.members.length)}</b></div>${lb.anchorLabel ? `<div class="a">${esc(lb.anchorLabel)}</div>` : ''}`
        : `<div class="h"><span class="k">${esc(lb.label)}</span><b>${fmtN(lb.members.length)}</b></div>${lb.anchorLabel ? `<div class="a">◆ ${esc(lb.anchorLabel)}</div>` : ''}`;
      el.addEventListener('mouseenter', () => { lobeLabelHover = i; });
      el.addEventListener('mouseleave', () => { lobeLabelHover = -1; });
      el.addEventListener('click', () => setFocus(i === focus ? -1 : i));
      labLayer.appendChild(el);
      const ai = !M.SEC && lb.comm && lb.comm.anchor != null ? M.byId.get(lb.comm.anchor) : null;
      return { el, w: 0, cnt: el.querySelector('b'), a: el.querySelector('.a'), ai: ai == null ? -1 : ai, n: -1 };
    });
    // sections: each section map sits right under its own lobe (its tooltip names it), so only _SITEMAP carries a name
    innerEls = M.inner.filter((n) => !(M.SEC && n.type === 'moc' && n.section >= 0)).map((n) => { const el = document.createElement('div'); el.className = 'lab inn' + (n.type === 'moc' ? ' moc' : ''); el.textContent = n.label.replace(/^MOC /, ''); labLayer.appendChild(el); return { el, n, w: textW(el.textContent, "600 12px 'Segoe UI'") }; });
    if (M.core) { coreEl = document.createElement('div'); coreEl.className = 'lab core'; coreEl.innerHTML = `${esc(M.core.label)}<small>${fmtN(M.core.deg)} links</small>`; labLayer.appendChild(coreEl); }
  }
  // scrubbed back in time: a lobe with no notes yet loses its label, and the anchor line waits for its note
  function updateLobeCounts() {
    if (!lobeEls.length) return;
    M.lobes.forEach((lb, i) => {
      const L = lobeEls[i], c = lb.members.reduce((s, n) => s + G.present[n.i], 0);
      L.cnt.textContent = fmtN(c); L.n = c; L.w = 0;
      if (L.a) L.a.style.display = L.ai < 0 || G.present[L.ai] ? '' : 'none';
    });
  }
  function noteLab(k) { if (!notePool[k]) { const el = document.createElement('div'); el.className = 'lab nl'; el.style.display = 'none'; labLayer.appendChild(el); notePool[k] = { el, i: -1, c: '' }; } return notePool[k]; }
  const P3 = [0, 0, 0];
  function drawLabels() {
    const C = projInto(VP, 0, YC, 0, [0, 0, 0]);
    lctx.setTransform(DPR, 0, 0, DPR, 0, 0); lctx.clearRect(0, 0, W, H);
    if (LITE) lead.style.display = 'none';
    const hl = hover >= 0 ? hover : pinned >= 0 ? pinned : preview;
    const dimAll = hl >= 0 || !!matches;
    // lobe labels: two columns, pushed apart vertically, leader lines to the rim
    const items = [];
    for (let i = 0; i < M.NL; i++) {
      const t = lobeMid[i], P = projInto(VP, (R + 11) * Math.cos(t), 0, (R + 11) * Math.sin(t), [0, 0, 0]);
      if (P[2] <= 0) continue;
      let dx = P[0] - C[0], dy = P[1] - C[1]; const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
      const side = dx >= 0 ? 1 : -1;
      items.push({ i, side, px: P[0], py: P[1], x: P[0] + dx * 18, y: P[1] + dy * 18 + (dy < 0 ? -14 : 8), depth: P[2] });
    }
    const LH = lobeLH(), minY = FREE.y0 + LH / 2 - 6, maxY = FREE.y1 - LH / 2 + 4;
    const placed = []; // boxes already on screen that note titles must not overprint
    [1, -1].forEach((side) => {
      const arr = items.filter((it) => it.side === side && it.i !== focus).sort((a, b) => a.y - b.y);
      for (let k = 1; k < arr.length; k++) if (arr[k].y - arr[k - 1].y < LH) arr[k].y = arr[k - 1].y + LH;
      if (arr.length && arr[arr.length - 1].y > maxY) { arr[arr.length - 1].y = maxY; for (let k = arr.length - 2; k >= 0; k--) if (arr[k + 1].y - arr[k].y < LH) arr[k].y = arr[k + 1].y - LH; }
      if (arr.length && arr[0].y < minY) { arr[0].y = minY; for (let k = 1; k < arr.length; k++) if (arr[k].y - arr[k - 1].y < LH) arr[k].y = arr[k - 1].y + LH; }
    });
    const depths = items.map((it) => it.depth), dmin = Math.min(...depths), dmax = Math.max(...depths);
    const shown = new Set();
    items.forEach((it) => {
      // with a lobe in front, the other lobes' labels are hidden: their rim runs off screen and they would sit on the inner ring
      if (focus >= 0 && it.i !== focus) return;
      const L = lobeEls[it.i];
      if (L.n === 0 && it.i !== focus) return;
      shown.add(it.i);
      if (!L.w) L.w = L.el.offsetWidth;
      let x = it.side > 0 ? it.x : it.x - L.w, y = it.y - LH / 2;
      if (it.i === focus) {
        // the lobe in front: its label sits above its arc, and note titles keep clear of it
        let top = 1e9, tx = 0; M.lobes[it.i].members.forEach((n) => { const sy = G.scr[n.i * 3 + 1]; if (G.present[n.i] && sy < top) { top = sy; tx = G.scr[n.i * 3]; } });
        x = tx - 10; y = Math.max(FREE.y0 + 4, top - LH - 12);
      }
      x = clamp(x, 8, W - 8 - L.w);
      // a full live ticker (bottom left) would cover a low label on the left: slide it right of the ticker, the leader follows
      if (it.i !== focus && hitsBox(CHROME.ticker, x, y, x + L.w, y + LH)) x = Math.min(W - 8 - L.w, CHROME.ticker.x1 + 10);
      if (it.i === focus) placed.push([x - 4, y - 2, x + L.w + 4, y + LH + 4]);
      const on = it.i === hoverLobe || it.i === focus;
      L.el.className = 'lab lobe' + (it.side < 0 ? ' r' : '') + (on ? ' on' : '');
      L.el.style.transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px)`;
      const df = dmax > dmin ? (it.depth - dmin) / (dmax - dmin) : 0;
      L.el.style.opacity = ((dimAll || focus >= 0) && !on ? 0.32 : 1 - df * 0.2).toFixed(2);
      L.el.style.display = 'block';
      if (it.i !== focus) {
        // leader to the label's nearest edge (the side edge as before; top or bottom edge when the label was slid over its anchor)
        let ex, ey = it.y;
        if (it.px <= x) ex = x - 3; else if (it.px >= x + L.w) ex = x + L.w + 3; else { ex = it.px; ey = it.py < y ? y - 2 : y + LH + 2; }
        lctx.strokeStyle = on ? 'rgba(191,166,255,.8)' : `rgba(167,139,250,${(0.32 - df * 0.14).toFixed(3)})`; lctx.lineWidth = 1;
        lctx.beginPath(); lctx.moveTo(it.px, it.py); lctx.lineTo(ex, ey); lctx.stroke();
      }
    });
    lobeEls.forEach((L, i) => { if (!shown.has(i)) L.el.style.display = 'none'; });
    // mini: the inner-ring and core names follow their beads past the window's edge when zoomed in, so they fade out over the
    // soft edge with the scene instead of being cut off (1 = clear of the edge; always 1 outside mini)
    const edgeFade = (x0, y0, x1, y1) => (MINI && FE > 0 ? clamp(Math.min(x0, y0, W - x1, H - y1) / FE, 0, 1) : 1);
    // inner ring + core
    innerEls.forEach((o) => {
      const i = o.n.i, sx = G.scr[i * 3], sy = G.scr[i * 3 + 1];
      if (G.scr[i * 3 + 2] <= 0) { o.el.style.display = 'none'; return; }
      const dx = sx - C[0]; const left = dx >= 0;
      const x = left ? sx + 9 : sx - 9 - o.w;
      o.el.style.display = 'block'; o.el.style.transform = `translate(${x.toFixed(1)}px,${(sy - 8).toFixed(1)}px)`;
      o.el.style.opacity = ((hl >= 0 && G.nAT[i] < 0.5 ? 0.3 : 1) * edgeFade(x, sy - 8, x + o.w, sy + 9)).toFixed(2);
      placed.push([x - 2, sy - 9, x + o.w + 2, sy + 9]);
    });
    if (coreEl && M.core) {
      const i = M.core.i, cx = G.scr[i * 3] - 60, cy = G.scr[i * 3 + 1] + 16;
      coreEl.style.transform = `translate(${cx.toFixed(1)}px,${cy.toFixed(1)}px)`; coreEl.style.width = '120px';
      coreEl.style.opacity = ((hl >= 0 && hl !== i ? 0.45 : 1) * edgeFade(cx, cy, cx + 120, cy + 34)).toFixed(2);
      if (G.scr[i * 3 + 2] > 0) placed.push([cx + 10, cy - 2, cx + 110, cy + 34]);
    }
    // note titles: hovered / pinned and their neighbours, Ask matches, the lobe in front
    const cand = [], seen = new Set();
    const add = (i, c) => { if (i >= 0 && !seen.has(i) && G.present[i] && M.nodeLobe[i] >= 0) { seen.add(i); cand.push([i, c]); } };
    if (hl >= 0) { add(hl, 'h'); M.adj[hl].map((k) => (M.links[k][0] === hl ? M.links[k][1] : M.links[k][0])).sort((a, b) => M.nodes[b].deg - M.nodes[a].deg).slice(0, 36).forEach((j) => add(j, 's')); }
    if (matches) askRes.slice(0, 30).forEach((r) => add(r.i, 'm'));
    if (focus >= 0) M.lobes[focus].members.slice().sort((a, b) => b.deg - a.deg).forEach((n) => add(n.i, ''));
    let used = 0;
    const font = "12px 'Segoe UI'", cardOn = pinned >= 0;
    for (let c = 0; c < cand.length && used < 190; c++) {
      const [i, cl] = cand[c], sx = G.scr[i * 3], sy = G.scr[i * 3 + 1];
      if (G.scr[i * 3 + 2] <= 0) continue;
      const lbl = M.nodes[i].label, w = Math.min(320, textW(lbl, cl === 'h' ? "700 12px 'Segoe UI'" : font) + 10), h = 15;
      const right = sx >= C[0] || (focus >= 0 && M.nodeLobe[i] === focus);
      // titles start past the rim band (projected at the bead's angle), not on top of it
      const a = M.ang[i]; projInto(VP, (R + 12) * Math.cos(a), 0, (R + 12) * Math.sin(a), P3);
      const x = right ? Math.max(sx + 8, P3[0] + 4) : Math.min(sx - 8, P3[0] - 4) - w, y = sy - h / 2;
      // (up to 30px above FREE, into the room under the Ask bar; mini has no bar, so there the window's top edge is the limit)
      if (x < 4 || x + w > W - 4 || y < Math.max(4, FREE.y0 - 30) || y + h > H - 4) continue;
      // never under the Ask bar, the ticker or the open card
      if (hitsBox(CHROME.bar, x, y, x + w, y + h) || hitsBox(CHROME.ticker, x, y, x + w, y + h) || (cardOn && hitsBox(CHROME.card, x, y, x + w, y + h))) continue;
      let clash = false;
      if (cl !== 'h') for (let p = 0; p < placed.length; p++) { const q = placed[p]; if (x < q[2] && x + w > q[0] && y < q[3] && y + h > q[1]) { clash = true; break; } }
      if (clash) continue;
      placed.push([x - 2, y - 1, x + w + 2, y + h + 1]);
      const P = noteLab(used++);
      if (P.i !== i || P.c !== cl) { P.i = i; P.c = cl; P.el.textContent = lbl; P.el.className = 'lab nl' + (cl ? ' ' + cl : ''); P.el.style.maxWidth = '320px'; P.el.style.overflow = 'hidden'; P.el.style.textOverflow = 'ellipsis'; }
      P.el.style.display = 'block';
      P.el.style.transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px)`;
      P.el.style.opacity = Math.min(1, G.nA[i] * 1.2).toFixed(2);
    }
    for (let k = used; k < notePool.length; k++) if (notePool[k].el.style.display !== 'none') { notePool[k].el.style.display = 'none'; notePool[k].i = -1; }
  }

  // ---------- tooltip ----------
  const tip = $('tip');
  // where a node sits: Section > Topic (sections), the lobe (clusters), or the inner ring / centre
  function whereText(i) {
    const n = M.nodes[i], li = M.nodeLobe[i];
    if (li < 0) return n.type === 'core' ? 'centre' : M.SEC ? (n.section >= 0 && M.data.sections[n.section] ? 'map of ' + M.data.sections[n.section].name : 'inner ring') : 'inner ring';
    if (!M.SEC) return M.lobes[li].label;
    const gr = M.lobes[li].groups[M.nodeGroup[i]];
    return M.lobes[li].label + (gr && gr.topic && gr.topic !== M.lobes[li].label ? ' › ' + gr.topic : '');
  }
  function showNodeTip(i) {
    const n = M.nodes[i], li = M.nodeLobe[i];
    tip.innerHTML = `<div class="ty"><span class="dot" style="color:${M.colorOf(n.type)}"></span>${esc(TYPE_NAME[n.type] || n.type)}</div><div class="t">${esc(n.label)}</div>${n.desc ? `<div class="d">${esc(n.desc)}</div>` : ''}<div class="m">${fmtN(n.deg)} links · ${esc(whereText(i))} · click to pin</div>`;
    tip.style.display = 'block';
  }
  function showLobeTip(li) {
    const lb = M.lobes[li];
    if (M.SEC) {
      const pairs = [...M.pairN.entries()].filter(([k]) => Math.floor(k / M.NL) === li || k % M.NL === li).length;
      tip.innerHTML = `<div class="ty"><span class="dot" style="color:${esc(lb.color)}"></span>Section · click to bring it to the front</div><div class="t">${esc(lb.label)}</div>${lb.sec && lb.sec.scope ? `<div class="d">${esc(lb.sec.scope)}</div>` : ''}<div class="m">${fmtN(lb.members.length)} nodes · ${esc(lb.anchorLabel)} · ${fmtN(lb.internal)} links inside · ${fmtN(lb.flows)} to ${fmtN(pairs)} other sections</div>`;
      tip.style.display = 'block'; return;
    }
    tip.innerHTML = `<div class="ty">Lobe · click to bring it to the front</div><div class="t">${esc(lb.label)}</div><div class="d">Most-linked note: ${esc(lb.anchorLabel || '-')}</div><div class="m">${fmtN(lb.members.length)} nodes · ${fmtN(lb.internal)} links inside · ${fmtN(lb.flows)} to other lobes</div>`;
    tip.style.display = 'block';
  }
  function hideTip() { tip.style.display = 'none'; }
  function placeTip() {
    const tw = tip.offsetWidth, th = tip.offsetHeight; let x = mouse.x + 18, y = mouse.y + 16;
    if (x + tw > W - 10) x = mouse.x - tw - 18; if (y + th > H - 10) y = mouse.y - th - 16;
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
  }

  // ---------- pinned card ----------
  const card = $('card'), cardIn = $('cardIn');
  function pin(i) {
    pinned = i; targetsDirty = true; lastInput = now;
    renderCard();
    // a lobe in front is re-framed so the card does not cover its arc or titles
    if (focus >= 0) goal = focusGoal(focus, pinned >= 0);
  }
  function goTo(i) {
    const li = M.nodeLobe[i];
    pinned = i; renderCard();
    if (li >= 0) setFocus(li, { withCard: true }); else { targetsDirty = true; if (focus >= 0) setFocus(-1); }
  }
  function folderText(f) {
    if (f === 'ace') return 'the ace workspace';
    if (f === 'home') return 'the home folder<small>a session opened in your home folder; the note still landed in this brain</small>';
    if (f === 'not-on-this-machine') return 'another computer<small>that session is not on this machine</small>';
    if (f === 'other') return 'another folder';
    return 'no session stamp';
  }
  function renderCard() {
    if (pinned < 0 || !M) { card.classList.remove('on'); return; }
    const i = pinned, n = M.nodes[i], li = M.nodeLobe[i];
    let h = `<button class="x" id="unpin" title="Unpin (Esc)">×</button><div class="ctype"><span class="dot" style="color:${M.colorOf(n.type)}"></span>${esc(TYPE_NAME[n.type] || n.type)} · pinned</div><h2>${esc(n.label)}</h2>`;
    if (n.desc) h += `<p>${esc(n.desc)}</p>`;
    h += '<dl class="facts">';
    h += `<dt>Created</dt><dd>${n.created ? esc(fmtLocal(n.created)) + `<small>${esc(SRC[n.createdSource] || n.createdSource || 'source unknown')}</small>` : 'no date<small>skills, domains and index maps carry none</small>'}</dd>`;
    h += `<dt>Updated</dt><dd>${n.updated ? esc(fmtLocal(n.updated)) : 'not recorded'}</dd>`;
    h += `<dt>Session</dt><dd>${n.created || n.originFolder ? 'started in ' + folderText(n.originFolder) : 'not applicable'}</dd>`;
    h += M.SEC ? `<dt>Home</dt><dd>${esc(whereText(i))}${n.homeSource === 'inbox' || n.homeSource === 'not-in-sitemap' ? '<small>not placed in a section yet</small>' : ''}</dd>`
      : `<dt>Lobe</dt><dd>${li >= 0 ? esc(M.lobes[li].label) : n.type === 'core' ? 'the centre' : 'the inner ring'}</dd>`;
    if (n.unresolvedLinks) h += `<dt>Broken</dt><dd style="color:var(--amber)">${fmtN(n.unresolvedLinks)} wikilink${n.unresolvedLinks > 1 ? 's' : ''} to missing notes</dd>`;
    h += '</dl>';
    const groups = {}, order = ['core', 'moc', 'user', 'feedback', 'project', 'reference', 'domain', 'skill', 'note'];
    M.adj[i].forEach((k) => { const l = M.links[k], j = l[0] === i ? l[1] : l[0], dir = l[3]; const rel = dir === 3 ? 'both' : (l[0] === i ? (dir === 1 ? 'out' : 'in') : (dir === 2 ? 'out' : 'in')); const t = M.nodes[j].type; (groups[t] = groups[t] || []).push({ j, rel }); });
    h += `<div class="sec"><span>Links</span><span>${fmtN(n.deg)} · → links to · ← links here</span></div>`;
    order.forEach((t) => {
      const g = groups[t]; if (!g) return;
      g.sort((a, b) => M.nodes[b.j].deg - M.nodes[a.j].deg);
      h += `<div class="lgroup"><div class="lgh"><span class="dot" style="color:${M.colorOf(t)}"></span>${esc(TYPE_NAME[t] || t)} <b>${g.length}</b></div>`;
      h += g.slice(0, 40).map((e) => `<div class="lk" data-i="${e.j}" title="${esc(M.nodes[e.j].desc || '')}"><span class="ar">${e.rel === 'both' ? '↔' : e.rel === 'out' ? '→' : '←'}</span><span class="lt"${G.present[e.j] ? '' : ' style="opacity:.45"'}>${esc(M.nodes[e.j].label)}</span><span class="ld">${M.nodes[e.j].deg}</span></div>`).join('');
      if (g.length > 40) h += `<div class="more">and ${g.length - 40} more</div>`;
      h += '</div>';
    });
    cardIn.innerHTML = h; cardIn.scrollTop = 0;
    card.classList.add('on');
    $('unpin').onclick = () => pin(-1);
    cardIn.querySelectorAll('.lk').forEach((el) => {
      const j = +el.dataset.i;
      el.onclick = () => goTo(j);
      el.onmouseenter = () => { preview = j; targetsDirty = true; };
      el.onmouseleave = () => { preview = -1; targetsDirty = true; };
    });
  }

  // ---------- Ask ----------
  const qEl = $('q'), resEl = $('results'), qcount = $('qcount');
  const STOP = { what: 1, do: 1, i: 1, know: 1, about: 1, the: 1, a: 1, an: 1, of: 1, and: 1, to: 1, in: 1, on: 1, my: 1, me: 1, is: 1, for: 1, with: 1, tell: 1, any: 1, all: 1, notes: 1, note: 1, have: 1, we: 1 };
  function tokenize(q) {
    q = q.toLowerCase().trim().replace(/^(what do i know about|what do we know about|what about|tell me about|show me|about)\s+/, '').replace(/[?!.,]+$/g, '');
    return { phrase: q, toks: q.split(/[\s,]+/).filter((t) => t.length >= 2 && !STOP[t]) };
  }
  function wordStart(hay, t) { let k = hay.indexOf(t); while (k >= 0) { if (k === 0 || /[^a-z0-9]/.test(hay[k - 1])) return true; k = hay.indexOf(t, k + 1); } return false; }
  function search(raw) {
    const tk = tokenize(raw); if (!tk.toks.length) return { results: [], partial: false };
    const scoreAll = (needAll) => {
      const out = [];
      for (let i = 0; i < M.NN; i++) {
        const X = M.TXT[i]; let s = 0, hit = 0; const why = {};
        for (const t of tk.toks) {
          let st = 0;
          if (wordStart(X.label, t)) { st += 10; why.title = 1; } else if (X.label.includes(t)) { st += 6; why.title = 1; } else if (X.id.includes(t)) { st += 4; why.title = 1; }
          if (X.desc.includes(t)) { st += wordStart(X.desc, t) ? 4 : 2.5; why.description = 1; }
          if (X.topic.includes(t)) { st += 2.5; why.topic = 1; }
          if (X.comm.includes(t)) { st += 2; why.cluster = 1; }
          if (st > 0) hit++; s += st;
        }
        if (!hit || (needAll && hit < tk.toks.length)) continue;
        if (tk.phrase.length > 2 && X.label.includes(tk.phrase)) s += 12;
        s += Math.log(1 + M.nodes[i].deg) * 0.6 + (hit / tk.toks.length) * 4;
        out.push({ i, score: s, why: Object.keys(why) });
      }
      return out.sort((a, b) => b.score - a.score || M.nodes[b.i].deg - M.nodes[a.i].deg);
    };
    let r = scoreAll(true), partial = false;
    if (!r.length && tk.toks.length > 1) { r = scoreAll(false); partial = r.length > 0; }
    return { results: r, partial };
  }
  let askPartial = false, lastAskQ = '';
  function runAsk(q) {
    lastAskQ = q; // the query that produced askRes (Enter re-runs only when the box has changed since)
    const r = q.trim() ? search(q) : { results: [], partial: false };
    askRes = r.results; askPartial = r.partial; askSel = askRes.length ? 0 : -1;
    matches = q.trim() && askRes.length ? new Set(askRes.slice(0, 40).map((x) => x.i)) : null;
    preview = -1; targetsDirty = true; lastInput = now;
    qcount.innerHTML = q.trim() ? `<b>${fmtN(askRes.length)}</b> match${askRes.length === 1 ? '' : 'es'}` : '';
    renderResults();
  }
  function renderResults() {
    if (!qEl.value.trim()) { resEl.classList.remove('on'); resEl.innerHTML = ''; return; }
    if (!askRes.length) { resEl.innerHTML = `<div class="empty">Nothing in the brain matches <b>${esc(qEl.value.trim())}</b>. Try fewer words.</div>`; resEl.classList.add('on'); return; }
    const shown = askRes.slice(0, 60);
    resEl.innerHTML = `<div class="hdr"><span>${askPartial ? 'No note matches every word; showing notes that match some' : 'Best first · title, description, topic and cluster keywords'}</span><span>${fmtN(askRes.length)} · Enter opens</span></div>` +
      shown.map((r, k) => { const n = M.nodes[r.i], li = M.nodeLobe[r.i]; return `<div class="res${k === askSel ? ' on' : ''}" data-k="${k}"><span class="rk">${k + 1}</span><span class="dot" style="color:${M.colorOf(n.type)}"></span><span class="t">${esc(n.label)}<em>${esc(r.why.join(' · '))}</em></span><span class="m">${esc(whereText(r.i))}</span></div>`; }).join('');
    resEl.classList.add('on');
    resEl.querySelectorAll('.res').forEach((el) => {
      const k = +el.dataset.k;
      el.onmousedown = (e) => { e.preventDefault(); openResult(k); };
      el.onmouseenter = () => { preview = askRes[k].i; targetsDirty = true; };
      el.onmouseleave = () => { preview = -1; targetsDirty = true; };
    });
    const on = resEl.querySelector('.res.on'); if (on) on.scrollIntoView({ block: 'nearest' });
  }
  function openResult(k) {
    if (k < 0 || k >= askRes.length) return;
    askSel = k; preview = -1;
    resEl.classList.remove('on'); qEl.blur();
    goTo(askRes[k].i);
  }
  let qTimer = null;
  qEl.addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(() => runAsk(qEl.value), 110); });
  qEl.addEventListener('focus', () => { if (qEl.value.trim()) resEl.classList.add('on'); });
  qEl.addEventListener('blur', () => { setTimeout(() => { if (document.activeElement !== qEl) resEl.classList.remove('on'); }, 150); });
  qEl.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); if (!askRes.length) return;
      askSel = clamp(askSel + (e.key === 'ArrowDown' ? 1 : -1), 0, Math.min(59, askRes.length - 1));
      preview = askRes[askSel].i; targetsDirty = true; renderResults();
    } else if (e.key === 'Enter') {
      // a search still waiting on its debounce runs now (and starts at #1); otherwise open the highlighted row as it stands
      clearTimeout(qTimer); if (qEl.value !== lastAskQ) runAsk(qEl.value);
      openResult(Math.max(0, askSel));
    }
  });

  // ---------- timeline strip ----------
  const tl = $('tl'), tctx = tl.getContext('2d');
  let weeks = [], tEndAxis = 0, maxWeek = 1, home = null, homeFrom = 0, homeTo = 0, TW = 0, TH = 0, tlHover = null, tlDirty = true;
  const TLM = { l: 44, r: 14, t: 24, b: 20 };
  const tx = (ms) => TLM.l + (ms - tStart) / (tEndAxis - tStart) * (TW - TLM.l - TLM.r);
  const txInv = (x) => tStart + (x - TLM.l) / (TW - TLM.l - TLM.r) * (tEndAxis - tStart);
  function setupTimeline() {
    const h = M.data.health || {};
    const cpw = h.createdPerWeek || {};
    weeks = Object.keys(cpw).sort();
    genMs = Date.parse(M.data.generatedAt) || Date.now();
    tStart = weeks.length ? Date.parse(weeks[0] + 'T00:00:00Z') : genMs - 30 * DAY;
    tEndAxis = Math.max(weeks.length ? Date.parse(weeks[weeks.length - 1] + 'T00:00:00Z') + 7 * DAY : genMs, genMs);
    maxWeek = Math.max(1, ...weeks.map((w) => cpw[w].total || 0));
    home = h.homeFolderPeriod || null;
    homeFrom = home ? Date.parse(home.from + 'T00:00:00Z') : 0; homeTo = home ? Date.parse(home.to + 'T00:00:00Z') + DAY : 0;
    tlDirty = true;
  }
  function drawTL() {
    // the strip is hidden (mini): the canvas has no size, so draw once it is shown again (resize() re-sizes it and marks it dirty)
    if (TW <= TLM.l + TLM.r + 2 || TH <= TLM.t + TLM.b + 2) return;
    tlDirty = false;
    const g = tctx; g.setTransform(DPR, 0, 0, DPR, 0, 0); g.clearRect(0, 0, TW, TH);
    const top = TLM.t, bot = TH - TLM.b, hgt = bot - top, P = M.P, cpw = (M.data.health || {}).createdPerWeek || {};
    const mono = "11px 'Cascadia Code', Consolas, monospace";
    if (home) {
      const x0 = tx(homeFrom), x1 = tx(homeTo);
      g.fillStyle = rgba('#d24bff', 0.1); g.fillRect(x0, top - 4, x1 - x0, hgt + 4);
      g.strokeStyle = rgba('#d24bff', 0.6); g.setLineDash([3, 3]); g.strokeRect(x0 + 0.5, top - 3.5, x1 - x0 - 1, hgt + 3); g.setLineDash([]);
      g.fillStyle = '#f0b8ff'; g.font = mono; g.textAlign = 'right'; g.textBaseline = 'alphabetic';
      g.fillText('home-folder stretch ' + fmtDs(homeFrom) + ' – ' + fmtDs(homeTo - DAY), x1 - 4, top - 8);
    }
    g.strokeStyle = 'rgba(167,139,250,.12)'; g.lineWidth = 1;
    [0.5, 1].forEach((f) => { const y = bot - hgt * f; g.beginPath(); g.moveTo(TLM.l, y + 0.5); g.lineTo(TW - TLM.r, y + 0.5); g.stroke(); });
    g.fillStyle = P.ink2 || '#8b7fb4'; g.font = mono; g.textAlign = 'right'; g.textBaseline = 'middle';
    g.fillText(String(maxWeek), TLM.l - 6, top); g.fillText(String(Math.round(maxWeek / 2)), TLM.l - 6, bot - hgt / 2); g.fillText('0', TLM.l - 6, bot);
    g.textAlign = 'left'; g.textBaseline = 'alphabetic';
    g.fillText('notes made per week, stacked by type', TLM.l, top - 8);
    const wpx = (7 * DAY) / (tEndAxis - tStart) * (TW - TLM.l - TLM.r);
    weeks.forEach((wk) => {
      const ms = Date.parse(wk + 'T00:00:00Z'), x = tx(ms) + 1, w = Math.max(2, wpx - 2), past = ms <= T, partial = past && ms + 7 * DAY > T;
      let y = bot;
      NOTE_TYPES.forEach((t) => { const v = cpw[wk][t] || 0; if (!v) return; const hh = v / maxWeek * hgt; g.globalAlpha = past ? (tlHover === wk ? 1 : 0.88) : 0.22; g.fillStyle = M.colorOf(t); g.fillRect(x, y - hh, w, hh); y -= hh; });
      g.globalAlpha = 1;
      if (partial) { g.strokeStyle = 'rgba(255,255,255,.5)'; g.strokeRect(x - 0.5, y - 0.5, w + 1, bot - y + 1); }
    });
    g.fillStyle = P.ink2 || '#8b7fb4'; g.textAlign = 'left'; g.font = mono;
    for (let d = new Date(Date.UTC(new Date(tStart).getUTCFullYear(), new Date(tStart).getUTCMonth() + 1, 1)); d.getTime() < tEndAxis; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
      const x = tx(d.getTime()); g.strokeStyle = 'rgba(167,139,250,.3)'; g.beginPath(); g.moveTo(x + 0.5, bot); g.lineTo(x + 0.5, bot + 5); g.stroke();
      if (tx(genMs) - x > 64) g.fillText(MON[d.getUTCMonth()], x + 4, TH - 5);
    }
    const sx = tx(T);
    g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(sx, top - 6); g.lineTo(sx, bot + 2); g.stroke();
    g.shadowColor = '#bfa6ff'; g.shadowBlur = 12; g.fillStyle = '#fff'; g.beginPath(); g.arc(sx, bot + 2, 5, 0, TAU); g.fill(); g.shadowBlur = 0;
    g.fillStyle = P.ink2 || '#8b7fb4'; g.textAlign = 'right'; g.fillText('today', Math.min(TW - 2, tx(genMs) + 18), TH - 5);
  }
  let lastTdate = '';
  function updateTimeText() {
    const s = fmtD(T); if (s === lastTdate) return; lastTdate = s;
    $('tdate').textContent = s;
    const d = new Date(T), day = (d.getUTCDay() + 6) % 7, mk = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day)).toISOString().slice(0, 10);
    const wv = ((M.data.health || {}).createdPerWeek || {})[mk];
    $('tsub').textContent = (T >= genMs - 1000 ? 'today · ' : '') + 'week of ' + fmtDs(Date.parse(mk + 'T00:00:00Z')) + ': ' + (wv ? wv.total : 0) + ' notes made';
  }
  function setT(ms, born) { const v = clamp(ms, tStart, genMs); if (v === T) return; T = v; recomputePresence(!!born); tlDirty = true; updateTimeText(); if (pinned >= 0 && !born) renderCard(); }
  const playBtn = $('play');
  function setPlayIcon() {
    playBtn.innerHTML = playing ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="#fff"><rect x="5" y="4" width="5" height="16" rx="1"/><rect x="14" y="4" width="5" height="16" rx="1"/></svg>' : '<svg width="20" height="20" viewBox="0 0 24 24" fill="#fff"><path d="M7 4l13 8-13 8z"/></svg>';
    playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }
  function togglePlay() { if (!playing && T >= genMs - DAY) setT(tStart); playing = !playing; setPlayIcon(); }
  playBtn.onclick = togglePlay;
  const stepW = (w) => { playing = false; setPlayIcon(); setT(T + w * 7 * DAY); };
  $('bStart').onclick = () => { playing = false; setPlayIcon(); setT(tStart); };
  $('bBack').onclick = () => stepW(-1); $('bFwd').onclick = () => stepW(1);
  $('bToday').onclick = () => { playing = false; setPlayIcon(); setT(genMs); };
  let tlDrag = false;
  tl.addEventListener('mousedown', (e) => { tlDrag = true; playing = false; setPlayIcon(); setT(txInv(e.clientX - tl.getBoundingClientRect().left)); });
  window.addEventListener('mouseup', () => { tlDrag = false; });
  window.addEventListener('mousemove', (e) => {
    if (!M) return;
    const r = tl.getBoundingClientRect(), x = e.clientX - r.left;
    if (tlDrag) setT(txInv(x));
    if (e.target === tl) {
      const ms = txInv(x), wk = weeks.find((w) => { const s = Date.parse(w + 'T00:00:00Z'); return ms >= s && ms < s + 7 * DAY; }) || null;
      if (wk !== tlHover) { tlHover = wk; tlDirty = true; }
      if (wk) {
        const v = M.data.health.createdPerWeek[wk];
        tip.innerHTML = `<div class="t">Week of ${fmtDU(Date.parse(wk + 'T00:00:00Z'))}: ${v.total} notes</div><div class="d">${NOTE_TYPES.filter((t) => v[t]).map((t) => v[t] + ' ' + t).join(' · ')}</div>`;
        tip.style.display = 'block'; const tw = tip.offsetWidth, th = tip.offsetHeight;
        tip.style.left = Math.min(W - tw - 10, e.clientX + 14) + 'px'; tip.style.top = (e.clientY - th - 14) + 'px';
      } else tip.style.display = 'none';
    } else if (tlHover) { tlHover = null; tlDirty = true; if (hover < 0 && hoverLobe < 0) hideTip(); }
  });

  // ---------- header ----------
  function buildHeader() {
    const h = M.data.health || {}, bt = h.byType || {};
    const order = ['feedback', 'project', 'reference', 'user', 'skill', 'domain', 'moc'];
    $('legend').innerHTML = order.filter((t) => bt[t]).map((t) => `<span><i class="dot" style="color:${M.colorOf(t)}"></i>${esc(TYPE_NAME[t])}</span>`).join('') + `<span><i class="dot core" style="color:#fff"></i>Memory index</span>`;
  }
  function updateCounts() {
    const today = T >= genMs - 1000;
    $('counts').innerHTML = `<span class="chip"><em>${fmtN(presentCount)}</em>${today ? '' : ' of ' + fmtN(M.NN)} nodes</span><span class="chip"><em>${fmtN(presentLinks)}</em> links</span><span class="chip">${today ? 'as of' : 'as of'} <em>${fmtD(T)}</em></span>`;
  }

  // ---------- live ticker ----------
  const tlist = $('tlist'), ticker = $('ticker'), liveEl = $('live');
  const events = [];
  let liveState = 'demo';
  function setLive(s) {
    liveState = s;
    liveEl.className = 'live ' + (s === 'live' ? 'on' : s === 'offline' ? 'off' : 'demo'); liveEl.querySelector('span').textContent = s;
    ticker.className = 'glass ' + (s === 'live' ? 'on' : s === 'offline' ? 'off' : 'demo');
    $('tstate').textContent = s;
    $('tnote').textContent = s === 'live' ? 'sessions firing the brain in real time' : s === 'offline' ? 'live feed not answering, retrying · ambient activity' : 'ambient activity only · window.__brain.fire() drives it';
  }
  function tickerAdd(ev, act, hit, src) {
    let name;
    const memFile = !hit.length && ev.path ? String(ev.path).replace(/\\/g, '/').match(/\/memory\/([^/]+)\.md$/i) : null;
    if (hit.length) name = hit.slice(0, 2).map((i) => M.nodes[i].label).join(', ') + (hit.length > 2 ? ` +${hit.length - 2}` : '');
    // a note written this moment is not in the snapshot yet: it is a new note, not something outside the brain
    else if (memFile) { const s = memFile[1].replace(/^(feedback|project|reference|user)[_-]/i, '').replace(/[_-]+/g, ' ').trim(); name = 'new note: ' + s.charAt(0).toUpperCase() + s.slice(1) + (SERVED ? ' (loading)' : ''); }
    else name = (ev.tool ? ev.tool + ' · ' : '') + 'outside the brain';
    const who = ev.session ? 'session ' + String(ev.session).slice(0, 8) + (ev.agent ? ' · agent' : '') : src === 'console' ? 'console' : 'injected';
    events.unshift({ act, name, who, t: Date.now() });
    events.length = Math.min(events.length, 5);
    renderTicker();
  }
  function ago(t) { const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 60 ? s + ' s ago' : Math.round(s / 60) + ' min ago'; }
  function renderTicker() {
    tlist.innerHTML = events.length ? events.map((e, k) => `<div class="ev${k === 0 && Date.now() - e.t < 4000 ? ' fresh' : ''}"><span class="k" style="color:${ACT_TXT[e.act] || '#c3b6e8'}">${esc(e.act)}</span><span class="n">${esc(e.name)}</span><span class="s">${esc(e.who)} · ${ago(e.t)}</span></div>`).join('') : '<div class="empty">no session events yet</div>';
    measureTicker();
  }
  setInterval(() => { if (events.length) renderTicker(); }, 1000);
  function connectLive() {
    if (!SERVED || !window.EventSource) { setLive('demo'); return; }
    let es;
    try { es = new EventSource('/api/neurons'); } catch (e) { setLive('offline'); return; }
    setLive('offline');
    es.onopen = () => setLive('live');
    es.onerror = () => { if (es.readyState !== 1) setLive('offline'); };
    es.onmessage = (m) => {
      let ev; try { ev = JSON.parse(m.data); } catch (e) { return; }
      if (!ev) return;
      if (ev.kind === 'hello') { setLive('live'); return; }
      if (ev.kind === 'neuron') { setLive('live'); handleNeuron(ev, 'live'); }
    };
  }

  // ---------- data loading & refresh ----------
  function fetchT(url, ms) { const c = new AbortController(); const t = setTimeout(() => c.abort(), ms); return fetch(url, { signal: c.signal, cache: 'no-store' }).finally(() => clearTimeout(t)); }
  async function loadData(fresh) {
    if (SERVED) {
      try { const r = await fetchT('./brain-data.json' + (fresh ? '?fresh=1' : ''), 30000); if (r.ok) return await r.json(); } catch (e) { /* fall through */ }
      try { const r = await fetchT('./brain-data.json', 10000); if (r.ok) return await r.json(); } catch (e) { /* fall through */ }
    }
    return new Promise((res) => {
      if (window.BRAIN_DATA) return res(window.BRAIN_DATA);
      const s = document.createElement('script'); s.src = './brain-data.js';
      s.onload = () => res(window.BRAIN_DATA || null); s.onerror = () => res(null);
      document.head.appendChild(s);
    });
  }
  let lastRefresh = 0, refreshing = false;
  function requestRefresh(force) {
    if (!SERVED || refreshing) return;
    const t = Date.now(); if (!force && t - lastRefresh < 20000) return;
    lastRefresh = t; refreshing = true;
    loadData(true).then((d) => {
      refreshing = false;
      if (d && d.nodes && (!D || d.generatedAt !== D.generatedAt || d.nodes.length !== D.nodes.length || d.links.length !== D.links.length)) applyData(d, true);
      // notes named by live events while we fetched
      pendingIds.forEach((act, id) => { const i = M.byId.get(id); if (i != null) enqueue({ i, act }); });
      pendingIds = new Map();
    }).catch(() => { refreshing = false; });
  }
  function applyData(data, isRefresh) {
    dbg("applyData start");
    const prev = M;
    const prevAng = new Map(), prevIds = new Set();
    if (prev) prev.nodes.forEach((n) => { prevAng.set(n.id, prev.ang[n.i]); prevIds.add(n.id); });
    const focusKey = prev && focus >= 0 ? prev.lobes[focus].key : null, pinId = prev && pinned >= 0 ? prev.nodes[pinned].id : null;
    const pendId = prev && pendingPin >= 0 ? prev.nodes[pendingPin].id : null;
    const wasToday = !prev || T >= genMs - 1000;
    D = data; M = buildModel(data, prev);
    buildGPU(); dbg("gpu built");
    focus = focusKey ? M.lobes.findIndex((l) => l.key === focusKey) : -1;
    pinned = pinId && M.byId.has(pinId) ? M.byId.get(pinId) : -1;
    pendingPin = pendId && M.byId.has(pendId) ? M.byId.get(pendId) : -1;
    hover = -1; hoverLobe = -1; preview = -1;
    targetLayout(focus);
    M.nodes.forEach((n) => { M.ang[n.i] = prevAng.has(n.id) ? prevAng.get(n.id) : M.tAng[n.i]; });
    layoutMoving = !!prev;
    lobeMid = new Float64Array(M.NL); lobeA0 = new Float64Array(M.NL); lobeA1 = new Float64Array(M.NL); groupMid = M.lobes.map((lb) => new Float64Array(lb.groups.length));
    computeGeometry(); computePeripheral(); dbg("geometry");
    setupTimeline();
    T = wasToday ? genMs : clamp(T, tStart, genMs);
    G.present.fill(0); G.fp.fill(0);
    recomputePresence(false);
    G.fAlpha.fill(0);
    buildLabels(); updateLobeCounts(); buildHeader(); updateCounts(); updateTimeText(); lastTdate = ''; updateTimeText();
    showLayoutNote();
    if (qEl.value.trim()) runAsk(qEl.value);
    renderCard();
    if (isRefresh && prev) {
      // notes that did not exist before are born on the rim with a spark and their fibres draw in
      let born = 0;
      M.nodes.forEach((n) => {
        if (prevIds.has(n.id) || !G.present[n.i]) return;
        born++;
        setTimeout(() => { flash(n.i, 2, 1.8); ripple(n.i, 2, 1.1); M.adj[n.i].forEach((k) => { G.stateArr[k * 4 + 2] = now; }); G.stateDirty = true; }, 400 + born * 120);
      });
    }
    targetsDirty = true; dbg("pre-resize");
    resize(); dbg("resized");
    // embedded: the dashboard's chip shows these counts (first load and every refresh)
    post({ type: 'brain:stats', nodes: M.NN, links: M.NLK });
  }

  // the lobes are the sitemap's sections; when the data had no usable sitemap they are link clusters, and the page says so
  function showLayoutNote() {
    let el = $('layoutNote');
    const msg = M.SEC ? '' : (M.data.layoutNote || (M.data.layout ? 'No sitemap: the lobes are link clusters, not your sections.' : ''));
    if (!msg) { if (el) el.style.display = 'none'; return; }
    if (!el) { el = document.createElement('div'); el.id = 'layoutNote'; el.className = 'glass'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
    el.textContent = msg; el.style.display = '';
  }

  // ---------- resize ----------
  // the camera looks at the ring's centre and draws it in the middle of FREE; mini adds viewDY (px, set by overviewGoal) so the
  // ring as drawn, not its centre point, sits in the middle of the window. Always 0 outside mini.
  let viewDY = 0;
  function setView() {
    const cx = (FREE.x0 + FREE.x1) / 2, cy = (FREE.y0 + FREE.y1) / 2 + viewDY;
    [camera, tmpCam].forEach((c) => { c.aspect = W / H; c.setViewOffset(W, H, -(cx - W / 2), -(cy - H / 2), W, H); c.updateProjectionMatrix(); });
  }
  function resize() {
    // embedded and hidden (display:none while the dashboard shows another layout): nothing to fit; keep the last size
    if (EMBED && (window.innerWidth < 2 || window.innerHeight < 2)) return;
    W = window.innerWidth; H = window.innerHeight; DPR = Math.min(2, window.devicePixelRatio || 1);
    GPR = DPR * RSCALE;
    renderer.setPixelRatio(GPR); renderer.setSize(W, H, false);
    const dw = Math.round(W * GPR), dh = Math.round(H * GPR);
    sizeRTs(dw, dh);
    lead.width = Math.round(W * DPR); lead.height = Math.round(H * DPR);
    if (MINI) {
      // mini: no header, Ask bar, card, ticker or strip; the ring and its labels get the whole window (a label clamped to
      // the top sits 6px above FREE.y0, so y0 = 8 keeps it inside the frame)
      FREE.x0 = 6; FREE.x1 = W - 6; FREE.y0 = 8; FREE.y1 = H - 6;
      CHROME.bar = null; CHROME.card = null; CHROME.ticker = null;
      // the soft edge: about 5% of the window's short side. At rest the ring and its leader lines sit further in than this
      FE = Math.round(clamp(Math.min(W, H) * 0.05, 16, 36));
      document.documentElement.style.setProperty('--fe', FE + 'px');
    } else {
      const top = $('askWrap').getBoundingClientRect(), strip = $('strip').getBoundingClientRect();
      const bar = $('askWrap').querySelector('.bar').getBoundingClientRect(), head = $('top').getBoundingClientRect();
      FREE.x0 = 16; FREE.x1 = W - 16; FREE.y0 = Math.max(top.top + 56, bar.bottom + 8); FREE.y1 = strip.top - 8;
      // the pinned card starts below the Ask bar whenever the bar reaches over the card's column
      const cardW = cardWidth(), cardX0 = W - 16 - cardW;
      const cardTop = bar.right > cardX0 - 10 ? bar.bottom + 10 : head.bottom + 12;
      document.documentElement.style.setProperty('--cardTop', cardTop.toFixed(0) + 'px');
      CHROME.bar = { x0: bar.left, y0: bar.top, x1: bar.right, y1: bar.bottom };
      CHROME.card = { x0: cardX0, y0: cardTop, x1: W - 16, y1: strip.top - 12 };
      measureTicker();
    }
    if (!MINI) viewDY = 0;
    setView();

    UPX = (H * GPR) / (2 * Math.tan(FOV * Math.PI / 360));
    if (G) [G.nmat, G.smat, G.rmat, G.mmat].forEach((m) => { m.uniforms.uPx.value = UPX; });
    TW = tl.clientWidth; TH = tl.clientHeight; tl.width = Math.round(TW * DPR); tl.height = Math.round(TH * DPR); tlDirty = true;
    if (M) { goal = focus >= 0 ? focusGoal(focus, pinned >= 0) : overviewGoal(); if (!started) { Object.assign(cam, goal, { dist: goal.dist * 1.25, el: goal.el + 0.12 }); } }
    lobeEls.forEach((L) => { L.w = 0; });
  }
  window.addEventListener('resize', () => { clearTimeout(window.__rz); window.__rz = setTimeout(resize, 120); });

  // ---------- frame loop ----------
  let frameN = 0, started = false, last = performance.now(), fpsAcc = 0, fpsN = 0, fps = 0, frames = 0; // frames: rendered so far
  function frame(tnow) {
    // paused (embedded, not on screen) or frozen (?freeze=N): this frame is the last until setPaused(false) or __brain.run()
    // software rasteriser: leave the main thread idle between frames so it stays responsive
    if (paused || now > freezeAt) { frozen = true; } else if (SOFT) setTimeout(() => requestAnimationFrame(frame), SOFT_GAP); else requestAnimationFrame(frame);
    const dt = Math.min(SOFT ? 0.3 : 0.1, (tnow - last) / 1000); last = tnow;
    now = (tnow - t0) / 1000;
    fpsAcc += dt; fpsN++; if (fpsAcc > 1) { fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; }
    if (!M) return;
    if (playing) { const nt = T + dt / 0.7 * 7 * DAY; if (nt >= genMs) { setT(genMs, true); playing = false; setPlayIcon(); } else setT(nt, true); }
    stepCamera(dt);
    if (layoutMoving) {
      const k = 1 - Math.exp(-dt * 5.5); let mv = 0;
      for (let i = 0; i < M.NN; i++) { const d = wrapPi(M.tAng[i] - M.ang[i]); if (Math.abs(d) > 1e-4) { M.ang[i] += d * k; mv++; } else M.ang[i] = M.tAng[i]; }
      computeGeometry();
      if (!mv) layoutMoving = false;
    }
    if (targetsDirty) computeTargets();
    stepAlphas(dt);
    ambient(dt); stepFires(); processArrivals(); stepSparks();
    // marks
    for (let j = 0; j < G.MKN; j++) {
      const mk = G.marks[j];
      if (mk) { const i = mk[0]; G.mpos.set([G.npos[i * 3], G.npos[i * 3 + 1], G.npos[i * 3 + 2]], j * 3); G.mcol.set(hexRgb(mk[1]), j * 3); G.msz[j] = G.nsize[i] * 0.42 * mk[2] + 1.6; } else G.msz[j] = 0;
    }
    ['position', 'aCol', 'aSize'].forEach((a) => { G.mgeo.attributes[a].needsUpdate = true; });
    [G.fmat, G.nmat, G.rmat, G.mmat].forEach((m) => { m.uniforms.uTime.value = now; });
    renderFrame(); frames++;
    // project nodes once per frame (hover + labels)
    for (let i = 0; i < M.NN; i++) { projInto(VP, G.npos[i * 3], G.npos[i * 3 + 1], G.npos[i * 3 + 2], tmpV); G.scr[i * 3] = tmpV[0]; G.scr[i * 3 + 1] = tmpV[1]; G.scr[i * 3 + 2] = tmpV[2]; }
    updateHover();
    drawLabels();
    if (tlDirty) drawTL();
    if (!started) { started = true; $('loading').style.display = 'none'; }
    if (DBG && (frameN++ % 10 === 0)) dbg("frame", frameN, (performance.now() - tnow).toFixed(0) + "ms");
  }

  // ---------- embedded in the OS dashboard (?embed=1) ----------
  // The dashboard shows this page in one iframe: over its Calm window ("mini": ring and labels only, transparent) and as its
  // fullscreen brain ("full": the whole UI plus a Collapse button). It sends brain:mode {mode}, brain:pause, brain:resume;
  // the page sends brain:stats {nodes, links}, brain:expand {pin} (a note clicked in mini) and brain:collapse.
  function post(m) { if (!EMBED) return; try { window.parent.postMessage(m, location.origin); } catch (e) { /* no parent to tell */ } }
  function setMini(on) {
    on = !!on;
    if (!EMBED || on === MINI) return;
    MINI = on;
    document.documentElement.classList.toggle('mini', on);
    if (on) {
      // back to the small view: no question, today, nothing pinned or in front, no tooltip; resize() refits the camera
      clearTimeout(qTimer); qEl.value = ''; runAsk(''); qEl.blur();
      playing = false; setPlayIcon();
      if (M) { setT(genMs); pin(-1); setFocus(-1); }
      hover = -1; hoverLobe = -1; preview = -1; lobeLabelHover = -1; canvas.classList.remove('point'); hideTip();
      resize();
    } else {
      resize(); // also gives the timeline canvas its size back
      // the note clicked in mini opens pinned, the same way __brain.pin does
      if (M && pendingPin >= 0) goTo(pendingPin);
      pendingPin = -1;
      // keys (Esc, /, Space, arrows) reach this page rather than the dashboard behind it
      try { window.focus(); } catch (e) { /* focus stays with the dashboard */ }
    }
  }
  function setPaused(p) {
    p = !!p;
    if (p === paused) return;
    paused = p;
    // fires queued or travelling when the page leaves the screen are dropped, not saved up for the resume
    if (p) { fireQ.length = 0; arrivals.length = 0; }
    else if (frozen && now <= freezeAt) { frozen = false; last = performance.now(); requestAnimationFrame(frame); }
  }
  if (EMBED) {
    window.addEventListener('message', (e) => {
      // only the page that embeds us, from our own origin, drives the mode
      if (e.origin !== location.origin || e.source !== window.parent) return;
      const d = e.data; if (!d || typeof d !== 'object') return;
      if (d.type === 'brain:mode') setMini(d.mode !== 'full');
      else if (d.type === 'brain:pause') setPaused(true);
      else if (d.type === 'brain:resume') setPaused(false);
    });
    // the way back to the dashboard from the full view (Esc does the same once there is nothing left to clear)
    const b = document.createElement('button');
    b.type = 'button'; b.id = 'collapse'; b.className = 'collapse'; b.title = 'Back to the dashboard (Esc)';
    // a down-left arrow (back into the small window), drawn so its head stays clear at 12px
    b.innerHTML = '<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 2L2.5 9.5M2.5 4.2v5.3h5.3"/></svg>Collapse';
    b.addEventListener('click', () => post({ type: 'brain:collapse' }));
    $('top').appendChild(b);
  }

  // ---------- boot ----------
  setPlayIcon();
  loadData(SERVED).then((data) => {
    if (!data || !data.nodes) { fatal(SERVED ? 'Could not load brain-data.json from the server or brain-data.js from disk.' : 'brain-data.js did not load (expected ./brain-data.js next to this page).'); return; }
    dbg("data loaded"); applyData(data, false); dbg("applied");
    connectLive();
    if (SERVED) setInterval(() => requestRefresh(true), 5 * 60 * 1000);
    renderTicker();
    requestAnimationFrame(frame);
  });

  // ---------- console / headless hooks ----------
  window.__brain = {
    fire: (ev) => { handleNeuron(Object.assign({ act: 'read' }, ev || {}), 'console'); return true; },
    focusLobe: (i) => { setFocus(i); return M.lobes[i] && M.lobes[i].label; },
    pin: (id) => { const i = typeof id === 'number' ? id : M.byId.get(id); if (i == null) return null; goTo(i); return M.nodes[i].label; },
    ask: (q) => { qEl.value = q; runAsk(q); qEl.focus(); resEl.classList.add('on'); return askRes.length; },
    setDate: (d) => { playing = false; setPlayIcon(); setT(typeof d === 'number' ? d : Date.parse(d + 'T12:00:00Z')); return { date: fmtD(T), nodes: presentCount, links: presentLinks }; },
    play: () => { if (!playing) togglePlay(); return true; },
    lobes: () => M.lobes.map((l, i) => ({ i, key: l.key, label: l.label, n: l.members.length, color: l.color || null, groups: l.groups.map((g) => g.topic || g.key) })),
    layout: () => ({ sections: M.SEC, note: M.data.layoutNote || null, lobes: M.NL, inner: M.inner.map((n) => n.id), pairs: M.pairN.size }),
    lobeOf: () => M.nodes.map((n) => [n.id, M.nodeLobe[n.i] >= 0 ? M.lobes[M.nodeLobe[n.i]].key : null]),
    state: () => ({ hover, hoverLobe, pinned, focus, T: fmtD(T), playing, live: liveState, fps: Math.round(fps), sparks: G.sparks.length, queue: fireQ.length, cam: Object.assign({}, cam), frames, mini: MINI, paused, pendingPin }),
    stats: () => ({ nodes: M.NN, links: M.NLK, lobes: M.NL, fibres: M.NF, presentNodes: presentCount, presentLinks, halfFloat: HALF, webgl2: GL2 }),
    reset: () => resetView(),
    run: (sec) => { freezeAt = now + (sec || 5); if (frozen) { frozen = false; last = performance.now(); requestAnimationFrame(frame); } return true; },
    camera: (c) => { goal = null; Object.assign(cam, c); return Object.assign({}, cam); },
    // headless checks: where a node is on screen right now, and the members of a lobe (most linked first)
    at: (id) => { const i = typeof id === 'number' ? id : M.byId.get(id); if (i == null) return null; return { i, id: M.nodes[i].id, label: M.nodes[i].label, x: Math.round(G.scr[i * 3]), y: Math.round(G.scr[i * 3 + 1]), w: G.scr[i * 3 + 2] }; },
    members: (li) => M.lobes[li].members.slice().sort((a, b) => b.deg - a.deg).map((n) => n.id),
  };
})();
