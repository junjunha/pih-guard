/* PIH Guard v5 prototype
   One patient app. Set up before the procedure, the clinic sends treatment data,
   then a nightly photo + life check gives an AI read of where the course stands.
   "AI" here = photo analysis + similar-patient comparison + rules. No external model. */
'use strict';
const KEY = 'pihguard.v5';
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const DAY = 864e5;
const today0 = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const iso = d => new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
const addDays = (s, n) => iso(new Date(new Date(s + 'T00:00').getTime() + n * DAY));
const fmt = s => new Date(s + 'T00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const r1 = x => (x == null || isNaN(x)) ? '-' : (Math.round(x * 10) / 10).toString();

/* ---------- state ---------- */
const blank = () => ({ step: 'welcome', consent: false, profile: {}, habits: {}, baseline: null, clinic: null, checks: [], outcome: null, example: false });
/* Two separate states. MY = the user's own data, saved on this phone.
   The example patient lives only in memory, so opening it never touches MY. */
let MY;
try { MY = JSON.parse(localStorage.getItem(KEY)) || blank(); } catch { MY = blank(); }
if (MY.example) MY = blank(); // older versions wrote the example over the user's data
let S = MY;
const isEx = () => S !== MY;
function save() { if (isEx()) return; try { localStorage.setItem(KEY, JSON.stringify(MY)); } catch { toast('Storage full: older photos were not saved'); } }
const myHome = () => MY.clinic ? 'today' : 'welcome';

/* ---------- evidence & procedure knowledge ---------- */
/* tau = how fast redness is expected to fade (days). Working assumptions shaped by
   published ranges and still being checked; the app says so on screen. */
const PROC = {
  toning: { label: 'Low-fluence toning (pico / Q-switched / Genesis)', tau: 1.5 },
  ipl: { label: 'IPL / BBL', tau: 2 },
  nafx: { label: 'Non-ablative fractional', tau: 3 },
  afx: { label: 'Ablative fractional (CO2 / Er:YAG)', tau: 6 },
  spot: { label: 'Spot removal (lentigo / mole)', tau: 5 },
};
const TH = { red: 2, brown: 4 }; // per-pixel thresholds (index units), fixed before looking at outcomes
const SOURCES = [
  ['Similar-patient range', 'Published ranges per procedure type; replaced by real patients once 5 or more similar patients have outcomes', 'Assumption, being checked'],
  ['Redness and brown indices', 'Log ratio of red/green and of red reflectance, relative to your own normal skin in the same photo (Dawson-type indices)', 'Literature method'],
  ['Strict sunscreen after laser', 'Review of post-laser sunscreen use; Asian cohorts had fewer PIH cases', 'Literature'],
  ['Pause retinoids around laser', 'Clinic practice, a few days before and after', 'Weak evidence'],
  ['Menstrual phase and pigment', 'Small studies only (e.g. 7 volunteers after CO2 laser)', 'Weak evidence'],
  ['Heat, sauna, hard workouts', 'Clinic aftercare sheets', 'Weak evidence'],
  ['Alcohol, sleep, friction', 'No direct study found; tracked to see if they matter for you', 'Tracked to learn'],
];
const TAGS = { lit: 'Literature', weak: 'Weak evidence', clinic: 'Your clinic', track: 'Tracked to learn', you: 'Your data' };
const tag = k => `<span class="tag ${k === 'track' ? '' : k === 'you' ? 'real' : k}">${TAGS[k]}</span>`;

/* ---------- photo analysis ---------- */
const lin = v => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const LUT = new Float32Array(256).map((_, i) => Math.max(lin(i), 1e-4));
function loadImg(src) { return new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = src; }); }
function fileURL(file) { return new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(file); }); }
function toCanvas(im, max = 900) {
  const k = Math.min(1, max / Math.max(im.naturalWidth, im.naturalHeight));
  const c = document.createElement('canvas'); c.width = Math.round(im.naturalWidth * k); c.height = Math.round(im.naturalHeight * k);
  c.getContext('2d').drawImage(im, 0, 0, c.width, c.height); return c;
}
function thumb(c, max = 360) { const k = Math.min(1, max / Math.max(c.width, c.height)); const t = document.createElement('canvas'); t.width = c.width * k; t.height = c.height * k; t.getContext('2d').drawImage(c, 0, 0, t.width, t.height); return t.toDataURL('image/jpeg', .72); }
const med = a => { const s = [...a].sort((p, q) => p - q); return s[s.length >> 1] ?? 0; };

/* watch / normal are {x,y} in 0..1 of the image */
function analyze(c, watch, normal) {
  const W = c.width, H = c.height, d = c.getContext('2d').getImageData(0, 0, W, H).data;
  const rad = Math.round(Math.min(W, H) * 0.07);
  const idx = (x, y) => (y * W + x) * 4;
  const px = (cx, cy, rr, f) => { for (let y = Math.max(0, cy - rr); y < Math.min(H, cy + rr); y++) for (let x = Math.max(0, cx - rr); x < Math.min(W, cx + rr); x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= rr * rr) f(x, y); };
  const nx = Math.round(normal.x * W), ny = Math.round(normal.y * H), wx = Math.round(watch.x * W), wy = Math.round(watch.y * H);
  const MI = [], EI = [], LUM = []; let clip = 0, n = 0;
  px(nx, ny, rad, (x, y) => { const i = idx(x, y), R = LUT[d[i]], G = LUT[d[i + 1]], B = LUT[d[i + 2]]; MI.push(-100 * Math.log10(R)); EI.push(100 * Math.log10(R / G)); LUM.push(.2126 * R + .7152 * G + .0722 * B); });
  const rM = med(MI), rE = med(EI), rL = med(LUM);
  let sE = 0, sM = 0, red = 0, brown = 0;
  px(wx, wy, rad, (x, y) => {
    const i = idx(x, y); if (d[i] > 250 || d[i + 1] > 250) clip++;
    const R = LUT[d[i]], G = LUT[d[i + 1]];
    const e = 100 * Math.log10(R / G) - rE, m = -100 * Math.log10(R) - rM;
    sE += e; sM += m; if (e > TH.red) red++; if (m > TH.brown) brown++; n++;
  });
  // sharpness: variance of a Laplacian around the watch spot
  const lap = [], g = (x, y) => { const i = idx(x, y); return .3 * d[i] + .59 * d[i + 1] + .11 * d[i + 2]; };
  for (let y = Math.max(1, wy - rad); y < Math.min(H - 1, wy + rad); y += 2) for (let x = Math.max(1, wx - rad); x < Math.min(W - 1, wx + rad); x += 2)
    lap.push(4 * g(x, y) - g(x - 1, y) - g(x + 1, y) - g(x, y - 1) - g(x, y + 1));
  const lm = lap.reduce((a, b) => a + b, 0) / (lap.length || 1), sharp = lap.reduce((a, b) => a + (b - lm) ** 2, 0) / (lap.length || 1);
  const issues = [];
  if (rL < 0.05) issues.push('Too dark. Use the flash.');
  if (clip / Math.max(n, 1) > 0.05) issues.push('Glare on the spot. Tilt the phone slightly.');
  if (sharp < 4) issues.push('Looks blurry. Hold still and tap to focus.');
  return { dEI: sE / n, dMI: sM / n, redA: red / n * 100, brownA: brown / n * 100, lum: rL, sharp, issues, rad, watch, normal };
}
/* colour the pixels that differ from normal skin, only around the marked spot */
function overlay(c, a) {
  const W = c.width, H = c.height, ctx = c.getContext('2d'), img = ctx.getImageData(0, 0, W, H), d = img.data;
  const wx = Math.round(a.watch.x * W), wy = Math.round(a.watch.y * H), nx = Math.round(a.normal.x * W), ny = Math.round(a.normal.y * H), rr = Math.round(a.rad * 2.2);
  const MI = [], EI = [];
  for (let y = ny - a.rad; y < ny + a.rad; y++) for (let x = nx - a.rad; x < nx + a.rad; x++) { if (x < 0 || y < 0 || x >= W || y >= H || (x - nx) ** 2 + (y - ny) ** 2 > a.rad ** 2) continue; const i = (y * W + x) * 4; MI.push(-100 * Math.log10(LUT[d[i]])); EI.push(100 * Math.log10(LUT[d[i]] / LUT[d[i + 1]])); }
  const rM = med(MI), rE = med(EI);
  for (let y = Math.max(0, wy - rr); y < Math.min(H, wy + rr); y++) for (let x = Math.max(0, wx - rr); x < Math.min(W, wx + rr); x++) {
    if ((x - wx) ** 2 + (y - wy) ** 2 > rr * rr) continue;
    const i = (y * W + x) * 4, R = LUT[d[i]], G = LUT[d[i + 1]];
    const e = 100 * Math.log10(R / G) - rE, m = -100 * Math.log10(R) - rM;
    if (m > 40) continue; // hair, shadow
    const isR = e > TH.red * 2, isB = m > TH.brown * 1.5;
    if (!isR && !isB) continue;
    const col = isR && isB ? [150, 40, 120] : isR ? [235, 50, 70] : [120, 70, 20];
    d[i] = d[i] * .45 + col[0] * .55; d[i + 1] = d[i + 1] * .45 + col[1] * .55; d[i + 2] = d[i + 2] * .45 + col[2] * .55;
  }
  ctx.putImageData(img, 0, 0);
  ctx.lineWidth = Math.max(2, W / 250);
  ctx.strokeStyle = '#fff'; ctx.setLineDash([6, 5]); ctx.beginPath(); ctx.arc(wx, wy, rr, 0, 7); ctx.stroke();
  ctx.setLineDash([]); ctx.strokeStyle = '#3fbf7f'; ctx.beginPath(); ctx.arc(nx, ny, a.rad, 0, 7); ctx.stroke();
}
function where(a) {
  const side = a.watch.x < 0.4 ? 'left' : a.watch.x > 0.6 ? 'right' : 'centre';
  const v = a.watch.y < 0.4 ? 'upper' : a.watch.y > 0.6 ? 'lower' : 'middle';
  return v === 'middle' && side === 'centre' ? 'centre of the photo' : `${v} ${side} of the photo`;
}

/* ---------- course logic ---------- */
const dayN = s => S.clinic ? Math.round((new Date(s + 'T00:00') - new Date(S.clinic.date + 'T00:00')) / DAY) : null;
const todayN = () => S.clinic ? Math.round((today0() - new Date(S.clinic.date + 'T00:00')) / DAY) : null;
const proc = () => PROC[S.clinic?.kind] || PROC.toning;
/* after the visit day: no new treatment -> check in every 3 days until day 28; new treatment -> a new daily course */
const cadence = () => S.clinic?.follow === 'none' && todayN() > S.clinic.visitDay ? 3 : 1;
const horizon = () => S.clinic?.follow === 'none' ? 28 : S.clinic.visitDay;
function band(t) { const c = Math.exp(-t / proc().tau); return { c, lo: Math.max(0, c - .25), hi: Math.min(1.2, c + .3) }; }
const sorted = () => [...S.checks].sort((a, b) => a.date < b.date ? -1 : 1);
function day0Red() { const c = sorted().find(x => x.m); return c ? Math.max(c.m.dEI, 0.5) : null; }
const baseBrown = () => S.baseline?.m?.dMI ?? sorted()[0]?.m?.dMI ?? 0;

function evaluate() {
  const out = [], r0 = day0Red(), b0 = baseBrown();
  let prev = null;
  sorted().forEach(c => {
    const t = dayN(c.date), b = band(t), rel = c.m ? c.m.dEI / r0 : null;
    const gap = prev ? t - prev.t : 1;
    const above = rel != null && t > 0 && rel > b.hi;
    const brownUp = !!c.m && t >= 3 && (c.m.dMI - b0) > 2;
    const sympt = Math.max(c.feel?.sting || 0, c.feel?.itch || 0);
    const bad = c.q?.length > 0;
    let lvl = 'ok';
    if (above || brownUp || sympt >= 2) lvl = 'watch';
    const chain = prev && gap <= (t > S.clinic.visitDay ? 4 : 2);
    if ((above && chain && prev.above) || (brownUp && chain && prev.brownUp) || sympt >= 3) lvl = 'crit';
    if (bad && !above && !brownUp) lvl = 'hold';
    const e = { ch: c, t, b, rel, above, brownUp, lvl, gap, sympt };
    out.push(e); prev = e;
  });
  return out;
}
const LV = { ok: ['On track', 'ok'], watch: ['Watch closely', 'watch'], crit: ['Contact your clinic', 'crit'], hold: ['Not enough data', 'crust'] };

/* AI care guide: phase rules + your profile + what you logged today. Each line says why. */
function guideFor(e) {
  const p = S.profile, h = S.habits, L = e?.ch?.life || {}, F = e?.ch?.feel || {}, t = e ? e.t : 0, g = [];
  const add = (txt, why, k) => g.push({ txt, why, k });
  if (t <= 2) add('Keep it cool and calm. Mild low-pH cleanser, gentle wash, moisturiser on top.', 'First 48 hours after the procedure', 'clinic');
  if (t <= 7) add('Skip sauna, hot baths and hard workouts this week.', 'Heat keeps redness going' + (+h.sauna > 0 ? `; you usually go ${h.sauna}x a week` : ''), 'weak');
  else if ((L.heat || []).length) add('You logged heat or sweat today. Cool the skin down and skip it for a few more days.', 'Logged: ' + L.heat.join(', '), 'weak');
  if ((+L.outdoor || 0) >= 60 && (+L.reapply || 0) < 2) add('Re-apply sunscreen every 2 hours outside, and wear a hat.', `Today ${L.outdoor} min outside, re-applied ${L.reapply || 0}x`, 'lit');
  else if (p.job === 'outdoor' || parseFloat(h.outdoor) >= 2) add('Your day is mostly outdoors: sunscreen every 2 hours, hat or parasol.', `Your usual outdoor time: ${h.outdoor || '?'} h a day`, 'lit');
  else add('Sunscreen every morning, and again before going out.', 'Sun is the main driver of PIH after laser', 'lit');
  if (p.retinoid || (h.actives || []).includes('retinoid') || (L.applied || []).includes('retinoid')) add('Pause retinoids until your clinic says it is OK.', 'Retinoid in your profile or today\'s log', 'weak');
  if ((L.applied || []).some(x => x === 'acid' || x === 'scrub')) add('Stop acids and scrubs for now.', 'You logged an exfoliant today', 'clinic');
  if ((L.applied || []).includes('new')) add('Hold the new product until the skin settles.', 'New product logged today', 'clinic');
  if (p.photosens) add('Tell your clinic about the sun-sensitising medicine.', 'From your medicines', 'weak');
  if (L.pick) add('Leave crusts alone; let them fall off by themselves.', 'You logged picking', 'clinic');
  if ((F.sting || 0) >= 2 || (F.dry || 0) >= 2) add('Moisturiser only tonight; no new products.', `Stinging ${F.sting || 0}/3, dryness ${F.dry || 0}/3`, 'clinic');
  if (p.prior === 'yes') add('You had PIH before, so the app watches brown changes earlier and closer.', 'Your history', 'you');
  if (L.period || nearPeriod()) add('Around your period, be extra strict with sun.', 'Small studies link this phase to more pigment', 'weak');
  if ((+L.alcohol || 0) >= 2 || (L.sleep && +L.sleep < 6)) add('Alcohol or short sleep logged. No rule yet: your report checks whether it lines up with your redness.', 'Collected to learn', 'track');
  return g;
}
function nearPeriod() {
  const p = S.profile; if (p.sex !== 'female' || p.meno === 'yes' || !p.lastPeriod) return false;
  const cyc = +p.cycle || 28, since = ((Math.round((today0() - new Date(p.lastPeriod + 'T00:00')) / DAY) % cyc) + cyc) % cyc;
  return since <= 4 || since >= cyc - 3;
}
function group() {
  const fitz = S.clinic?.fitz || '', dark = /^(IV|V|VI)\b/.test(fitz);
  const name = `${proc().label.split(' (')[0]} · skin type ${dark ? 'IV to VI' : 'I to III'} · ${S.profile.prior === 'yes' ? 'had PIH before' : 'no PIH before'}`;
  const n = S.clinic?.example ? 1 : 0; // the one real case behind this prototype
  return { name, n };
}
function briefing(e, all) {
  if (!e) return null;
  const n = e.t, b = e.b, grp = group();
  let where;
  if (e.rel == null) where = `Day ${n}. No usable photo today.`;
  else if (n === 0) where = `Day 0. Redness is ${r1(e.ch.m.dEI)} above your normal skin. This is your starting point.`;
  else where = `Day ${n}. Redness is at ${Math.round(e.rel * 100)}% of day 0. Similar patients are usually at ${Math.round(b.lo * 100)} to ${Math.round(b.hi * 100)}% by now.`;
  if (e.ch.m && n >= 3) where += ` Brown ${e.ch.m.dMI - baseBrown() > 2 ? '<b>is rising above</b>' : 'is at or below'} your pre-procedure level.`;
  const conf = e.ch.q?.length ? 'Low: photo quality issue (' + e.ch.q[0] + ')' : e.gap > (e.t > S.clinic.visitDay ? 4 : 2) ? `Low: ${e.gap - 1} days missing before this check-in` : grp.n < 5 ? `Medium: range from published data; ${grp.n} similar patient${grp.n === 1 ? '' : 's'} with outcomes so far` : 'High';
  const todo = e.lvl === 'crit' ? 'Share today\'s report with your clinic. They have been notified and may bring your visit forward.' : e.lvl === 'watch' ? 'Follow the care guide closely. Check in again tomorrow at the same time.' : e.lvl === 'hold' ? 'Retake the photo in a dark room with flash.' : (n >= S.clinic.visitDay && S.clinic.follow === 'none') ? `Keep going. Next check-in in 3 days (day ${n + 3}).` : n >= S.clinic.visitDay ? 'Visit day: tell the app whether you had another treatment.' : `Keep going. Next check-in tomorrow. Clinic visit on day ${S.clinic.visitDay}.`;
  let adapt = null; const i = all.indexOf(e), p = i > 0 ? all[i - 1] : null;
  if (p && p.rel != null && e.rel != null && (p.lvl === 'watch' || p.lvl === 'crit')) {
    const better = (e.rel - e.b.hi) < (p.rel - p.b.hi) && !(e.brownUp && !p.brownUp);
    const followed = (+e.ch.life?.reapply || 0) >= 2 || (+e.ch.life?.outdoor || 0) < 60;
    adapt = better ? `Yesterday's plan seems to help: closer to the usual range${followed ? ', and you kept the sun plan' : ''}. Level steps down if this holds.` : `Not better yet${followed ? ' even with the plan' : ' and the sun plan was not kept'}. Level steps up.`;
  }
  return { where, conf, todo, adapt };
}

/* ---------- views ---------- */
const V = {};
function go(v) { S.step = v; save(); render(); scrollTo(0, 0); }
function render() {
  const v = S.step;
  $('#tabs').hidden = !S.clinic || !['today', 'check', 'course', 'report', 'proc', 'result', 'more'].includes(v);
  document.querySelectorAll('#tabs button').forEach(b => b.setAttribute('aria-current', b.dataset.go === v ? 'page' : 'false'));
  $('#who').textContent = S.clinic ? `Day ${todayN()}` : '';
  document.body.classList.toggle('exmode', isEx());
  $('#exBanner').hidden = !isEx();
  $('#exBanner').innerHTML = `<div><b>Example patient · demo</b><span>Clinic photos are a real, consented case (cropped). Nightly check-ins are simulated. Nothing here is saved or mixed with your own data.</span></div><button data-act="exitExample">Exit to my app</button>`;
  $('#homeBtn').setAttribute('aria-label', isEx() ? 'Exit example, back to my app' : 'Home');
  $('#view').innerHTML = (V[v] || V.welcome)();
  (V[v + '_after'] || (() => { }))();
}

V.welcome = () => `
<div class="hero"><img src="icon.svg" width="64" height="64" alt=""><h1>PIH Guard</h1>
<p class="muted">Catch dark marks after skin procedures early, while there is still time to act.</p></div>
<div class="card path"><span class="sec">My app</span><h2>Use PIH Guard for my own procedure</h2>
<p class="small">Set this up <b>before</b> your procedure. Your clinic sends the treatment details. Each night you take one flash photo and do a 30-second check. The app tells you where you are in the healing course, what to change in daily care, and when to contact your clinic.</p>
<button data-go="guide">${MY.consent ? 'Continue my setup' : 'Get started'}</button></div>
<div class="card path expath"><span class="sec">Demo</span><h2>See an example patient</h2>
<p class="small">A filled-in course: real clinic photos from one consented case, with simulated nightly check-ins. Opens in demo mode with an orange bar; your own data is not touched. Tap <b>Exit to my app</b> or the logo to come back here.</p>
<div class="imgs ba"><figure><img src="assets/case_before.jpg" alt="Before"><figcaption>Before the course</figcaption></figure><figure><img src="assets/case_after.jpg" alt="After"><figcaption>After the course</figcaption></figure></div>
<div class="row navrow"><button class="exbtn" data-act="example">Day 9 (mid-course)</button><button class="exbtn ghost" data-act="example14">Day 14 (visit)</button></div></div>`;

V.guide = () => `
<p class="stepno muted small">Step 1 of 5 · How it works</p>
<div class="card"><h2>Your nightly 2 minutes</h2><div class="steps">
<div class="step on"><i>1</i><div><b>Dark room, flash on.</b> Rear camera, same distance (about 20 cm), every night. The flash is the only light, so photos can be compared night to night.</div></div>
<div class="step on"><i>2</i><div><b>Tap the treated spot, then normal skin nearby.</b> Your own normal skin is the colour reference, so phone settings cancel out.</div></div>
<div class="step on"><i>3</i><div><b>30-second life check.</b> Time outside, sunscreen, heat, what you put on your skin, how it feels.</div></div>
</div></div>
<div class="card"><h2>What you get back</h2><p class="small muted">Below is a live analysis of a real photo of post-inflammatory hyperpigmentation (consented, cropped). The numbers are computed in your browser right now.</p>
<canvas id="exCanvas" class="photo"></canvas>
<div class="legend"><span><i style="background:#eb3246"></i>Redder than normal skin</span><span><i style="background:#784614"></i>Browner</span><span><i style="background:#962878"></i>Both</span><span><i style="border:2px solid #3fbf7f"></i>Normal skin reference</span></div>
<div id="exNums" class="kv"></div>
<div class="brief" id="exBrief"></div>
</div>
<div class="card"><h2>Reports</h2><ul class="guide small">
<li><b>Every night:</b> where you are versus similar patients, how sure the app is, what to do, and a care guide built from your own log.</li>
<li><b>Over the course:</b> your trend, how often you kept the plan, and patterns in your habits (marked "may be coincidence").</li>
<li><b>For your clinic:</b> a one-page report you share when the app asks, and at your visit.</li></ul>
<p class="note">Not a diagnosis. Diagnoses such as melasma or freckles come only from your clinic.</p></div>
<div class="card"><label class="row small"><input type="checkbox" id="consent" style="width:auto" ${S.consent ? 'checked' : ''}> I agree that my photos and logs stay on this phone and go to my clinic only when I press Share.</label></div>
<div class="row navrow"><button class="ghost" data-go="welcome">Back</button><button data-act="consentNext">Next</button></div>`;
V.guide_after = async () => {
  const im = await loadImg('assets/pih_example.jpg'), c = toCanvas(im, 560), cv = $('#exCanvas'); if (!cv) return;
  const a = analyze(c, { x: .51, y: .40 }, { x: .72, y: .30 }); overlay(c, a);
  cv.width = c.width; cv.height = c.height; cv.getContext('2d').drawImage(c, 0, 0);
  $('#exNums').innerHTML = `<div><b>Redness vs normal</b><span>+${r1(a.dEI)}</span></div><div><b>Red area</b><span>${Math.round(a.redA)}%</span></div><div><b>Brown area</b><span>${Math.round(a.brownA)}%</span></div>`;
  $('#exBrief').innerHTML = `<div><b>Where</b><span>A red patch with brown edges in the ${where(a)}. Redness is well above the normal skin next to it.</span></div>
<div><b>Sure?</b><span>Photo quality ${a.issues.length ? 'low: ' + a.issues[0].replace(/\.$/, '') : 'OK'}. Example only: this photo has no day 0 to compare with.</span></div>
<div><b>Do</b><span>If this were day 14 after toning, redness this strong is outside the usual range: the app would ask you to share your report with the clinic.</span></div>
<div><b>Care</b><span>Strict sunscreen, no heat, no picking, no retinoids until your clinic has looked.</span></div>`;
};

const sel = (id, opts, val) => `<select id="${id}">${opts.map(o => { const [v, l] = Array.isArray(o) ? o : [o, o]; return `<option value="${v}" ${String(val ?? '') === String(v) ? 'selected' : ''}>${l}</option>`; }).join('')}</select>`;
const cb = (id, on, label) => `<label class="row small"><input type="checkbox" id="${id}" style="width:auto" ${on ? 'checked' : ''}> ${label}</label>`;
V.p1 = () => {
  const p = S.profile;
  return `<p class="stepno muted small">Step 2 of 5 · About you</p>
<div class="card"><div class="grid2">
<label class="f full">Name<input id="name" value="${esc(p.name)}" placeholder="Shown only on your clinic report"></label>
<label class="f">Age<input id="age" type="number" inputmode="numeric" value="${esc(p.age)}"></label>
<label class="f">Sex${sel('sex', [['', 'Select'], ['female', 'Female'], ['male', 'Male'], ['other', 'Other']], p.sex)}</label>
<label class="f">Nationality<input id="nation" value="${esc(p.nation)}"></label>
<label class="f">Ethnicity${sel('eth', [['', 'Select'], 'East Asian', 'South Asian', 'Southeast Asian', 'Black / African', 'Hispanic / Latino', 'Middle Eastern', 'White', 'Mixed / Other'], p.eth)}</label>
<label class="f full">Job${sel('job', [['', 'Select'], ['indoor', 'Mostly indoors'], ['mixed', 'Mixed'], ['outdoor', 'Mostly outdoors']], p.job)}</label>
</div></div>
<div class="card"><h3>Past dark marks</h3>
<label class="f">Has a dark mark ever stayed after a procedure, acne or a wound?${sel('prior', [['', 'Select'], ['no', 'No'], ['yes', 'Yes'], ['unsure', 'Not sure']], p.prior)}</label>
<label class="f">If yes, after what?<input id="priorWhat" value="${esc(p.priorWhat)}" placeholder="e.g. CO2 laser, acne"></label></div>
<div class="card"><h3>Medicines now</h3>
${cb('retinoid', p.retinoid, 'Retinoid pills or creams (isotretinoin, tretinoin)')}
${cb('photosens', p.photosens, 'Medicine that makes skin sun-sensitive (some antibiotics, diuretics)')}
${cb('hormone', p.hormone, 'Birth control pill or hormone therapy')}
<label class="f">Others<input id="meds" value="${esc(p.meds)}"></label></div>
<div class="card" id="femBox" ${p.sex === 'female' ? '' : 'hidden'}><h3>Menstrual cycle</h3><div class="grid2">
<label class="f">Menopause${sel('meno', [['no', 'No'], ['yes', 'Yes']], p.meno)}</label>
<label class="f">Pregnant / breastfeeding${sel('preg', [['no', 'No'], ['yes', 'Yes']], p.preg)}</label>
<label class="f">Last period started<input id="lastPeriod" type="date" value="${esc(p.lastPeriod)}"></label>
<label class="f">Usual cycle (days)<input id="cycle" type="number" value="${esc(p.cycle || 28)}"></label></div></div>
<div class="card"><h3>Your skin, in your words</h3>
<div class="chips" id="selfType">${['Oily', 'Dry', 'Combination', 'Not sure'].map(x => `<button class="chip" aria-pressed="${p.selfType === x}" data-v="${x}">${x}</button>`).join('')}</div>
<p class="note">Medical skin type (Fitzpatrick) and any diagnosis come from your clinic, not from you.</p></div>
<div class="row navrow"><button class="ghost" data-go="guide">Back</button><button data-act="p1">Next</button></div>`;
};
V.p1_after = () => {
  $('#sex').onchange = e => $('#femBox').hidden = e.target.value !== 'female';
  $('#selfType').onclick = e => { const b = e.target.closest('.chip'); if (!b) return; $('#selfType').querySelectorAll('.chip').forEach(x => x.setAttribute('aria-pressed', x === b)); };
};
V.p2 = () => {
  const h = S.habits, act = h.actives || [];
  return `<p class="stepno muted small">Step 3 of 5 · Your usual habits</p>
<div class="card"><div class="grid2">
<label class="f">Sunscreen per day${sel('sun', ['0', '1', '2', '3+'], h.sun)}</label>
<label class="f">Outdoor time per day (h)${sel('outdoor', ['0', '0.5', '1', '2', '3', '4+'], h.outdoor)}</label>
<label class="f">Workouts per week${sel('workout', ['0', '1', '2', '3', '4', '5+'], h.workout)}</label>
<label class="f">Sauna / hot bath per week${sel('sauna', ['0', '1', '2', '3+'], h.sauna)}</label>
<label class="f">Drinks per week${sel('drinks', ['0', '1-2', '3-6', '7+'], h.drinks)}</label>
<label class="f">Sleep per night (h)${sel('sleepH', ['<5', '5', '6', '7', '8+'], h.sleepH)}</label>
<label class="f">Hat or parasol outside${sel('hat', ['Rarely', 'Sometimes', 'Usually'], h.hat)}</label>
<label class="f">Makeup or mask most days${sel('makeup', ['No', 'Yes'], h.makeup)}</label></div></div>
<div class="card"><h3>Products you use now</h3><div class="chips" id="actives">${[['retinoid', 'Retinol / retinoid'], ['acid', 'AHA / BHA acids'], ['scrub', 'Scrub'], ['bright', 'Brightening (vitamin C etc.)'], ['none', 'None of these']].map(([v, l]) => `<button class="chip" aria-pressed="${act.includes(v)}" data-v="${v}">${l}</button>`).join('')}</div></div>
<div class="row navrow"><button class="ghost" data-go="p1">Back</button><button data-act="p2">Next</button></div>`;
};
V.p2_after = () => { $('#actives').onclick = e => { const b = e.target.closest('.chip'); if (b) b.setAttribute('aria-pressed', b.getAttribute('aria-pressed') !== 'true'); }; };

/* photo capture with two taps; used by baseline and nightly check-in */
let CAP = null;
const photoBlock = (title, hint) => `<div class="card"><h2>${title}</h2><p class="small muted">${hint}</p>
<label class="btn" style="display:block">Take photo<input id="file" type="file" accept="image/*" capture="environment" hidden></label>
<canvas id="cv" class="photo" hidden></canvas><p id="tapHint" class="small" hidden></p><div id="qual"></div></div>`;
function bindPhoto(onReady) {
  CAP = null;
  $('#file').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    const im = await loadImg(await fileURL(f)); const c = toCanvas(im, 900);
    CAP = { c, taps: [] }; drawCap(); $('#cv').hidden = false; $('#tapHint').hidden = false;
    $('#tapHint').textContent = '1. Tap the treated spot.'; $('#qual').innerHTML = '';
  };
  $('#cv').onclick = e => {
    if (!CAP) return; const r = e.target.getBoundingClientRect();
    if (CAP.taps.length >= 2) { CAP.taps = []; CAP.a = null; }
    CAP.taps.push({ x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height });
    drawCap();
    if (CAP.taps.length === 1) $('#tapHint').textContent = '2. Tap normal skin nearby, in the same light.';
    else { CAP.a = analyze(CAP.c, CAP.taps[0], CAP.taps[1]); $('#tapHint').textContent = 'Tap again to redo.'; showQual(CAP.a); onReady && onReady(CAP.a); }
  };
}
function drawCap() {
  const cv = $('#cv'), c = CAP.c; cv.width = c.width; cv.height = c.height; const x = cv.getContext('2d'); x.drawImage(c, 0, 0);
  const rad = Math.min(c.width, c.height) * .07; x.lineWidth = 3;
  CAP.taps.forEach((t, i) => { x.strokeStyle = i ? '#3fbf7f' : '#fff'; x.beginPath(); x.arc(t.x * c.width, t.y * c.height, rad, 0, 7); x.stroke(); });
}
function showQual(a) {
  $('#qual').innerHTML = a.issues.length ? `<p class="banner">Retake suggested: ${a.issues.join(' ')}</p>` : `<p class="small" style="color:var(--ok)">Photo quality OK. Redness +${r1(a.dEI)}, brown +${r1(a.dMI)} vs your normal skin.</p>`;
}
V.baseline = () => `<p class="stepno muted small">Step 4 of 5 · Before-procedure photo</p>
${photoBlock('Your baseline photo', 'Take this before the procedure: darkest room you have, flash on, rear camera, about 20 cm away. Your clinic\'s pre-treatment photo (e.g. Markview) is added later as a second baseline.')}
<div class="row navrow"><button class="ghost" data-go="p2">Back</button><button data-act="baseline" id="bNext" disabled>Save baseline</button></div>
<button class="wide ghost small" data-act="skipBase">Skip for now</button>`;
V.baseline_after = () => bindPhoto(() => $('#bNext').disabled = false);

V.connect = () => `<p class="stepno muted small">Step 5 of 5 · Link your clinic</p>
<div class="card"><h2>Ready for your procedure</h2><p>After your treatment, the clinic gives you a code or QR. It brings in what was done, with their pre-treatment photo. You can read it but not change it.</p>
<label class="f">Clinic code<input id="code" placeholder="e.g. DEMO-1064"></label>
<button data-act="link">Link</button><p class="note">Prototype: any code loads an example clinic entry dated today.</p></div>
<div class="card"><h3>Checklist</h3><ul class="guide small"><li>Profile: ${S.profile.age ? 'done' : 'missing'}</li><li>Habits: ${S.habits.sun != null ? 'done' : 'missing'}</li><li>Baseline photo: ${S.baseline ? 'done' : 'not taken'}</li></ul></div>`;

V.proc = () => {
  const c = S.clinic; if (!c) return V.connect();
  return `<div class="card"><div class="row between"><h2>Treatment from your clinic</h2><span class="tag clinic">Read-only</span></div>
<div class="ro"><b>Clinic</b><span>${esc(c.name)}</span><b>Visit date</b><span>${fmt(c.date)} (day 0)</span><b>Session</b><span>${esc(c.session)}</span>
<b>Clinic diagnosis</b><span>${esc(c.dx)}</span><b>Skin type</b><span>Fitzpatrick ${esc(c.fitz)}</span><b>Next visit</b><span>Day ${c.visitDay} · ${fmt(addDays(c.date, c.visitDay))}</span></div>
<div class="scroll"><table class="tbl"><tr><th>Procedure</th><th>Medium · wavelength</th><th>Pulse</th><th>Spot · fluence</th><th>Rate · energy</th><th>Shots</th></tr>
${c.rows.map(r => `<tr><td>${esc(r.name)}</td><td>${esc(r.medium)} · ${esc(r.wl)}</td><td>${esc(r.pulse)}</td><td>${esc(r.spot)} · ${esc(r.fluence)}</td><td>${esc(r.rate || '-')} · ${esc(r.energy || '-')}</td><td>${esc(r.shots)}</td></tr>`).join('')}</table></div>
${c.settingsNote ? `<p class="note">${esc(c.settingsNote)}</p>` : ''}
<p class="small"><b>Notes:</b> ${esc(c.notes)}</p></div>
<div class="card"><h3>Baselines</h3><div class="imgs">
<figure>${c.markview ? `<img src="${c.markview}" alt="Clinic pre-treatment photo">` : '<div class="muted small" style="padding:20px 0">Your clinic\'s photo appears here</div>'}<figcaption>Clinic pre-treatment photo (Markview) ${c.example ? '<span class="tag real">real case</span>' : ''}</figcaption></figure>
<figure>${S.baseline?.img ? `<img src="${S.baseline.img}" alt="Your baseline">` : `<div class="muted small" style="padding:20px 0">${S.baseline ? 'Numbers only (simulated)' : 'Not taken'}</div>`}<figcaption>Your own flash photo before the procedure</figcaption></figure></div></div>
<div class="card"><h3>Alert rules set before treatment</h3><p class="small muted">The clinic fixed these before any photo was taken, so nobody moves the goalposts later.</p>
<ul class="guide small"><li><b>Watch</b>: redness above the usual range for that day, or brown more than 2 units above your pre-procedure photo, or stinging or itching 2 of 3.</li>
<li><b>Contact clinic</b>: either of the first two on two check-ins in a row, or symptoms 3 of 3. The clinic is told and may bring the visit forward.</li>
<li><b>Hold</b>: poor photo or 2+ days missing. The app says it is not sure instead of guessing.</li>
<li><b>After the visit</b>: on day ${c.visitDay} the clinic records the outcome. New treatment: a new daily course starts. No new treatment: check-ins every 3 days until day 28, since PIH can appear weeks after healing.</li></ul></div>
<button class="wide" data-go="today">Go to today</button>`;
};

/* one horizontal scale: shaded zone + where you are */
function gauge({ title, val, min, max, zone, zoneLabel, zoneCol, mark, unit, ticks }) {
  const W = 520, H = 58, pl = 8, pr = 8, X = v => pl + (Math.min(Math.max(v, min), max) - min) / (max - min) * (W - pl - pr);
  return `<div class="gauge"><div class="row between small"><b>${title}</b><span class="gv">${val == null ? '-' : (val > 0 && unit !== '%' ? '+' : '') + r1(val) + unit}</span></div>
<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${title}">
<rect x="${pl}" y="16" width="${W - pl - pr}" height="12" rx="6" fill="var(--soft)"/>
<rect x="${X(zone[0])}" y="16" width="${X(zone[1]) - X(zone[0])}" height="12" rx="6" fill="${zoneCol}"/>
<text x="${(X(zone[0]) + X(zone[1])) / 2}" y="11" font-size="11" text-anchor="middle" fill="var(--muted)">${zoneLabel}</text>
${(mark != null) ? `<line x1="${X(mark)}" x2="${X(mark)}" y1="12" y2="32" stroke="var(--warn)" stroke-width="2"/>` : ''}
${ticks.map(t => `<text x="${X(t)}" y="${H - 6}" font-size="10" text-anchor="middle" fill="var(--muted)">${t}${unit}</text>`).join('')}
${val != null ? `<circle cx="${X(val)}" cy="22" r="8" fill="var(--ink)" stroke="var(--surface)" stroke-width="2.5"/>` : ''}
</svg></div>`;
}
function briefViz(e, all) {
  if (!e) return '';
  const b0 = baseBrown(), dB = e.ch.m ? e.ch.m.dMI - b0 : null, L = e.ch.life || {}, F = e.ch.feel || {};
  const red = e.rel != null && e.t > 0 ? gauge({ title: 'Redness, % of day 0', val: e.rel * 100, min: 0, max: 140, zone: [e.b.lo * 100, e.b.hi * 100], zoneLabel: `usual on day ${e.t}`, zoneCol: 'var(--band)', unit: '%', ticks: [0, 50, 100, 140] }) : '';
  const brown = dB != null ? gauge({ title: 'Brown vs your pre-procedure photo', val: dB, min: -3, max: 6, zone: [2, 6], zoneLabel: 'watch zone', zoneCol: 'color-mix(in srgb,var(--warn) 22%,transparent)', mark: 2, unit: '', ticks: [-3, 0, 2, 6] }) : '';
  const out = +L.outdoor || 0, re = +L.reapply || 0, heat = (L.heat || []), sym = Math.max(F.sting || 0, F.itch || 0, F.warm || 0);
  const tile = (k, v, ok, sub) => `<div class="${ok ? 'tok' : 'twarn'}"><b>${k}</b><span>${v}</span><i>${sub}</i></div>`;
  const tiles = `<div class="kv tiles">${tile('Outside', out + ' min', out < 60 || re >= 2, out >= 60 ? 'long day out' : 'short')}${tile('Sunscreen re-applied', re + 'x', out < 60 || re >= 2, out >= 60 ? 'plan: 2x or more' : 'plan met')}${tile('Heat / sweat', heat.length ? heat.length : 'none', !heat.length || e.t > 7, heat.length ? heat.join(', ') : 'plan met')}${tile('Symptoms', ['none', 'mild', 'clear', 'strong'][sym], sym < 2, 'worst of sting / itch / warmth')}</div>`;
  return `<div class="viz">${red}${brown}<h3>Tonight's log against the plan</h3>${tiles}<h3>The course so far</h3>${courseSVG(all, e.t)}</div>`;
}

/* full care guide: personal lines first, then the standing rules by topic */
function careHTML(e) {
  const t = e ? e.t : 0, G = guideFor(e);
  const it = (txt, k, why) => `<li>${txt} ${tag(k)}${why ? `<br><span class="tiny muted">${why}</span>` : ''}</li>`;
  const wk = t <= 7 ? '<b>This week.</b> ' : '';
  const sec = (title, items, open) => `<details class="care" ${open ? 'open' : ''}><summary>${title}</summary><ul class="guide">${items.join('')}</ul></details>`;
  return `<div class="card"><div class="row between"><h2>Care guide · day ${t}</h2><span class="tiny muted">tap a topic</span></div>
${sec('For you tonight', G.map(x => it(x.txt, x.k, 'Why: ' + x.why)), true)}
${sec('Sunscreen: how much and how often', [
    it('<b>How much:</b> about a quarter teaspoon (1.25 mL) for the face alone, or two full finger-lengths for face and neck. This is close to the 2 mg/cm² used to test SPF. Most people put on about half of that, and then the real protection is far below the label.', 'lit'),
    it('<b>Which one:</b> broad spectrum, SPF 30 or higher (PA+++ or higher on Asian labels). A tinted sunscreen with iron oxides also blocks visible light, which can darken pigment in medium to dark skin.', 'lit'),
    it('<b>When:</b> every morning, even indoors by a window. Re-apply every 2 hours outside, and after sweating or wiping your face.', 'lit'),
    it('<b>Plus:</b> a wide-brim hat or parasol outside, and shade around midday.', 'lit')], t <= 14)}
${sec('Washing and moisturising', [
    it('Lukewarm water and a mild, low-pH cleanser. Pat dry; do not rub the treated area.', 'clinic'),
    it('Moisturiser morning and night. Dryness and a tight feeling for the first few days are common after toning.', 'clinic'),
    it('If the skin feels warm on day 0 or 1, a cool pack wrapped in a cloth for about 10 minutes. Not ice straight on the skin.', 'clinic'),
    it('Makeup is usually fine from the next day if the skin is not broken. Remove it gently, without scrubbing.', 'clinic')])}
${sec('Do not', [
    it('Pick, scratch or rub crusts and dark spots. Let crusts fall off by themselves.', 'clinic'),
    it(wk + 'No sauna, hot baths, hot yoga or hard workouts. Heat keeps redness going.', 'weak'),
    it('No retinoids (retinol, tretinoin), AHA / BHA acids, scrubs, peels, or waxing on the area until your clinic says OK.', 'clinic'),
    it('No new skincare products or home beauty devices on the face until the skin settles.', 'clinic'),
    it('No sunbathing or tanning, and no long outdoor activity in the midday sun.', 'lit')])}
${sec('Daily life', [
    it('Hot kitchen, steam and hot showers: keep them short in the first days.', 'weak'),
    it('Around your period, be extra strict with sun.', 'weak', 'Small studies link this phase to more pigment.'),
    it('Alcohol and sleep: no direct study yet. The app logs them and your report checks whether they line up with your redness.', 'track'),
    it('A clean pillowcase, and keep hair and phone off the treated area.', 'clinic')])}
${sec('Contact your clinic now if', [
    it('Blisters, oozing, or pain that gets worse instead of better.', 'clinic'),
    it('Crusting that spreads, or a rash around the area.', 'clinic'),
    it('The spot looks darker than before the procedure, or the app says "Contact your clinic".', 'clinic')])}
<p class="note">Example aftercare for toning, written for this prototype. Your clinic's own instructions come first.</p></div>`;
}

V.today = () => {
  if (!S.clinic) return V.connect();
  const all = evaluate(), last = all[all.length - 1], n = todayN(), cad = cadence();
  const doneToday = last && (last.ch.date === iso(today0()) || (cad > 1 && n - last.t < cad));
  const askFollow = n >= S.clinic.visitDay && !S.clinic.follow;
  const B = briefing(last, all), G = guideFor(last), lv = last ? LV[last.lvl] : null;
  const missing = last ? n - last.t - (cad - 1) : n;
  return `<div class="card"><div class="row between"><div><div class="muted small">${proc().label.split(' (')[0]}</div><div class="big">Day ${n}</div></div>${lv ? `<span class="pill ${lv[1]}">${lv[0]}</span>` : ''}</div>
<div class="prog"><i style="width:${Math.max(0, Math.min(100, n / S.clinic.visitDay * 100))}%"></i></div><p class="small muted">${cad > 1 ? `Follow-up: check in every 3 days until day 28. Next: day ${last ? last.t + 3 : n}.` : `Clinic visit on day ${S.clinic.visitDay}.`} ${doneToday ? (cad > 1 ? '' : 'Tonight\'s check-in is done.') : '<b>Tonight\'s check-in is not done yet.</b>'}</p>
${!doneToday ? '<button data-go="check">Check in now</button>' : ''}
${missing >= 2 ? `<p class="banner">${missing} days since the last check-in. The trend is on hold until you check in.</p>` : ''}</div>
${askFollow ? `<div class="card alert"><h2>Visit day</h2><p class="small">Did you get another treatment at this visit? PIH can still show up weeks after healing, so tracking continues either way.</p>
<div class="row navrow"><button data-act="followTreated">Yes: start a new daily course</button><button class="ghost" data-act="followNone">No: every 3 days until day 28</button></div></div>` : ''}
${B ? `<div class="card"><div class="row between"><h2>AI briefing · day ${last.t}</h2><button class="small ghost" data-act="why">Why?</button></div><div class="brief">
<div><b>Where</b><span>${B.where}</span></div><div><b>Sure?</b><span>${B.conf}</span></div><div><b>Do</b><span>${B.todo}</span></div>${B.adapt ? `<div><b>Adapt</b><span>${B.adapt}</span></div>` : ''}</div>
${briefViz(last, all)}
<div id="whyBox" hidden class="note">Numbers used: redness +${r1(last.ch.m?.dEI)} and brown +${r1(last.ch.m?.dMI)} vs your normal skin (pre-procedure brown +${r1(baseBrown())}). Usual range for day ${last.t}: ${Math.round(last.b.lo * 100)} to ${Math.round(last.b.hi * 100)}% of day 0.
Comparison group: ${group().name}. Patients with outcomes in this group: ${group().n}. Under 5, the range comes from published data, not patients. Alert rules are the ones your clinic set before treatment.</div></div>` : ''}
${careHTML(last)}
<div class="card"><div class="row between"><h3>Your treatment</h3><button class="small ghost" data-go="proc">Open</button></div><p class="small muted">${esc(S.clinic.rows.map(r => r.name).join(' + '))} · ${fmt(S.clinic.date)}</p></div>`;
};
V.today_after = () => { const b = $('[data-act="why"]'); if (b) b.onclick = e => { e.stopPropagation(); $('#whyBox').hidden = !$('#whyBox').hidden; }; };

const scale = id => `<div class="scale" data-scale="${id}">${[0, 1, 2, 3].map(i => `<button aria-pressed="${i === 0}" data-v="${i}">${['None', 'Mild', 'Clear', 'Strong'][i]}</button>`).join('')}</div>`;
V.check = () => {
  if (!S.clinic) return V.connect();
  const n = todayN(), fem = S.profile.sex === 'female' && S.profile.meno !== 'yes';
  return `<p class="stepno muted small">Day ${n} check-in</p>
${isEx() ? '<p class="banner">Demo: you can try the photo analysis here, but nothing is saved. Your own check-ins start in your app.</p>' : ''}
${photoBlock('Photo', 'Dark room, flash on, rear camera, about 20 cm. Then tap the treated spot and normal skin.')}
<div class="card"><h2>What happened today</h2><div class="grid2">
<label class="f">Minutes outside<input id="outdoor" type="number" inputmode="numeric" placeholder="0"></label>
<label class="f">Sunscreen re-applied${sel('reapply', ['0', '1', '2', '3', '4+'])}</label>
<label class="f">Hat or parasol${sel('hatT', ['No', 'Yes'])}</label>
<label class="f">Drinks<input id="alcohol" type="number" inputmode="numeric" placeholder="0"></label>
<label class="f">Sleep last night (h)<input id="sleep" type="number" inputmode="decimal" placeholder="7"></label></div>
<h3>Heat and sweat</h3><div class="chips" id="heat">${[['sauna', 'Sauna / hot bath'], ['workout', 'Hard workout'], ['hotshower', 'Hot shower'], ['cooking', 'Hot kitchen']].map(([v, l]) => `<button class="chip" data-v="${v}" aria-pressed="false">${l}</button>`).join('')}</div>
<h3>Put on your skin</h3><div class="chips" id="applied">${[['moist', 'Moisturiser only'], ['retinoid', 'Retinoid'], ['acid', 'Acid / peel'], ['scrub', 'Scrub'], ['new', 'New product'], ['makeup', 'Makeup']].map(([v, l]) => `<button class="chip" data-v="${v}" aria-pressed="false">${l}</button>`).join('')}</div>
${cb('pick', false, 'Picked or rubbed a crust')}
${fem ? cb('period', false, 'On my period today') : ''}</div>
<div class="card"><h2>How it feels</h2>
<label class="f">Dryness</label>${scale('dry')}<label class="f">Stinging</label>${scale('sting')}<label class="f">Itching</label>${scale('itch')}<label class="f">Warmth</label>${scale('warm')}
${n === 7 || n === 14 ? `<label class="f">Does it look darker than before the procedure?${sel('darker', ['No', 'A little', 'Clearly'])}</label>` : ''}
<label class="f">Anything else<textarea id="note" placeholder="Free note for you and your clinic"></textarea></label></div>
<button class="wide" data-act="saveCheck">Save and get my AI briefing</button>`;
};
V.check_after = () => {
  bindPhoto();
  document.querySelectorAll('#heat,#applied').forEach(g => g.onclick = e => { const b = e.target.closest('.chip'); if (b) b.setAttribute('aria-pressed', b.getAttribute('aria-pressed') !== 'true'); });
  document.querySelectorAll('[data-scale]').forEach(g => g.onclick = e => { const b = e.target.closest('button'); if (!b) return; g.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x === b)); });
};

V.result = () => {
  const all = evaluate(), e = all[all.length - 1]; if (!e) return V.today();
  const B = briefing(e, all), G = guideFor(e), lv = LV[e.lvl], c = e.ch, m = c.m;
  return `<div class="card"><div class="row between"><h2>Day ${e.t} analysis</h2><span class="pill ${lv[1]}">${lv[0]}</span></div>
${c.img ? `<img src="${c.img}" style="width:100%;border-radius:12px" alt="Tonight's photo">` : ''}
<h3>1. Your photo</h3>${m ? `<div class="kv"><div><b>Redness vs normal</b><span>+${r1(m.dEI)}</span></div><div><b>Red area</b><span>${Math.round(m.redA)}%</span></div><div><b>Brown vs normal</b><span>+${r1(m.dMI)}</span></div></div>
<p class="small">Marked spot in the ${m.watch ? where(m) : 'photo'}: ${m.redA > 50 ? 'mostly red' : m.redA > 15 ? 'patchy redness' : 'little redness'}${m.brownA > 30 ? ', with brown areas' : ''}. Brown is ${m.dMI - baseBrown() > 2 ? '<b>above</b>' : 'not above'} your pre-procedure photo.</p>` : '<p class="small muted">No usable photo, so tonight is logged without a measurement.</p>'}
<h3>2. Versus similar patients</h3>${courseSVG(all, e.t)}<p class="small">${B.where}</p><p class="tiny muted">Group: ${group().name} · patients with outcomes: ${group().n}. Range from published data until there are 5 or more.</p>
<h3>3. What to do</h3>
<div class="brief"><div><b>Sure?</b><span>${B.conf}</span></div><div><b>Do</b><span>${B.todo}</span></div>${B.adapt ? `<div><b>Adapt</b><span>${B.adapt}</span></div>` : ''}</div>
${briefViz(e, all).replace(/<h3>The course so far<\/h3>[\s\S]*$/, '</div>')}
${e.lvl === 'crit' ? '<button data-go="report">Share report with clinic</button>' : ''}</div>
${careHTML(e)}
<button class="wide ghost" data-go="today">Done</button>`;
};

/* usual-range band + your redness and brown, days 0..visit */
function courseSVG(all, now) {
  const D = horizon(), W = 520, H = 190, pl = 34, pr = 10, pt = 10, pb = 26;
  const X = t => pl + t / D * (W - pl - pr), Y = v => pt + (1 - Math.min(Math.max(v, 0), 1.4) / 1.4) * (H - pt - pb);
  let up = '', lo = '';
  for (let t = 0; t <= D; t += .5) { const b = band(t); up += `${X(t)},${Y(b.hi)} `; lo = `${X(t)},${Y(b.lo)} ` + lo; }
  const pts = all.filter(e => e.rel != null && e.t <= D);
  let path = '', prev = null;
  pts.forEach(e => { path += (prev == null || e.t - prev > 1 ? 'M' : 'L') + X(e.t) + ',' + Y(e.rel); prev = e.t; });
  const col = { ok: 'var(--ok)', watch: 'var(--warn)', crit: 'var(--crit)', hold: 'var(--muted)' };
  const b0 = baseBrown(); let bpath = '', bprev = null;
  all.filter(e => e.ch.m && e.t <= D).forEach(e => { bpath += (bprev == null || e.t - bprev > 1 ? 'M' : 'L') + X(e.t) + ',' + Y((e.ch.m.dMI - b0) / 5 + .1); bprev = e.t; });
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Redness course versus usual range">
<polygon points="${up}${lo}" fill="var(--band)"/>
${[0, .5, 1].map(v => `<line x1="${pl}" x2="${W - pr}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--line)"/><text x="${pl - 4}" y="${Y(v) + 4}" font-size="10" text-anchor="end" fill="var(--muted)">${v * 100}%</text>`).join('')}
${[0, 3, 7, 10, D].map(t => `<text x="${X(t)}" y="${H - 8}" font-size="10" text-anchor="middle" fill="var(--muted)">d${t}</text>`).join('')}
<line x1="${X(D)}" x2="${X(D)}" y1="${pt}" y2="${H - pb}" stroke="var(--accent)" stroke-dasharray="4 3"/><text x="${X(D) - 3}" y="${pt + 10}" font-size="10" text-anchor="end" fill="var(--accent)">visit</text>
${now != null && now <= D ? `<line x1="${X(now)}" x2="${X(now)}" y1="${pt}" y2="${H - pb}" stroke="var(--ink)" stroke-width="1"/><text x="${X(now) + 3}" y="${pt + 10}" font-size="10" fill="var(--ink)">you</text>` : ''}
<path d="${bpath}" fill="none" stroke="var(--brown)" stroke-width="1.6" stroke-dasharray="3 3"/>
<path d="${path}" fill="none" stroke="var(--red)" stroke-width="2"/>
${pts.map(e => `<circle cx="${X(e.t)}" cy="${Y(e.rel)}" r="4" fill="${col[e.lvl]}" stroke="var(--surface)" stroke-width="1.5"/>`).join('')}
</svg><div class="legend"><span><i style="background:var(--band)"></i>Usual range, similar patients</span><span><i style="background:var(--red)"></i>Your redness (% of day 0)</span><span><i style="background:var(--brown)"></i>Brown vs pre-procedure</span></div>`;
}

V.course = () => {
  if (!S.clinic) return V.connect();
  const all = evaluate(), D = horizon(), V0 = S.clinic.visitDay, n = todayN(), byDay = {}; all.forEach(e => byDay[e.t] = e);
  const mx = Math.max(60, ...sorted().map(c => +c.life?.outdoor || 0));
  return `<div class="card"><h2>Day 0 to ${D}</h2>${D > V0 ? `<p class="small muted">Daily to the day ${V0} visit, then every 3 days (no new treatment).</p>` : ''}<div class="tl" style="grid-template-columns:repeat(${D + 1},1fr)">${Array.from({ length: D + 1 }, (_, t) => { const e = byDay[t]; const off = t > V0 && (t - V0) % 3 !== 0; const cls = e ? e.lvl : (off ? '' : t < n ? 'hold' : ''); return `<span class="${cls} ${t === n ? 'now' : ''} ${t === V0 ? 'visit' : ''}" title="Day ${t}">${t}</span>`; }).join('')}</div>
<div class="legend"><span><i style="background:color-mix(in srgb,var(--ok) 30%,transparent)"></i>On track</span><span><i style="background:color-mix(in srgb,var(--warn) 35%,transparent)"></i>Watch</span><span><i style="background:color-mix(in srgb,var(--crit) 40%,transparent)"></i>Contact clinic</span><span><i style="background:var(--line)"></i>Missing</span><span><i style="border:2px dashed var(--accent)"></i>Visit</span></div></div>
<div class="card"><h2>Redness and brown</h2>${courseSVG(all, n)}</div>
<div class="card"><h2>Time outside</h2><svg viewBox="0 0 520 80" width="100%">${sorted().map(c => { const t = dayN(c.date), x = 34 + t / horizon() * 476, h = (+c.life?.outdoor || 0) / mx * 60; return `<rect x="${x - 6}" y="${70 - h}" width="12" height="${h}" rx="2" fill="${(+c.life?.reapply || 0) >= 2 ? 'var(--ok)' : 'var(--warn)'}"/>`; }).join('')}<line x1="34" x2="510" y1="70" y2="70" stroke="var(--line)"/></svg>
<div class="legend"><span><i style="background:var(--ok)"></i>Re-applied sunscreen 2+ times</span><span><i style="background:var(--warn)"></i>Less</span></div></div>
<div class="card"><h2>Log</h2><div class="scroll"><table class="tbl"><tr><th>Day</th><th>Status</th><th>Red</th><th>Brown</th><th>Outside</th><th>Note</th></tr>
${all.slice().reverse().map(e => `<tr><td>${e.t}${e.ch.sim ? ' <span class="tag sim">sim</span>' : ''}</td><td>${LV[e.lvl][0]}</td><td>${r1(e.ch.m?.dEI)}</td><td>${r1(e.ch.m?.dMI)}</td><td>${e.ch.life?.outdoor ?? '-'} min</td><td>${esc(e.ch.note || '')}</td></tr>`).join('')}</table></div>
<button class="small ghost" data-act="csv">Export CSV</button></div>`;
};

function patterns(all) {
  const ch = [];
  all.forEach((e, i) => { const p = all[i - 1]; if (!p || e.rel == null || p.rel == null || e.t - p.t > 1) return; ch.push({ d: e.rel - p.rel, out: +(p.ch.life?.outdoor || 0), re: +(p.ch.life?.reapply || 0), heat: (p.ch.life?.heat || []).length > 0 }); });
  const cmp = (f, name) => { const a = ch.filter(f), b = ch.filter(x => !f(x)); if (a.length < 2 || b.length < 2) return null; const m = arr => arr.reduce((s, x) => s + x.d, 0) / arr.length; return `${name}: redness changed ${r1(m(a) * 100)} points the next day, versus ${r1(m(b) * 100)} on other days (${a.length} vs ${b.length} days).`; };
  return [cmp(x => x.out >= 60 && x.re < 2, 'After 60+ min outside without re-applying'), cmp(x => x.heat, 'After heat or sweat')].filter(Boolean);
}
V.report = () => {
  if (!S.clinic) return V.connect();
  const all = evaluate(), D = S.clinic.visitDay, n = Math.min(todayN(), D), days = all.filter(e => e.t <= n).length;
  const outDays = sorted().filter(c => (+c.life?.outdoor || 0) >= 30), kept = outDays.filter(c => (+c.life?.reapply || 0) >= 2).length;
  const last = all[all.length - 1], alerts = all.filter(e => e.lvl === 'watch' || e.lvl === 'crit');
  const P = patterns(all), o = S.outcome;
  return `<div class="card"><h2>Your report · day ${n}</h2><div class="kv"><div><b>Check-ins</b><span>${days}/${n + 1}</span></div><div><b>Sun plan kept</b><span>${outDays.length ? kept + '/' + outDays.length : '-'}</span></div><div><b>Status</b><span class="small">${last ? LV[last.lvl][0] : '-'}</span></div></div>
<p class="small">${last ? `Redness is at ${last.rel != null ? Math.round(last.rel * 100) + '% of day 0' : 'unknown'}; the usual range for day ${last.t} is ${Math.round(last.b.lo * 100)} to ${Math.round(last.b.hi * 100)}%. Brown is ${last.ch.m && last.ch.m.dMI - baseBrown() > 2 ? '<b>above</b>' : 'not above'} your pre-procedure level.` : 'No check-ins yet.'}</p>
<h3>Patterns in your log ${tag('track')}</h3>${P.length ? `<ul class="guide small">${P.map(x => `<li>${x} <b>May be coincidence</b>: few days, one person.</li>`).join('')}</ul>` : '<p class="small muted">Needs at least 2 days of each kind before showing a pattern.</p>'}</div>
<div class="card"><h2>Report for your clinic</h2><pre id="clin" class="small" style="white-space:pre-wrap;margin:0;font-family:var(--sans)">${esc(clinicText(all))}</pre>
<button data-act="share">Share with clinic</button></div>
<div class="card"><h2>Outcome at your visit</h2><p class="small muted">The clinic records this at the day ${D} visit (or later). Then the app checks whether its warnings were right, and the case joins the comparison group.</p>
${o ? `${o.after ? `<div class="imgs ba"><figure><canvas id="baB" class="photo"></canvas><figcaption>Before (clinic) <span class="tag real">real case</span> <b id="baBn"></b></figcaption></figure><figure><canvas id="baA" class="photo"></canvas><figcaption>After (clinic, ${esc(o.when)}) <b id="baAn"></b></figcaption></figure></div>
<div class="legend"><span><i style="background:#784614"></i>Browner than this photo's own clear skin (brighter half), computed live in your browser</span></div>` : ''}
<div class="ro"><b>PIH after healing</b><span>${esc(o.pih)}</span><b>Clinic note</b><span>${esc(o.note || '-')}</span></div>
${o.measured ? `<table class="tbl"><tr><th>Measured on clinic photos</th><th>Before</th><th>After</th></tr>${o.measured.map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td></tr>`).join('')}</table><p class="tiny muted">Same indices as the app, run on matched cheek areas of the real clinic photos. ${tag('you')}</p>` : ''}
<h3>Were the app's warnings right?</h3><p class="small">${alerts.length ? `The app raised ${alerts.length} warning${alerts.length > 1 ? 's' : ''} (first on day ${alerts[0].t}). Outcome: ${esc(o.pih)}. ${/^no/i.test(o.pih) ? 'Logged as warnings followed by action and no PIH. With more cases this tells us how many warnings were false alarms.' : 'Logged as a warning that came before the clinic saw it.'}` : `No warnings. Outcome: ${esc(o.pih)}.`}</p>`
      : `<div class="grid2"><label class="f">PIH after healing${sel('oPih', ['No', 'Yes', 'Unclear'])}</label><label class="f">Date<input id="oWhen" type="date" value="${iso(today0())}"></label><label class="f full">Clinic note<input id="oNote"></label></div><button class="ghost" data-act="outcome">Save outcome (clinic)</button>`}</div>`;
};
/* colour every brown pixel against this photo's own clear skin (median of the brighter half); returns brown area % */
function overlayAll(c, th = 8) {
  const W = c.width, H = c.height, ctx = c.getContext('2d'), img = ctx.getImageData(0, 0, W, H), d = img.data, M = [];
  for (let i = 0; i < d.length; i += 4) M.push(-100 * Math.log10(LUT[d[i]]));
  const rM = [...M].sort((p, q) => p - q)[Math.floor(M.length / 4)]; let n = 0, b = 0;
  for (let i = 0; i < d.length; i += 4) {
    const m = M[i / 4] - rM; if (m > 40) continue; n++;
    if (m > th) { b++; d[i] = d[i] * .45 + 120 * .55; d[i + 1] = d[i + 1] * .45 + 70 * .55; d[i + 2] = d[i + 2] * .45 + 20 * .55; }
  }
  ctx.putImageData(img, 0, 0); return b / Math.max(n, 1) * 100;
}
V.report_after = async () => {
  const o = S.outcome; if (!o?.after || !$('#baB')) return;
  for (const [id, src] of [['baB', S.clinic.markview], ['baA', o.after]]) {
    const c = toCanvas(await loadImg(src), 400), a = overlayAll(c), cv = $('#' + id); if (!cv) return;
    cv.width = c.width; cv.height = c.height; cv.getContext('2d').drawImage(c, 0, 0); $('#' + id + 'n').textContent = `· brown ${Math.round(a)}%`;
  }
};
function clinicText(all) {
  const c = S.clinic, p = S.profile, last = all[all.length - 1], al = all.filter(e => e.lvl === 'watch' || e.lvl === 'crit');
  return `PIH Guard report · ${p.name || 'Patient'} · ${c.rows.map(r => r.name).join(' + ')} on ${fmt(c.date)}
Day ${todayN()} · status: ${last ? LV[last.lvl][0] : 'no data'} · check-ins: ${all.length}
Redness: ${last?.rel != null ? Math.round(last.rel * 100) + '% of day 0 (usual ' + Math.round(last.b.lo * 100) + ' to ' + Math.round(last.b.hi * 100) + '%)' : 'n/a'}
Brown vs pre-procedure: ${last?.ch.m ? (last.ch.m.dMI - baseBrown() > 0 ? '+' : '') + r1(last.ch.m.dMI - baseBrown()) : 'n/a'}
Warnings: ${al.length ? al.map(e => 'day ' + e.t + ' ' + LV[e.lvl][0].toLowerCase()).join(', ') : 'none'}
Risk factors: ${[p.prior === 'yes' && 'prior PIH' + (p.priorWhat ? ' (' + p.priorWhat + ')' : ''), p.retinoid && 'retinoid', p.photosens && 'sun-sensitising drug', p.hormone && 'hormonal', p.job === 'outdoor' && 'outdoor job'].filter(Boolean).join(', ') || 'none reported'}
Latest patient note: ${all.filter(e => e.ch.note).slice(-1)[0]?.ch.note || '-'}`;
}

V.more = () => `<div class="card"><h2>Where the numbers come from</h2><div class="scroll"><table class="tbl"><tr><th>Item</th><th>Basis</th><th>Status</th></tr>${SOURCES.map(s => `<tr><td>${s[0]}</td><td>${s[1]}</td><td>${s[2]}</td></tr>`).join('')}</table></div></div>
<div class="card"><h2>How the AI works</h2><ul class="guide small"><li><b>Photo:</b> turns each pixel into redness and melanin indices and compares them with your own normal skin in the same photo.</li>
<li><b>Similar patients:</b> groups by procedure, skin type and PIH history, and shows how many real patients sit behind each range.</li>
<li><b>Care guide:</b> clinic aftercare plus rules triggered by your profile and tonight's log; each line shows why.</li>
<li><b>Adapt:</b> checks tonight against yesterday's plan and steps the alert level up or down.</li>
<li><b>Learn:</b> outcomes recorded at visits update the comparison group.</li></ul></div>
<div class="card">${isEx() ? '<button data-act="exitExample">Exit example, back to my app</button>' : '<button class="ghost" data-act="example">Open example patient (demo, does not touch my data)</button><button class="ghost" data-act="reset">Erase my data</button>'}</div>
<button class="wide ghost" data-go="${S.clinic ? 'today' : 'welcome'}">Back</button>`;

/* ---------- example patient: real clinic photos, simulated nightly check-ins ---------- */
function loadExample(daysIn) {
  const start = addDays(iso(today0()), -(+daysIn > 0 ? +daysIn : 9));
  S = blank(); S.example = true; S.consent = true; // in memory only; MY is untouched
  S.profile = { name: 'Example patient', age: '40s', sex: 'male', nation: 'Korea', eth: 'East Asian', job: 'mixed', prior: 'no', selfType: 'Combination' };
  S.habits = { sun: '1', outdoor: '1', workout: '2', sauna: '1', drinks: '3-6', sleepH: '6', hat: 'Rarely', makeup: 'No', actives: ['none'] };
  S.baseline = { m: { dEI: 1.2, dMI: 3.0 }, sim: true };
  S.clinic = {
    example: true, name: 'Example clinic', date: start, kind: 'toning', visitDay: 14, session: '1 of a planned course',
    dx: 'Freckles and lentigines, both cheeks', fitz: 'III (example data)',
    rows: [{ name: 'Pico toning (PicoPlus)', medium: 'Nd:YAG', wl: '1064 nm', pulse: 'Picosecond', spot: '8 mm', fluence: '0.85 J/cm²', rate: '10 Hz', energy: '427 mJ', shots: '2000' }],
    settingsNote: 'Example data: settings from the real course, shown here as one session. Pulse energy = fluence × spot area (8 mm round spot = 0.50 cm²).',
    notes: 'The real case had about 5 sessions of this setting, 2 weeks apart.',
    markview: 'assets/case_before.jpg'
  };
  // simulated nightly values: redness slow on days 3-4 after long days outside, then responds; brown creeps up on day 9 after sauna
  const red = [9.0, 6.2, 4.6, 4.9, 4.4, 2.6, null, 1.6, 1.4, 1.5], brown = [3.1, 3.0, 3.2, 3.4, 3.6, 3.5, null, 3.3, 3.6, 5.6];
  const life = [{ outdoor: 10, reapply: 0 }, { outdoor: 20, reapply: 1 }, { outdoor: 150, reapply: 0, heat: ['workout'] }, { outdoor: 90, reapply: 1 }, { outdoor: 60, reapply: 2 }, { outdoor: 40, reapply: 2 }, null, { outdoor: 30, reapply: 2 }, { outdoor: 120, reapply: 1, heat: ['sauna'] }, { outdoor: 80, reapply: 1 }];
  const feel = [{ warm: 2, sting: 1 }, { warm: 1, dry: 1 }, { dry: 2, sting: 1 }, { dry: 1 }, { dry: 1 }, {}, null, {}, { itch: 1 }, { itch: 1 }];
  const notes = ['', '', 'Long walk outside at lunch', '', '', '', '', '', 'Went to the sauna, forgot', 'Looks a bit darker on the left cheek?'];
  red.forEach((r, i) => { if (r == null) return; S.checks.push({ sim: true, date: addDays(start, i), m: { dEI: r, dMI: brown[i], redA: Math.min(100, r * 9), brownA: Math.min(100, 20 + brown[i] * 5), watch: { x: .45, y: .5 } }, q: [], life: life[i], feel: feel[i], note: notes[i] }); });
  // demo links past day 9 (?example=14): brown settles back once the sun plan is kept
  for (let i = 10; i < Math.min(+daysIn || 0, 15); i++) S.checks.push({ sim: true, date: addDays(start, i), m: { dEI: 1.3, dMI: Math.max(3.2, 5.6 - (i - 9) * 0.6), redA: 12, brownA: 40, watch: { x: .45, y: .5 } }, q: [], life: { outdoor: 40, reapply: 2, heat: [] }, feel: {}, note: '' });
  S.outcome = {
    pih: 'No new PIH. Pigment lighter than before the course', when: 'later visit, after the full course', note: 'Pink macules at the later visit, likely from a recent session', after: 'assets/case_after.jpg',
    measured: [['Brown area, left cheek', '39.7%', '27.2%'], ['Brown depth, left', '8.57', '6.14'], ['Brown area, right cheek', '51.4%', '37.4%'], ['Brown depth, right', '10.51', '6.92'], ['Red area, right', '14.3%', '19.0%']]
  };
  S.step = 'today'; render(); scrollTo(0, 0);
}
function exitExample() {
  S = MY; if (location.search) history.replaceState(null, '', location.pathname);
  S.step = myHome(); render(); scrollTo(0, 0);
}

/* ---------- actions ---------- */
const val = id => $('#' + id)?.value;
const chipsOn = id => [...document.querySelectorAll('#' + id + ' .chip[aria-pressed="true"]')].map(b => b.dataset.v);
const scaleV = id => +($(`[data-scale="${id}"] [aria-pressed="true"]`)?.dataset.v || 0);
const strip = a => ({ dEI: a.dEI, dMI: a.dMI, redA: a.redA, brownA: a.brownA, watch: a.watch });
const ACT = {
  example: () => loadExample(),
  example14: () => loadExample(14),
  exitExample,
  reset() { if (!confirmErase()) return; MY = blank(); S = MY; save(); go('welcome'); },
  consentNext() { if (!$('#consent').checked) return toast('Please agree to continue'); S.consent = true; go('p1'); },
  p1() {
    S.profile = { name: val('name'), age: val('age'), sex: val('sex'), nation: val('nation'), eth: val('eth'), job: val('job'), prior: val('prior'), priorWhat: val('priorWhat'),
      retinoid: $('#retinoid').checked, photosens: $('#photosens').checked, hormone: $('#hormone').checked, meds: val('meds'),
      meno: val('meno'), preg: val('preg'), lastPeriod: val('lastPeriod'), cycle: val('cycle'), selfType: chipsOn('selfType')[0] };
    if (!S.profile.age || !S.profile.sex) return toast('Age and sex are needed for the comparison group');
    go('p2');
  },
  p2() { S.habits = { sun: val('sun'), outdoor: val('outdoor'), workout: val('workout'), sauna: val('sauna'), drinks: val('drinks'), sleepH: val('sleepH'), hat: val('hat'), makeup: val('makeup'), actives: chipsOn('actives') }; go('baseline'); },
  baseline() { if (!CAP?.a) return toast('Take the photo and tap twice'); S.baseline = { img: thumb(CAP.c), m: strip(CAP.a), date: iso(today0()) }; go('connect'); },
  skipBase() { go('connect'); },
  link() {
    S.clinic = { name: 'Example clinic', date: iso(today0()), kind: 'toning', visitDay: 14, session: '1', dx: 'Entered by the clinic', fitz: 'entered by the clinic',
      rows: [{ name: 'Pico toning', medium: 'Nd:YAG', wl: '1064 nm', pulse: 'Picosecond', spot: 'from clinic', fluence: 'from clinic', rate: 'from clinic', energy: 'from clinic', shots: 'from clinic' }], notes: 'Demo link. In use, the settings and the pre-treatment photo come from the clinic chart.', markview: null };
    go('proc');
  },
  saveCheck() {
    const date = iso(today0());
    const c = { date, m: CAP?.a ? strip(CAP.a) : null, q: CAP?.a ? CAP.a.issues : ['no photo'], img: CAP?.a ? thumb(CAP.c) : null,
      life: { outdoor: +val('outdoor') || 0, reapply: val('reapply'), hat: val('hatT') === 'Yes', alcohol: +val('alcohol') || 0, sleep: +val('sleep') || null, heat: chipsOn('heat'), applied: chipsOn('applied'), pick: $('#pick').checked, period: !!$('#period')?.checked },
      feel: { dry: scaleV('dry'), sting: scaleV('sting'), itch: scaleV('itch'), warm: scaleV('warm'), darker: val('darker') }, note: val('note') };
    S.checks = S.checks.filter(x => x.date !== date).concat(c); go('result');
  },
  followNone() { S.clinic.follow = 'none'; save(); render(); },
  followTreated() {
    // new session: keep the finished course as history, start day 0 today
    S.history = (S.history || []).concat({ clinic: { ...S.clinic, follow: 'treated' }, checks: S.checks, outcome: S.outcome });
    S.clinic = { ...S.clinic, date: iso(today0()), follow: null, session: 'next session (data from clinic)' }; S.checks = []; S.outcome = null;
    go('proc');
  },
  outcome() { S.outcome = { pih: val('oPih'), when: val('oWhen'), note: val('oNote') }; save(); render(); },
  share() { const t = $('#clin').textContent; if (navigator.share) navigator.share({ title: 'PIH Guard report', text: t }).catch(() => { }); else navigator.clipboard?.writeText(t).then(() => toast('Copied. Paste it to your clinic.')); },
  csv() {
    const rows = [['day', 'date', 'simulated', 'redness', 'brown', 'red_area', 'outdoor_min', 'reapply', 'heat', 'applied', 'sting', 'itch', 'note']].concat(sorted().map(c => [dayN(c.date), c.date, !!c.sim, r1(c.m?.dEI), r1(c.m?.dMI), r1(c.m?.redA), c.life?.outdoor, c.life?.reapply, (c.life?.heat || []).join('|'), (c.life?.applied || []).join('|'), c.feel?.sting, c.feel?.itch, (c.note || '').replace(/,/g, ' ')]));
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([rows.map(r => r.join(',')).join('\n')], { type: 'text/csv' })); a.download = 'pih-guard.csv'; a.click();
  },
};
function toast(t) { const d = document.createElement('div'); d.className = 'toast'; d.textContent = t; document.body.appendChild(d); setTimeout(() => d.remove(), 2400); }

document.addEventListener('click', e => {
  const g = e.target.closest('[data-go]'); if (g) { e.preventDefault(); return go(g.dataset.go); }
  const a = e.target.closest('[data-act]'); if (a && ACT[a.dataset.act]) { e.preventDefault(); ACT[a.dataset.act](); }
});
$('#moreBtn').onclick = () => go('more');
$('#homeBtn').onclick = () => isEx() ? exitExample() : go(myHome());
function confirmErase() { const b = $('[data-act="reset"]'); if (b && b.dataset.sure) return true; if (b) { b.dataset.sure = 1; b.textContent = 'Tap again to erase my data'; } return false; }
// ?example opens the example patient; ?view=<screen> jumps to a screen (for demos)
const Q = new URLSearchParams(location.search);
if (Q.has('example')) loadExample(Q.get('example')); // ?example=14 opens the visit day
if (Q.get('view')) S.step = Q.get('view');
render();
