import { icon } from './icons.js';
import { db } from './db.js';

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export function num(v) {
  if (v === null || v === undefined) return null;
  const n = parseFloat(String(v).trim().replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

export function fmt(n, digits = 1) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '';
  return n.toLocaleString('de-DE', { maximumFractionDigits: digits });
}

export function fmtDate(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

// ---------- Maschenprobe & Umrechnung ----------
export function rowsPerCm(p) {
  const r = num(p.gaugeRows);
  return r && r > 0 ? r / 10 : null;
}
export function cmFromRows(p, rows) {
  const rpc = rowsPerCm(p);
  return rpc ? rows / rpc : null;
}
export function rowsFromCm(p, cm) {
  const rpc = rowsPerCm(p);
  return rpc ? Math.round(cm * rpc) : null;
}

// ---------- Erinnerungen ----------
export function reminderLabel(p, r) {
  if (!r) return '';
  if (r.type === 'cm') {
    const rows = rowsFromCm(p, r.value);
    return `bei ${fmt(r.value)} cm` + (rows !== null ? ` · etwa Reihe ${rows}` : '');
  }
  if (r.type === 'row') {
    const cm = cmFromRows(p, r.value);
    return `bei Reihe ${r.value}` + (cm !== null ? ` · etwa ${fmt(cm)} cm` : '');
  }
  if (r.type === 'repeat') {
    const start = r.start || 0;
    if (r.unit === 'cm') {
      const rows = rowsFromCm(p, r.every);
      return `alle ${fmt(r.every)} cm, ${r.times}-mal` + (start ? ` (ab ${fmt(start)} cm)` : '') + (rows !== null ? ` · etwa alle ${rows} Reihen` : '');
    }
    const cm = cmFromRows(p, r.every);
    return `in jeder ${r.every}. Reihe, ${r.times}-mal` + (start ? ` (ab Reihe ${start})` : '') + (cm !== null ? ` · etwa alle ${fmt(cm)} cm` : '');
  }
  return '';
}

// Wandelt einen Wert (in Reihen oder cm) in die Einheit des Teils um
function toUnit(p, value, from, to) {
  if (from === to) return value;
  if (from === 'row' && to === 'cm') return cmFromRows(p, value);
  if (from === 'cm' && to === 'row') return rowsFromCm(p, value);
  return null;
}

// Nächste (oder gerade erreichte) Erinnerung eines Teils
export function nextReminder(p, part) {
  const unit = part.mode === 'cm' ? 'cm' : 'row';
  const pos = unit === 'cm' ? (part.cm || 0) : (part.rows || 0);
  const tol = unit === 'cm' ? 0.5 : 1;
  let best = null;
  const consider = (c) => {
    if (!best) { best = c; return; }
    if (c.reached !== best.reached) { if (c.reached) best = c; return; }
    if (c.reached ? c.target < best.target : c.remaining < best.remaining) best = c;
  };
  for (const step of part.steps || []) {
    const r = step.reminder;
    if (step.done || !r) continue;
    if (r.type === 'cm' || r.type === 'row') {
      const t = toUnit(p, r.value, r.type, unit);
      if (t === null) continue;
      if (pos >= t - 1e-9) consider({ step, reached: true, target: t, remaining: 0, unit });
      else consider({ step, reached: false, target: t, remaining: t - pos, unit });
    } else if (r.type === 'repeat') {
      const from = r.unit === 'cm' ? 'cm' : 'row';
      for (let i = 1; i <= r.times; i++) {
        const t = toUnit(p, (r.start || 0) + r.every * i, from, unit);
        if (t === null) break;
        if (pos >= t - 1e-9 && pos < t + tol - 1e-9) { consider({ step, reached: true, target: t, remaining: 0, unit, occurrence: i, total: r.times }); break; }
        if (t > pos) { consider({ step, reached: false, target: t, remaining: t - pos, unit, occurrence: i, total: r.times }); break; }
      }
    }
  }
  return best;
}

export function stepProgress(p) {
  let done = 0, total = 0;
  for (const part of p.parts) for (const s of part.steps) { total++; if (s.done) done++; }
  return { done, total };
}

// ---------- Dateien ----------
const urlCache = new Map();
export async function storeFile(fileOrBlob, name) {
  const id = uid();
  const data = await fileOrBlob.arrayBuffer();
  await db.put('files', { id, name: name || fileOrBlob.name || '', type: fileOrBlob.type || 'application/octet-stream', data });
  return id;
}
export async function fileUrl(id) {
  if (!id) return null;
  if (urlCache.has(id)) return urlCache.get(id);
  const rec = await db.get('files', id);
  if (!rec) return null;
  const url = URL.createObjectURL(new Blob([rec.data], { type: rec.type }));
  urlCache.set(id, url);
  return url;
}
export async function deleteFile(id) {
  if (!id) return;
  if (urlCache.has(id)) { URL.revokeObjectURL(urlCache.get(id)); urlCache.delete(id); }
  await db.del('files', id);
}
export function pickFiles(inputId) {
  return new Promise((resolve) => {
    const inp = document.getElementById(inputId);
    inp.value = '';
    inp.onchange = () => resolve([...inp.files]);
    inp.click();
  });
}

// Projektfoto verkleinern, damit die Übersicht flott bleibt
export async function shrinkImage(file, max = 1200) {
  try {
    const bmp = await createImageBitmap(file);
    const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * s);
    c.height = Math.round(bmp.height * s);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise((res) => c.toBlob((b) => res(b || file), 'image/jpeg', 0.85));
  } catch (e) {
    return file;
  }
}

// ---------- Dialoge ----------
export function modal({ title, body = '', actions = [], wide = false, onMount }) {
  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.className = 'overlay';
    ov.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
      <div class="modal-head"><h2>${title}</h2><button class="icon-btn" data-close aria-label="Schließen">${icon('close')}</button></div>
      <div class="modal-body">${body}</div>
      ${actions.length ? `<div class="modal-actions">${actions.map((a, i) => `<button class="btn ${a.kind || ''}" data-i="${i}">${a.label}</button>`).join('')}</div>` : ''}
    </div>`;
    document.body.appendChild(ov);
    const el = ov.querySelector('.modal');
    const close = (v) => { ov.remove(); resolve(v); };
    ov.addEventListener('click', async (e) => {
      if (e.target.closest('[data-close]')) return close(null);
      const b = e.target.closest('[data-i]');
      if (!b) return;
      const a = actions[+b.dataset.i];
      if (a.handler) {
        const r = await a.handler(el);
        if (r === false) return;
        close(r === undefined ? a.value : r);
      } else close(a.value);
    });
    if (onMount) onMount(el, close);
  });
}

export function confirmBox(title, text, okLabel = 'OK', danger = false) {
  return modal({
    title,
    body: `<p>${text}</p>`,
    actions: [{ label: 'Abbrechen', value: false }, { label: okLabel, kind: danger ? 'danger' : 'primary', value: true }],
  }).then((v) => !!v);
}

export function promptBox(title, label, value = '', okLabel = 'Speichern') {
  return modal({
    title,
    body: `<label class="field"><span>${label}</span><input type="text" id="pb-in" value="${esc(value)}" autocomplete="off"></label>`,
    actions: [
      { label: 'Abbrechen', value: null },
      { label: okLabel, kind: 'primary', handler: (el) => { const v = el.querySelector('#pb-in').value.trim(); return v ? v : false; } },
    ],
    onMount: (el) => setTimeout(() => el.querySelector('#pb-in').focus(), 50),
  });
}

let toastTimer;
export function toast(msg) {
  let t = document.getElementById('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

// ---------- Ton ----------
let actx = null;
export function unlockAudio() {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
  } catch (e) { /* kein Ton möglich */ }
}
export function chime() {
  try {
    unlockAudio();
    if (!actx) return;
    const t = actx.currentTime;
    [[0, 784], [0.18, 1046], [0.36, 1318]].forEach(([d, f]) => {
      const o = actx.createOscillator();
      const g = actx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + d);
      g.gain.exponentialRampToValueAtTime(0.35, t + d + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.35);
      o.connect(g).connect(actx.destination);
      o.start(t + d);
      o.stop(t + d + 0.4);
    });
  } catch (e) { /* kein Ton möglich */ }
}
