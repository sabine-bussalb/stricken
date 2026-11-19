import { db } from './db.js';
import { icon } from './icons.js';
import { keepAwake } from './wakelock.js';
import { Viewer, forgetPdf, getDoc } from './viewer.js';
import { pdfLines, textLines, suggestSteps, stepFromText, detectSizes, stepForSize } from './extract.js';
import { buildBackup, readBackup, restoreBackup } from './backup.js';
import {
  uid, esc, num, fmt, fmtDate, clamp, cmFromRows, rowsFromCm, rowsPerCm, reminderLabel, nextReminder,
  stepProgress, storeFile, fileUrl, deleteFile, pickFiles, shrinkImage, modal, confirmBox, promptBox,
  toast, chime, unlockAudio,
} from './util.js';

const app = document.getElementById('app');
const STATUS = { aktiv: 'In Arbeit', geplant: 'Geplant', fertig: 'Fertig' };
const TYPE_ICON = { pdf: 'pdf', photo: 'photo', text: 'text' };
const TYPE_LABEL = { pdf: 'PDF', photo: 'Foto', text: 'Text' };
const PART_SUGGESTIONS = ['Rückenteil', 'Vorderteil', 'Linker Ärmel', 'Rechter Ärmel', 'Halsblende', 'Fertigstellen'];

const S = {
  projects: [],
  filter: 'aktiv',
  lastBackup: null,
  cleanup: null,
  returnTo: '#/',
};

// ---------- Daten ----------
function blankProject() {
  return {
    id: uid(), name: '', status: 'geplant', size: '', yarn: '', color: '', amount: '', needles: '',
    gaugeSts: '', gaugeRows: '', edge: '', notes: '', photoId: null, parts: [], currentPartId: null,
    instructions: [], view: { tab: 'pdf', sel: {} }, createdAt: Date.now(), updatedAt: Date.now(),
  };
}
function newPart(name) {
  return { id: uid(), name, mode: 'rows', rounds: false, rows: 0, cm: 0, repeat: { name: 'Wiederholung', current: 0, total: 0 }, steps: [] };
}
const getProject = (id) => S.projects.find((p) => p.id === id);
function currentPart(p) {
  return p.parts.find((x) => x.id === p.currentPartId) || p.parts[0] || null;
}
async function save(p) {
  p.updatedAt = Date.now();
  try { await db.put('projects', p); } catch (e) { toast('Speichern hat nicht geklappt. Ist der Speicher voll?'); }
}
const fileRefs = (p) => [p.photoId, ...p.instructions.map((i) => i.fileId)].filter(Boolean);
const rowWord = (part, plural) => (part.rounds ? (plural ? 'Runden' : 'Runde') : (plural ? 'Reihen' : 'Reihe'));

function posLabel(p, part) {
  if (part.mode === 'cm') return `${fmt(part.cm || 0)} cm`;
  return `${rowWord(part)} ${part.rows || 0}`;
}

function go(hash) {
  if (location.hash === hash) route(); else location.hash = hash;
}

// ---------- Start ----------
async function start() {
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener('pointerdown', unlockAudio, { once: true });
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});

  try {
    S.projects = await db.getAll('projects');
    S.lastBackup = await db.getMeta('lastBackup');
    const seeded = await db.getMeta('seeded');
    if (!seeded && !S.projects.length) {
      const p = blankProject();
      p.name = 'Socken';
      p.parts = ['Bündchen', 'Schaft', 'Ferse', 'Fuß', 'Spitze'].map((n) => { const x = newPart(n); x.rounds = true; return x; });
      p.currentPartId = p.parts[0].id;
      await save(p);
      S.projects.push(p);
    }
    if (!seeded) await db.setMeta('seeded', true);
    if (!S.projects.some((p) => p.status === 'aktiv')) {
      S.filter = S.projects.some((p) => p.status === 'geplant') ? 'geplant' : S.projects.length ? 'fertig' : 'aktiv';
    }
  } catch (e) {
    app.innerHTML = '<div class="fatal"><h1>Die Daten konnten nicht geladen werden.</h1><p>Bitte schließe die App und öffne sie neu. Im privaten Surfmodus funktioniert die App nicht.</p></div>';
    return;
  }
  window.addEventListener('hashchange', route);
  route();
}

function route() {
  if (S.cleanup) { S.cleanup(); S.cleanup = null; }
  keepAwake(false);
  app.onclick = null; app.oninput = null; app.onchange = null;
  document.querySelectorAll('.overlay').forEach((o) => o.remove());
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  window.scrollTo(0, 0);
  if (parts[0] === 'neu') return renderForm(null);
  if (parts[0] === 'projekt' && parts[1]) {
    const p = getProject(parts[1]);
    if (!p) return go('#/');
    if (parts[2] === 'bearbeiten') return renderForm(p);
    if (parts[2] === 'fahrplan') return renderPlan(p);
    return renderKnit(p);
  }
  return renderList();
}

// =====================================================================
// BILDSCHIRM 1: MEINE PROJEKTE
// =====================================================================
function backupLine() {
  return S.lastBackup ? `Letzte Sicherung: ${fmtDate(S.lastBackup)}` : 'Noch keine Sicherung erstellt';
}

function renderList() {
  const counts = { aktiv: 0, geplant: 0, fertig: 0 };
  S.projects.forEach((p) => { counts[p.status] = (counts[p.status] || 0) + 1; });
  const list = S.projects.filter((p) => p.status === S.filter).sort((a, b) => b.updatedAt - a.updatedAt);
  const days = S.lastBackup ? Math.floor((Date.now() - S.lastBackup) / 864e5) : null;
  const hint = S.projects.length && (days === null || days >= 14)
    ? `<div class="hint-bar">${icon('shield')}<span>${days === null ? 'Du hast noch keine Sicherung erstellt.' : `Deine letzte Sicherung ist ${days} Tage her.`} Eine Sicherung schützt deine Projekte, falls mit dem iPad etwas passiert.</span><button class="btn small" data-act="backup">Jetzt sichern</button></div>`
    : '';

  app.innerHTML = `
  <div class="screen">
    <header class="topbar">
      <div class="topbar-title"><h1>Meine Projekte</h1><div class="sub">${backupLine()}</div></div>
      <button class="btn" data-act="backup">${icon('shield')}<span>Sicherung</span></button>
      <button class="btn primary" data-act="new">${icon('plus')}<span>Neues Projekt</span></button>
    </header>
    <main class="scroll list-main">
      ${hint}
      <div class="segmented filter">${Object.keys(STATUS).map((s) => `<button class="${S.filter === s ? 'on' : ''}" data-filter="${s}">${STATUS[s]}<span class="count">${counts[s] || 0}</span></button>`).join('')}</div>
      ${list.length ? `<div class="cards">${list.map(cardHtml).join('')}</div>` : `
        <div class="empty">${icon('yarn', 'big')}<p>Hier ist noch nichts. ${S.filter === 'fertig' ? 'Fertige Projekte erscheinen hier.' : 'Lege ein neues Projekt an.'}</p>
        ${S.filter !== 'fertig' ? `<button class="btn primary" data-act="new">${icon('plus')}<span>Neues Projekt</span></button>` : ''}</div>`}
    </main>
  </div>`;

  app.querySelectorAll('[data-thumb]').forEach(async (el) => {
    const url = await fileUrl(el.dataset.thumb);
    if (url) el.innerHTML = `<img src="${url}" alt="">`;
  });

  app.onclick = async (e) => {
    const t = e.target;
    const f = t.closest('[data-filter]');
    if (f) { S.filter = f.dataset.filter; return renderList(); }
    const act = t.closest('[data-act]');
    if (act) {
      if (act.dataset.act === 'new') { S.returnTo = '#/'; return go('#/neu'); }
      if (act.dataset.act === 'backup') return backupDialog();
    }
    const ed = t.closest('[data-edit]');
    if (ed) { S.returnTo = '#/'; return go(`#/projekt/${ed.dataset.edit}/bearbeiten`); }
    const du = t.closest('[data-dup]');
    if (du) return duplicateProject(getProject(du.dataset.dup));
    const de = t.closest('[data-del]');
    if (de) return deleteProject(getProject(de.dataset.del));
    const op = t.closest('[data-open]');
    if (op) return go(`#/projekt/${op.dataset.open}`);
  };
}

function cardHtml(p) {
  const part = currentPart(p);
  const { done, total } = stepProgress(p);
  const pct = total ? Math.round((done / total) * 100) : 0;
  const meta = [p.yarn, p.size && `Größe ${p.size}`].filter(Boolean).join(' · ');
  return `<article class="card project-card" data-open="${p.id}">
    <div class="thumb" ${p.photoId ? `data-thumb="${p.photoId}"` : ''}>${icon('yarn')}</div>
    <div class="card-body">
      <span class="status-pill s-${p.status}">${STATUS[p.status]}</span>
      <h2>${esc(p.name || 'Ohne Namen')}</h2>
      <div class="meta">${esc(meta) || '&nbsp;'}</div>
      <div class="part-line">${icon('layers')}<span>${part ? `${esc(part.name)} · ${posLabel(p, part)}` : 'Noch keine Teile'}</span></div>
      <div class="progress"><div class="bar"><span style="width:${pct}%"></span></div><span>${total ? `${done}/${total} Schritte` : 'Noch kein Fahrplan'}</span></div>
    </div>
    <div class="card-actions">
      <button class="btn small" data-edit="${p.id}">${icon('edit')}<span>Bearbeiten</span></button>
      <button class="btn small" data-dup="${p.id}">${icon('copy')}<span>Duplizieren</span></button>
      <button class="btn small danger-text" data-del="${p.id}">${icon('trash')}<span>Löschen</span></button>
    </div>
  </article>`;
}

async function duplicateProject(p) {
  const c = structuredClone(p);
  c.id = uid();
  c.name = `${p.name} (Kopie)`;
  c.status = 'geplant';
  c.createdAt = Date.now();
  // Dateien mitkopieren, damit beide Projekte unabhängig bleiben
  const map = {};
  for (const fid of fileRefs(p)) {
    const rec = await db.get('files', fid);
    if (rec) { const nid = uid(); await db.put('files', { ...rec, id: nid }); map[fid] = nid; }
  }
  if (c.photoId) c.photoId = map[c.photoId] || null;
  c.instructions = c.instructions.filter((i) => !i.fileId || map[i.fileId]).map((i) => ({ ...i, id: uid(), fileId: i.fileId ? map[i.fileId] : undefined, page: 1, markers: {}, marker: 0.02 }));
  c.view = { tab: c.view?.tab || 'pdf', sel: {} };
  const partMap = {};
  c.parts = c.parts.map((x) => {
    const nid = uid();
    partMap[x.id] = nid;
    return { ...x, id: nid, rows: 0, cm: 0, repeat: { ...x.repeat, current: 0 }, steps: x.steps.map((s) => ({ ...s, id: uid(), done: false })) };
  });
  c.currentPartId = c.parts[0] ? c.parts[0].id : null;
  await save(c);
  S.projects.push(c);
  S.filter = 'geplant';
  toast('Projekt dupliziert. Die Zähler der Kopie stehen auf 0.');
  renderList();
}

async function deleteProject(p) {
  const ok = await confirmBox('Projekt löschen?', `„${esc(p.name)}“ wird mit allen Anleitungen, Fotos und Zählerständen gelöscht. Das kann nicht rückgängig gemacht werden.`, 'Endgültig löschen', true);
  if (!ok) return;
  for (const fid of fileRefs(p)) { forgetPdf(fid); await deleteFile(fid); }
  await db.del('projects', p.id);
  S.projects = S.projects.filter((x) => x.id !== p.id);
  toast('Projekt gelöscht');
  renderList();
}

// ---------- Sicherung ----------
async function backupDialog() {
  let usage = '';
  try {
    const est = await navigator.storage.estimate();
    if (est && est.usage) usage = `<p class="muted">Belegter Speicher: etwa ${fmt(est.usage / 1048576, 0)} MB</p>`;
  } catch (e) { /* egal */ }
  modal({
    title: 'Sicherung',
    body: `
      <p>Eine Sicherung speichert <strong>alle Projekte samt PDFs, Fotos und Zählerständen</strong> in einer einzigen Datei. Lege sie in der Dateien-App ab (am besten in iCloud Drive) oder schick sie per AirDrop an deinen Mac.</p>
      <p class="backup-date">${icon('shield')}<span>${backupLine()}</span></p>
      ${usage}
      <div class="stack">
        <button class="btn primary big" data-b="create">${icon('save')}<span>Sicherung erstellen</span></button>
        <button class="btn big" data-b="load">${icon('load')}<span>Sicherung laden</span></button>
      </div>`,
    onMount: (el, close) => {
      el.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-b]');
        if (!b) return;
        if (b.dataset.b === 'create') { close(); createBackupFlow(); }
        if (b.dataset.b === 'load') { const files = await pickFiles('pick-backup'); close(); if (files[0]) loadBackupFlow(files[0]); }
      });
    },
  });
}

async function createBackupFlow() {
  toast('Sicherung wird erstellt …');
  let res;
  try { res = await buildBackup(); } catch (e) { toast('Die Sicherung konnte nicht erstellt werden.'); return; }
  const mb = fmt(res.file.size / 1048576, 1);
  const canShare = !!(navigator.canShare && navigator.canShare({ files: [res.file] }));
  const markDone = async () => {
    S.lastBackup = Date.now();
    await db.setMeta('lastBackup', S.lastBackup);
    if (location.hash === '' || location.hash === '#/') renderList();
  };
  modal({
    title: 'Sicherung ist fertig',
    body: `<p>${res.projectCount} Projekte und ${res.fileCount} Dateien, zusammen ${mb} MB.</p>
      ${canShare
        ? `<p>Tippe auf „Sichern oder senden“. Im nächsten Fenster hast du die Wahl:</p>
      <ul class="plain-list">
        <li><strong>„In Dateien sichern“</strong> und einen Ordner wählen, zum Beispiel iCloud Drive.</li>
        <li><strong>„AirDrop“</strong> und deinen Mac antippen. Auf dem Mac landet die Datei im Ordner „Downloads“.</li>
      </ul>`
        : '<p>Die Datei wird im Ordner „Downloads“ gespeichert.</p>'}`,
    actions: [
      { label: 'Abbrechen', value: null },
      {
        label: canShare ? 'Sichern oder senden' : 'Herunterladen',
        kind: 'primary',
        handler: async () => {
          if (canShare) {
            try {
              await navigator.share({ files: [res.file] });
              await markDone();
              toast('Sicherung gespeichert');
              return true;
            } catch (e) {
              if (e && e.name === 'AbortError') return false;
            }
          }
          const url = URL.createObjectURL(res.file);
          const a = document.createElement('a');
          a.href = url;
          a.download = res.file.name;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 60000);
          await markDone();
          toast('Sicherung wurde in „Downloads“ gespeichert');
          return true;
        },
      },
    ],
  });
}

async function loadBackupFlow(file) {
  let parsed;
  try { parsed = await readBackup(file); } catch (e) { toast(e.message || 'Die Datei konnte nicht gelesen werden.'); return; }
  const h = parsed.header;
  const ok = await confirmBox('Sicherung laden?',
    `Die Sicherung vom <strong>${fmtDate(Date.parse(h.created))}</strong> enthält ${h.projects.length} Projekte. Alle Projekte, die jetzt auf diesem iPad sind, werden dadurch <strong>ersetzt</strong>.`,
    'Sicherung laden', true);
  if (!ok) return;
  toast('Sicherung wird geladen …');
  try {
    await restoreBackup(file, parsed);
  } catch (e) {
    toast(e.message || 'Das Laden hat nicht geklappt.');
    return;
  }
  S.projects = await db.getAll('projects');
  toast('Sicherung geladen');
  go('#/');
}

// =====================================================================
// BILDSCHIRM 2: PROJEKT ANLEGEN / BEARBEITEN
// =====================================================================
function renderForm(orig) {
  const isNew = !orig;
  const d = orig ? structuredClone(orig) : blankProject();
  const origRefs = new Set(orig ? fileRefs(orig) : []);
  const added = new Set();
  let dirty = false;

  const field = (key, label, ph = '', type = 'text', extra = '') =>
    `<label class="field"><span>${label}</span><input type="${type}" data-f="${key}" value="${esc(d[key])}" placeholder="${esc(ph)}" ${extra} autocomplete="off"></label>`;

  app.innerHTML = `
  <div class="screen">
    <header class="topbar">
      <button class="btn icon-only" data-act="cancel" aria-label="Zurück">${icon('back')}</button>
      <div class="topbar-title"><h1>${isNew ? 'Neues Projekt' : 'Projekt bearbeiten'}</h1></div>
      <button class="btn" data-act="cancel">Abbrechen</button>
      <button class="btn primary" data-act="save">${icon('check')}<span>Speichern</span></button>
    </header>
    <main class="scroll">
      <div class="form-grid">
        <section class="card form-card">
          <h2>Allgemein</h2>
          ${field('name', 'Name *', 'z. B. Pullover für Anna')}
          <div class="field"><span>Status</span>
            <div class="segmented" id="f-status">${Object.keys(STATUS).map((s) => `<button type="button" data-status="${s}" class="${d.status === s ? 'on' : ''}">${STATUS[s]}</button>`).join('')}</div>
          </div>
          ${field('size', 'Größe', 'z. B. 38/40 oder M')}
          <div class="field"><span>Projektfoto (optional)</span>
            <div class="photo-pick">
              <div class="thumb small" id="f-photo">${icon('camera')}</div>
              <button type="button" class="btn" data-act="photo">${icon('photo')}<span>Foto wählen</span></button>
              <button type="button" class="btn danger-text" data-act="photo-del" id="f-photo-del" ${d.photoId ? '' : 'hidden'}>${icon('trash')}<span>Entfernen</span></button>
            </div>
          </div>
        </section>

        <section class="card form-card">
          <h2>Garn & Nadeln</h2>
          ${field('yarn', 'Garn / Modell', 'z. B. Merino 50, Modell 12')}
          <div class="row2">
            ${field('color', 'Farbe / Farbnummer', 'z. B. Beere 0045')}
            ${field('amount', 'Menge', 'z. B. 8 Knäuel à 50 g')}
          </div>
          <div class="row2">
            ${field('needles', 'Nadeln', 'z. B. 3,5 mm Rundnadel')}
            ${field('edge', 'Rand', 'z. B. Kettrand')}
          </div>
          <div class="field"><span>Maschenprobe auf 10 x 10 cm</span>
            <div class="gauge">
              <label><input type="text" inputmode="decimal" data-f="gaugeSts" value="${esc(d.gaugeSts)}" placeholder="22"><span>Maschen</span></label>
              <span class="x">×</span>
              <label><input type="text" inputmode="decimal" data-f="gaugeRows" value="${esc(d.gaugeRows)}" placeholder="30"><span>Reihen</span></label>
            </div>
            <small class="muted">Die Reihen brauchst du, damit die App Reihen und cm ineinander umrechnen kann.</small>
          </div>
        </section>

        <section class="card form-card">
          <h2>Teile</h2>
          <p class="muted">Jedes Teil hat seinen eigenen Zähler und Fahrplan.</p>
          <ul class="part-list" id="f-parts"></ul>
          <div class="add-row">
            <input type="text" id="f-newpart" placeholder="Neues Teil, z. B. Rückenteil" autocomplete="off">
            <button type="button" class="btn" data-act="part-add">${icon('plus')}<span>Hinzufügen</span></button>
          </div>
          <div class="chips">${PART_SUGGESTIONS.map((s) => `<button type="button" class="chip" data-sugg="${esc(s)}">+ ${esc(s)}</button>`).join('')}</div>
        </section>

        <section class="card form-card">
          <h2>Anleitungen</h2>
          <div id="f-instr"></div>
        </section>

        <section class="card form-card full">
          <h2>Notizen</h2>
          <textarea data-f="notes" rows="5" placeholder="Alles, was du dir merken willst">${esc(d.notes)}</textarea>
        </section>
      </div>
    </main>
  </div>`;

  const showPhoto = async () => {
    const el = app.querySelector('#f-photo');
    const url = d.photoId ? await fileUrl(d.photoId) : null;
    el.innerHTML = url ? `<img src="${url}" alt="">` : icon('camera');
    app.querySelector('#f-photo-del').hidden = !d.photoId;
  };
  const renderParts = () => {
    app.querySelector('#f-parts').innerHTML = d.parts.length ? d.parts.map((x, i) => `
      <li>
        <input type="text" value="${esc(x.name)}" data-pname="${x.id}" aria-label="Name des Teils">
        <button type="button" class="icon-btn" data-pmove="${x.id}" data-dir="-1" ${i === 0 ? 'disabled' : ''} aria-label="Nach oben">${icon('up')}</button>
        <button type="button" class="icon-btn" data-pmove="${x.id}" data-dir="1" ${i === d.parts.length - 1 ? 'disabled' : ''} aria-label="Nach unten">${icon('down')}</button>
        <button type="button" class="icon-btn danger-text" data-pdel="${x.id}" aria-label="Teil löschen">${icon('trash')}</button>
      </li>`).join('') : '<li class="muted">Noch keine Teile. Wenn du keine anlegst, gibt es ein Teil „Teil 1“.</li>';
  };
  const renderInstr = () => { app.querySelector('#f-instr').innerHTML = instrListHtml(d, false); };
  showPhoto(); renderParts(); renderInstr();

  const addPart = (name) => {
    name = name.trim();
    if (!name) return;
    d.parts.push(newPart(name));
    dirty = true;
    renderParts();
  };

  app.oninput = (e) => {
    const f = e.target.dataset.f;
    if (f) { d[f] = e.target.value; dirty = true; }
    const pn = e.target.dataset.pname;
    if (pn) { const x = d.parts.find((y) => y.id === pn); if (x) { x.name = e.target.value; dirty = true; } }
  };
  app.querySelector('#f-newpart').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addPart(e.target.value); e.target.value = ''; }
  });

  const finishCancel = async () => {
    for (const fid of added) { if (!origRefs.has(fid)) await deleteFile(fid); }
    go(S.returnTo || '#/');
  };

  app.onclick = async (e) => {
    const t = e.target;
    const st = t.closest('[data-status]');
    if (st) {
      d.status = st.dataset.status; dirty = true;
      app.querySelectorAll('#f-status button').forEach((b) => b.classList.toggle('on', b === st));
      return;
    }
    const sg = t.closest('[data-sugg]');
    if (sg) return addPart(sg.dataset.sugg);
    const pm = t.closest('[data-pmove]');
    if (pm) {
      const i = d.parts.findIndex((x) => x.id === pm.dataset.pmove);
      const j = i + Number(pm.dataset.dir);
      if (j >= 0 && j < d.parts.length) { [d.parts[i], d.parts[j]] = [d.parts[j], d.parts[i]]; dirty = true; renderParts(); }
      return;
    }
    const pd = t.closest('[data-pdel]');
    if (pd) {
      const x = d.parts.find((y) => y.id === pd.dataset.pdel);
      const hasData = x.rows || x.cm || x.steps.length;
      if (hasData && !(await confirmBox('Teil löschen?', `„${esc(x.name)}“ hat schon einen Zählerstand oder Schritte. Wirklich löschen?`, 'Löschen', true))) return;
      d.parts = d.parts.filter((y) => y !== x);
      dirty = true;
      return renderParts();
    }
    const ia = t.closest('[data-iadd]');
    if (ia) {
      const ids = await addInstruction(d, ia.dataset.iadd);
      ids.forEach((id) => added.add(id));
      if (ids.length || ia.dataset.iadd === 'text') dirty = true;
      return renderInstr();
    }
    const ie = t.closest('[data-iedit]');
    if (ie) { if (await editInstruction(d, ie.dataset.iedit)) { dirty = true; renderInstr(); } return; }
    const idl = t.closest('[data-idel]');
    if (idl) {
      const ins = d.instructions.find((i) => i.id === idl.dataset.idel);
      if (await confirmBox('Anleitung entfernen?', `„${esc(ins.title)}“ wird aus dem Projekt entfernt.`, 'Entfernen', true)) {
        d.instructions = d.instructions.filter((i) => i !== ins);
        dirty = true;
        renderInstr();
      }
      return;
    }
    const act = t.closest('[data-act]');
    if (!act) return;
    switch (act.dataset.act) {
      case 'part-add': {
        const inp = app.querySelector('#f-newpart');
        addPart(inp.value); inp.value = '';
        break;
      }
      case 'photo': {
        const files = await pickFiles('pick-photo-single');
        if (!files[0]) return;
        const id = await storeFile(await shrinkImage(files[0]), files[0].name);
        added.add(id);
        d.photoId = id; dirty = true;
        showPhoto();
        break;
      }
      case 'photo-del': d.photoId = null; dirty = true; showPhoto(); break;
      case 'cancel':
        if (dirty && !(await confirmBox('Änderungen verwerfen?', 'Deine Änderungen an diesem Projekt werden nicht gespeichert.', 'Verwerfen', true))) return;
        finishCancel();
        break;
      case 'save': {
        d.name = d.name.trim();
        if (!d.name) {
          toast('Bitte gib dem Projekt einen Namen.');
          app.querySelector('[data-f="name"]').focus();
          return;
        }
        d.parts.forEach((x) => { x.name = x.name.trim() || 'Ohne Namen'; });
        if (!d.parts.length) d.parts.push(newPart('Teil 1'));
        if (!d.parts.find((x) => x.id === d.currentPartId)) d.currentPartId = d.parts[0].id;
        const keep = new Set(fileRefs(d));
        for (const fid of new Set([...origRefs, ...added])) {
          if (!keep.has(fid)) { forgetPdf(fid); await deleteFile(fid); }
        }
        await save(d);
        const i = S.projects.findIndex((x) => x.id === d.id);
        if (i >= 0) S.projects[i] = d; else S.projects.push(d);
        S.filter = d.status;
        toast('Gespeichert');
        go(isNew ? `#/projekt/${d.id}` : (S.returnTo || '#/'));
        break;
      }
      default:
    }
  };
}

// ---------- Anleitungen (gemeinsam) ----------
function instrListHtml(p, openable) {
  const items = p.instructions.length ? `<ul class="instr-list">${p.instructions.map((i) => `
    <li>
      ${openable
        ? `<button class="instr-main" data-iopen="${i.id}">${icon(TYPE_ICON[i.type])}<span><strong>${esc(i.title)}</strong><small>${TYPE_LABEL[i.type]} · zum Anzeigen tippen</small></span></button>`
        : `<div class="instr-main">${icon(TYPE_ICON[i.type])}<span><strong>${esc(i.title)}</strong><small>${TYPE_LABEL[i.type]}</small></span></div>`}
      <button type="button" class="icon-btn" data-iedit="${i.id}" aria-label="Bearbeiten">${icon('edit')}</button>
      <button type="button" class="icon-btn danger-text" data-idel="${i.id}" aria-label="Entfernen">${icon('trash')}</button>
    </li>`).join('')}</ul>` : '<p class="muted">Noch keine Anleitung. Füge eine PDF, Fotos oder einen Text hinzu.</p>';
  return `${items}
    <div class="btn-row">
      <button type="button" class="btn" data-iadd="pdf">${icon('plus')}<span>PDF</span></button>
      <button type="button" class="btn" data-iadd="photo">${icon('plus')}<span>Foto</span></button>
      <button type="button" class="btn" data-iadd="text">${icon('plus')}<span>Text</span></button>
    </div>`;
}

// Fügt Anleitungen hinzu, gibt die neu gespeicherten Datei-IDs zurück
async function addInstruction(p, type) {
  const ids = [];
  if (type === 'pdf') {
    const files = await pickFiles('pick-pdf');
    for (const f of files) {
      if (!/pdf/i.test(f.type) && !/\.pdf$/i.test(f.name)) { toast(`„${f.name}“ ist keine PDF-Datei.`); continue; }
      const id = await storeFile(f);
      ids.push(id);
      const ins = { id: uid(), type: 'pdf', title: f.name.replace(/\.pdf$/i, '') || 'Anleitung', fileId: id, page: 1, zoom: 1, markers: {} };
      p.instructions.push(ins);
      p.view = p.view || { sel: {} };
      p.view.tab = 'pdf';
      p.view.sel = { ...(p.view.sel || {}), pdf: ins.id };
    }
  } else if (type === 'photo') {
    const files = await pickFiles('pick-photo');
    let n = p.instructions.filter((i) => i.type === 'photo').length;
    for (const f of files) {
      if (!/^image\//.test(f.type) && !/\.(jpe?g|png|heic|webp|gif)$/i.test(f.name)) { toast(`„${f.name}“ ist kein Foto.`); continue; }
      const id = await storeFile(f);
      ids.push(id);
      n += 1;
      const ins = { id: uid(), type: 'photo', title: `Foto ${n}`, fileId: id, zoom: 1, marker: 0.02 };
      p.instructions.push(ins);
      p.view = p.view || { sel: {} };
      p.view.tab = 'photo';
      p.view.sel = { ...(p.view.sel || {}), photo: ins.id };
    }
  } else if (type === 'text') {
    const r = await textDialog('Text-Anleitung hinzufügen', '', '');
    if (r) {
      const ins = { id: uid(), type: 'text', title: r.title, text: r.text, zoom: 1, marker: 0.02 };
      p.instructions.push(ins);
      p.view = p.view || { sel: {} };
      p.view.tab = 'text';
      p.view.sel = { ...(p.view.sel || {}), text: ins.id };
    }
  }
  if (ids.length) toast(ids.length === 1 ? 'Hinzugefügt' : `${ids.length} hinzugefügt`);
  return ids;
}

function textDialog(title, t, text) {
  return modal({
    title,
    wide: true,
    body: `<label class="field"><span>Titel</span><input type="text" id="td-title" value="${esc(t)}" placeholder="z. B. Muster Rückenteil"></label>
      <label class="field"><span>Text</span><textarea id="td-text" rows="12" placeholder="Anleitung hier eintippen oder einfügen">${esc(text)}</textarea></label>`,
    actions: [
      { label: 'Abbrechen', value: null },
      {
        label: 'Speichern', kind: 'primary',
        handler: (el) => {
          const tt = el.querySelector('#td-title').value.trim() || 'Text';
          const tx = el.querySelector('#td-text').value;
          if (!tx.trim()) { toast('Bitte gib einen Text ein.'); return false; }
          return { title: tt, text: tx };
        },
      },
    ],
  });
}

async function editInstruction(p, id) {
  const ins = p.instructions.find((i) => i.id === id);
  if (!ins) return false;
  if (ins.type === 'text') {
    const r = await textDialog('Text bearbeiten', ins.title, ins.text);
    if (!r) return false;
    ins.title = r.title; ins.text = r.text;
    return true;
  }
  const n = await promptBox('Anleitung umbenennen', 'Titel', ins.title);
  if (!n) return false;
  ins.title = n;
  return true;
}

// =====================================================================
// STRICKEN & FAHRPLAN: gemeinsamer Rahmen
// =====================================================================
function ensurePart(p) {
  if (!p.parts.length) { p.parts.push(newPart('Teil 1')); save(p); }
  if (!p.parts.find((x) => x.id === p.currentPartId)) p.currentPartId = p.parts[0].id;
  return currentPart(p);
}

function knitTopbar(p, part, mode) {
  return `<header class="topbar">
    <button class="btn icon-only" data-act="home" aria-label="Zurück zu den Projekten">${icon('back')}</button>
    <div class="topbar-title"><h1>${esc(p.name)}</h1><div class="sub">Aktuelles Teil: <strong id="tb-part">${esc(part.name)}</strong></div></div>
    <div class="segmented top-switch">
      <button data-act="to-knit" class="${mode === 'knit' ? 'on' : ''}">Stricken</button>
      <button data-act="to-plan" class="${mode === 'plan' ? 'on' : ''}">Fahrplan & Notizen</button>
    </div>
    <button class="btn" data-act="switch-part">${icon('layers')}<span>Teil wechseln</span></button>
  </header>`;
}

async function switchPartDialog(p, onDone) {
  const r = await modal({
    title: 'Teil wechseln',
    body: `<div class="stack">${p.parts.map((x) => `
      <button class="btn big part-choice ${x.id === p.currentPartId ? 'on' : ''}" data-pick="${x.id}">
        <span class="pc-name">${esc(x.name)}</span><span class="pc-pos">${posLabel(p, x)}</span>
      </button>`).join('')}
      <button class="btn big" data-pick="__new">${icon('plus')}<span>Neues Teil anlegen</span></button></div>`,
    onMount: (el, close) => el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-pick]');
      if (b) close(b.dataset.pick);
    }),
  });
  if (!r) return;
  if (r === '__new') {
    const name = await promptBox('Neues Teil', 'Name des Teils', '', 'Anlegen');
    if (!name) return;
    const x = newPart(name);
    p.parts.push(x);
    p.currentPartId = x.id;
  } else p.currentPartId = r;
  await save(p);
  onDone();
}

function commonTopActions(p, act, rerender) {
  switch (act) {
    case 'home': go('#/'); return true;
    case 'to-knit': go(`#/projekt/${p.id}`); return true;
    case 'to-plan': go(`#/projekt/${p.id}/fahrplan`); return true;
    case 'switch-part': switchPartDialog(p, rerender); return true;
    default: return false;
  }
}

// =====================================================================
// BILDSCHIRM 3: STRICKEN
// =====================================================================
function renderKnit(p) {
  let part = ensurePart(p);
  keepAwake(true);
  if (p.status === 'geplant' && (part.rows || part.cm)) p.status = 'aktiv';

  app.innerHTML = `
  <div class="screen knit-screen">
    ${knitTopbar(p, part, 'knit')}
    <div class="knit-layout">
      <section class="pane instr-pane" id="instr-pane"></section>
      <section class="pane counter-pane" id="counter-pane"></section>
    </div>
  </div>`;

  const viewer = new Viewer(app.querySelector('#instr-pane'), p, {
    save: () => save(p),
    add: async (type) => { await addInstruction(p, type); await save(p); },
    takeText: async (txt) => {
      const cp0 = currentPart(p);
      const st = { id: uid(), ...stepFromText(txt), done: false, reminder: null };
      if (await stepDialog(p, cp0, st, true)) {
        cp0.steps.push(st);
        await save(p);
        toast(`Schritt für „${cp0.name}“ übernommen`);
        renderCounter();
      }
    },
  });

  const cp = app.querySelector('#counter-pane');
  const reachedKey = (r) => (r && r.reached ? `${r.step.id}:${r.occurrence || 0}` : null);
  let lastKey = reachedKey(nextReminder(p, part));

  const renderCounter = () => {
    part = currentPart(p);
    app.querySelector('#tb-part').textContent = part.name;
    const rows = part.rows || 0;
    const cmMode = part.mode === 'cm';
    const rem = nextReminder(p, part);
    const steps = part.steps;
    const curStep = steps.find((s) => !s.done);
    const rpc = rowsPerCm(p);

    let counter;
    if (!cmMode) {
      const cm = cmFromRows(p, rows);
      const nextRow = rows + 1;
      counter = `
        <div class="count-block">
          <div class="count-label">${part.rounds ? 'Runden' : 'Reihen'} gestrickt</div>
          <div class="big-number">${rows}</div>
          <div class="count-info">
            ${part.rounds ? `<span class="pill">Als Nächstes: Runde ${nextRow}</span>`
              : `<span class="pill ${nextRow % 2 ? 'hin' : 'rueck'}">Als Nächstes: ${nextRow % 2 ? 'Hinreihe' : 'Rückreihe'}</span>`}
            <span class="muted">${cm !== null ? `≈ ${fmt(cm)} cm` : 'cm: Maschenprobe fehlt'}</span>
          </div>
        </div>
        <button class="btn-huge" data-c="plus">${icon('plus')}<span>1 ${part.rounds ? 'Runde' : 'Reihe'}</span></button>
        <div class="btn-row two">
          <button class="btn" data-c="minus">${icon('minus')}<span>1 ${part.rounds ? 'Runde' : 'Reihe'}</span></button>
          <button class="btn" data-c="reset">${icon('reset')}<span>Auf 0 setzen</span></button>
        </div>`;
    } else {
      const r2 = rowsFromCm(p, part.cm || 0);
      counter = `
        <div class="count-block">
          <div class="count-label">Gemessen</div>
          <div class="big-number cm"><input type="text" inputmode="decimal" id="cm-input" value="${fmt(part.cm || 0)}" aria-label="Gemessene cm"><span>cm</span></div>
          <div class="count-info"><span class="muted">${r2 !== null ? `≈ ${rowWord(part)} ${r2}` : `${rowWord(part, true)}: Maschenprobe fehlt`} · Zahl antippen zum Eintippen</span></div>
        </div>
        <div class="btn-row two">
          <button class="btn big" data-c="cm-minus">${icon('minus')}<span>0,5 cm</span></button>
          <button class="btn primary big" data-c="cm-plus">${icon('plus')}<span>0,5 cm</span></button>
        </div>
        <div class="btn-row"><button class="btn" data-c="reset">${icon('reset')}<span>Auf 0 setzen</span></button></div>`;
    }

    const rp = part.repeat || { name: 'Wiederholung', current: 0, total: 0 };
    const repeat = `
      <div class="card repeat-card">
        <button class="repeat-name" data-c="rep-edit">${icon('repeat')}<span>${esc(rp.name)}</span>${icon('edit', 'faint')}</button>
        <div class="repeat-row">
          <button class="btn round-btn" data-c="rep-minus" aria-label="Eins zurück">${icon('minus')}</button>
          <div class="repeat-val"><strong>${rp.current}</strong>${rp.total ? `<span> von ${rp.total}</span>` : ''}</div>
          <button class="btn round-btn primary" data-c="rep-plus" aria-label="Eins weiter">${icon('plus')}</button>
        </div>
        ${rp.total && rp.current >= rp.total ? '<div class="repeat-done">Geschafft! Alle Wiederholungen erledigt.</div>' : ''}
      </div>`;

    let remCard;
    if (rem) {
      const unitWord = rem.unit === 'cm' ? 'cm' : rowWord(part, true);
      const remaining = rem.unit === 'cm' ? `${fmt(rem.remaining)} cm` : `${Math.round(rem.remaining)} ${rem.remaining === 1 ? rowWord(part) : unitWord}`;
      const occ = rem.occurrence ? `<span class="pill">${rem.occurrence}. von ${rem.total}</span>` : '';
      remCard = rem.reached ? `
        <div class="card reminder-card reached">
          <div class="rem-head">${icon('bell')}<span>Jetzt ist es so weit!</span>${occ}</div>
          <div class="rem-title">${esc(rem.step.title)}</div>
          ${rem.step.desc ? `<p class="rem-desc">${esc(rem.step.desc)}</p>` : ''}
          <div class="rem-sub">${reminderLabel(p, rem.step.reminder)}</div>
          <button class="btn light" data-c="step-done" data-step="${rem.step.id}">${icon('check')}<span>Schritt erledigt</span></button>
        </div>` : `
        <div class="card reminder-card">
          <div class="rem-head">${icon('bell')}<span>Nächste Erinnerung</span>${occ}</div>
          <div class="rem-title">${esc(rem.step.title)}</div>
          <div class="rem-remaining">Noch ${remaining}</div>
          <div class="rem-sub">${reminderLabel(p, rem.step.reminder)}</div>
        </div>`;
    } else {
      const noGauge = !rpc && steps.some((s) => !s.done && s.reminder);
      remCard = `<div class="card reminder-card empty">
        <div class="rem-head">${icon('bell')}<span>Erinnerungen</span></div>
        <p class="muted">${noGauge ? 'Für die Umrechnung zwischen cm und Reihen fehlt die Maschenprobe (Reihen auf 10 cm).' : 'Keine offene Erinnerung für dieses Teil. Im Fahrplan kannst du welche anlegen.'}</p>
      </div>`;
    }

    const stepCard = curStep ? `
      <div class="card step-now">
        <div class="here">Hier bist du · ${steps.filter((s) => s.done).length + 1}/${steps.length}</div>
        <div class="step-now-row"><strong>${esc(curStep.title)}</strong>
        <button class="btn small" data-c="step-done" data-step="${curStep.id}">${icon('check')}<span>Erledigt</span></button></div>
      </div>` : '';

    cp.innerHTML = `
      <div class="counter-top">
        <div class="segmented small mode-switch">
          <button data-c="mode-rows" class="${!cmMode ? 'on' : ''}">${part.rounds ? 'Runden' : 'Reihen'} zählen</button>
          <button data-c="mode-cm" class="${cmMode ? 'on' : ''}">Nach cm</button>
        </div>
        <button class="chip ${part.rounds ? 'on' : ''}" data-c="rounds" aria-pressed="${part.rounds}">In Runden</button>
      </div>
      <div class="counter-grid">
        <div class="counter-main">${counter}</div>
        <div class="counter-side">${remCard}${stepCard}${repeat}</div>
      </div>`;

    const inp = cp.querySelector('#cm-input');
    if (inp) {
      inp.addEventListener('focus', () => inp.select());
      inp.addEventListener('change', () => {
        const v = num(inp.value);
        if (v === null || v < 0) { inp.value = fmt(part.cm || 0); return; }
        part.cm = Math.round(v * 10) / 10;
        changed();
      });
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
    }
  };

  const changed = () => {
    if (p.status === 'geplant') p.status = 'aktiv';
    save(p);
    const rem = nextReminder(p, part);
    const k = reachedKey(rem);
    if (k && k !== lastKey) chime();
    lastKey = k;
    renderCounter();
  };

  cp.onclick = async (e) => {
    const b = e.target.closest('[data-c]');
    if (!b) return;
    switch (b.dataset.c) {
      case 'plus': part.rows = (part.rows || 0) + 1; changed(); break;
      case 'minus': if ((part.rows || 0) > 0) { part.rows -= 1; changed(); } break;
      case 'cm-plus': part.cm = Math.round(((part.cm || 0) + 0.5) * 10) / 10; changed(); break;
      case 'cm-minus': part.cm = Math.max(0, Math.round(((part.cm || 0) - 0.5) * 10) / 10); changed(); break;
      case 'reset':
        if (await confirmBox('Auf 0 setzen?', `Der Zähler für „${esc(part.name)}“ wird auf 0 gesetzt.`, 'Auf 0 setzen', true)) {
          if (part.mode === 'cm') part.cm = 0; else part.rows = 0;
          changed();
        }
        break;
      case 'mode-rows': part.mode = 'rows'; lastKey = reachedKey(nextReminder(p, part)); save(p); renderCounter(); break;
      case 'mode-cm': part.mode = 'cm'; lastKey = reachedKey(nextReminder(p, part)); save(p); renderCounter(); break;
      case 'rounds': part.rounds = !part.rounds; save(p); renderCounter(); break;
      case 'rep-plus': part.repeat.current += 1; save(p); renderCounter(); break;
      case 'rep-minus': part.repeat.current = Math.max(0, part.repeat.current - 1); save(p); renderCounter(); break;
      case 'rep-edit': await repeatDialog(p, part); renderCounter(); break;
      case 'step-done': {
        const s = part.steps.find((x) => x.id === b.dataset.step);
        if (s) { s.done = true; save(p); lastKey = reachedKey(nextReminder(p, part)); toast(`„${s.title}“ erledigt`); renderCounter(); }
        break;
      }
      default:
    }
  };

  app.onclick = (e) => {
    const a = e.target.closest('.topbar [data-act]');
    if (a) commonTopActions(p, a.dataset.act, () => { part = currentPart(p); lastKey = reachedKey(nextReminder(p, part)); renderCounter(); });
  };

  renderCounter();
  S.cleanup = () => { viewer.destroy(); cp.onclick = null; };
}

async function repeatDialog(p, part) {
  const rp = part.repeat;
  await modal({
    title: 'Wiederholungs-Zähler',
    body: `<label class="field"><span>Name</span><input type="text" id="rd-name" value="${esc(rp.name)}" placeholder="z. B. Abnahmen Armausschnitt"></label>
      <div class="row2">
        <label class="field"><span>Stand</span><input type="text" inputmode="numeric" id="rd-cur" value="${rp.current}"></label>
        <label class="field"><span>Wie oft insgesamt? (0 = ohne Ziel)</span><input type="text" inputmode="numeric" id="rd-total" value="${rp.total || 0}"></label>
      </div>`,
    actions: [
      { label: 'Abbrechen', value: null },
      {
        label: 'Speichern', kind: 'primary',
        handler: (el) => {
          rp.name = el.querySelector('#rd-name').value.trim() || 'Wiederholung';
          rp.current = Math.max(0, Math.round(num(el.querySelector('#rd-cur').value) || 0));
          rp.total = Math.max(0, Math.round(num(el.querySelector('#rd-total').value) || 0));
          save(p);
          return true;
        },
      },
    ],
  });
}

// =====================================================================
// BILDSCHIRM 4: FAHRPLAN & NOTIZEN
// =====================================================================
function renderPlan(p) {
  let part = ensurePart(p);
  keepAwake(true);
  let sorting = false;

  app.innerHTML = `
  <div class="screen plan-screen">
    ${knitTopbar(p, part, 'plan')}
    <div class="plan-layout">
      <section class="pane scroll" id="plan-left"></section>
      <section class="pane scroll" id="plan-right"></section>
    </div>
  </div>`;
  const left = app.querySelector('#plan-left');
  const right = app.querySelector('#plan-right');

  const renderLeft = () => {
    part = currentPart(p);
    app.querySelector('#tb-part').textContent = part.name;
    const steps = part.steps;
    const done = steps.filter((s) => s.done).length;
    const curIdx = steps.findIndex((s) => !s.done);
    left.innerHTML = `
      <div class="chips part-chips">${p.parts.map((x) => `<button class="chip ${x.id === part.id ? 'on' : ''}" data-part="${x.id}">${esc(x.name)}</button>`).join('')}
        <button class="chip" data-a="part-new">${icon('plus')} Teil</button></div>
      <div class="plan-head">
        <h2>Fahrplan · ${esc(part.name)}</h2>
        <span class="pill">${done}/${steps.length}</span>
        ${steps.length > 1 ? `<button class="btn small ${sorting ? 'primary' : ''}" data-a="sort">${icon('sort')}<span>${sorting ? 'Fertig' : 'Sortieren'}</span></button>` : ''}
      </div>
      ${steps.length ? `<ol class="steps">${steps.map((s, i) => {
        const cls = s.done ? 'done' : i === curIdx ? 'current' : 'open';
        return `<li class="step ${cls}">
          <button class="step-check" data-toggle="${s.id}" aria-label="${s.done ? 'Als offen markieren' : 'Als erledigt markieren'}">${s.done ? icon('check') : `<span>${i + 1}</span>`}</button>
          <div class="step-main" data-sedit="${s.id}">
            ${cls === 'current' ? '<span class="here">Hier bist du</span>' : ''}
            <h3>${esc(s.title)}</h3>
            ${s.desc ? `<p>${esc(s.desc)}</p>` : ''}
            ${s.reminder ? `<span class="rem-chip">${icon('bell')}<span>${reminderLabel(p, s.reminder)}</span></span>` : ''}
          </div>
          ${sorting
            ? `<div class="sort-btns"><button class="icon-btn" data-smove="${s.id}" data-dir="-1" ${i === 0 ? 'disabled' : ''} aria-label="Nach oben">${icon('up')}</button>
               <button class="icon-btn" data-smove="${s.id}" data-dir="1" ${i === steps.length - 1 ? 'disabled' : ''} aria-label="Nach unten">${icon('down')}</button></div>`
            : `<button class="icon-btn" data-sedit="${s.id}" aria-label="Schritt bearbeiten">${icon('edit')}</button>`}
        </li>`;
      }).join('')}</ol>` : `<div class="empty small">${icon('list', 'big')}<p>Noch keine Schritte für „${esc(part.name)}“. Lege die Schritte aus deiner Anleitung an, zum Beispiel „Bündchen 6 cm“ oder „Abnahmen Armausschnitt“.</p></div>`}
      <div class="plan-add">
        <button class="btn primary big" data-a="step-add">${icon('plus')}<span>Schritt hinzufügen</span></button>
        ${importSources(p).length ? `<button class="btn big" data-a="step-import">${icon('pdf')}<span>Aus Anleitung übernehmen</span></button>` : ''}
      </div>`;
  };

  const renderRight = () => {
    const g = num(p.gaugeSts) || num(p.gaugeRows) ? `${p.gaugeSts || '?'} M × ${p.gaugeRows || '?'} R auf 10 × 10 cm` : '';
    const rows = [['Garn', p.yarn], ['Farbe', p.color], ['Menge', p.amount], ['Nadeln', p.needles], ['Maschenprobe', g], ['Größe', p.size], ['Rand', p.edge]];
    right.innerHTML = `
      <div class="card">
        <div class="card-head"><h2>${icon('notes')}<span>Notizen</span></h2>
          <button class="btn small" data-a="edit-project">${icon('edit')}<span>Projekt bearbeiten</span></button></div>
        <dl class="details">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v ? esc(v) : '<span class="muted">–</span>'}</dd>`).join('')}</dl>
        <label class="field"><span>Freie Notizen</span><textarea id="plan-notes" rows="6" placeholder="Was du dir merken willst …">${esc(p.notes)}</textarea></label>
        <small class="muted">Wird automatisch gespeichert.</small>
      </div>
      <div class="card">
        <div class="card-head"><h2>${icon('pdf')}<span>Anleitungen</span></h2></div>
        ${instrListHtml(p, true)}
      </div>`;
  };

  let noteTimer;
  app.oninput = (e) => {
    if (e.target.id === 'plan-notes') {
      p.notes = e.target.value;
      clearTimeout(noteTimer);
      noteTimer = setTimeout(() => save(p), 400);
    }
  };

  app.onclick = async (e) => {
    const t = e.target;
    const top = t.closest('.topbar [data-act]');
    if (top) { commonTopActions(p, top.dataset.act, () => { renderLeft(); }); return; }
    const pt = t.closest('[data-part]');
    if (pt) { p.currentPartId = pt.dataset.part; save(p); return renderLeft(); }
    const tg = t.closest('[data-toggle]');
    if (tg) {
      const s = part.steps.find((x) => x.id === tg.dataset.toggle);
      s.done = !s.done; save(p); return renderLeft();
    }
    const sm = t.closest('[data-smove]');
    if (sm) {
      const i = part.steps.findIndex((x) => x.id === sm.dataset.smove);
      const j = i + Number(sm.dataset.dir);
      if (j >= 0 && j < part.steps.length) { [part.steps[i], part.steps[j]] = [part.steps[j], part.steps[i]]; save(p); renderLeft(); }
      return;
    }
    const se = t.closest('[data-sedit]');
    if (se && !sorting) {
      const s = part.steps.find((x) => x.id === se.dataset.sedit);
      const r = await stepDialog(p, part, s);
      if (r === 'delete') part.steps = part.steps.filter((x) => x !== s);
      if (r) { save(p); renderLeft(); }
      return;
    }
    const io = t.closest('[data-iopen]');
    if (io) {
      const ins = p.instructions.find((x) => x.id === io.dataset.iopen);
      p.view = p.view || { sel: {} };
      p.view.sel = p.view.sel || {};
      p.view.tab = ins.type; p.view.sel[ins.type] = ins.id;
      await save(p);
      return go(`#/projekt/${p.id}`);
    }
    const ia = t.closest('[data-iadd]');
    if (ia) { await addInstruction(p, ia.dataset.iadd); await save(p); return renderRight(); }
    const ie = t.closest('[data-iedit]');
    if (ie) { if (await editInstruction(p, ie.dataset.iedit)) { await save(p); renderRight(); } return; }
    const idl = t.closest('[data-idel]');
    if (idl) {
      const ins = p.instructions.find((i) => i.id === idl.dataset.idel);
      if (await confirmBox('Anleitung löschen?', `„${esc(ins.title)}“ wird endgültig aus dem Projekt gelöscht.`, 'Löschen', true)) {
        p.instructions = p.instructions.filter((i) => i !== ins);
        if (ins.fileId) { forgetPdf(ins.fileId); await deleteFile(ins.fileId); }
        await save(p);
        renderRight();
      }
      return;
    }
    const a = t.closest('[data-a]');
    if (!a) return;
    switch (a.dataset.a) {
      case 'sort': sorting = !sorting; renderLeft(); break;
      case 'step-add': {
        const s = { id: uid(), title: '', desc: '', done: false, reminder: null };
        const r = await stepDialog(p, part, s, true);
        if (r) { part.steps.push(s); save(p); renderLeft(); }
        break;
      }
      case 'step-import': {
        const n = await importDialog(p, part);
        if (n) { await save(p); renderLeft(); toast(n === 1 ? '1 Schritt übernommen' : `${n} Schritte übernommen`); }
        break;
      }
      case 'part-new': {
        const name = await promptBox('Neues Teil', 'Name des Teils', '', 'Anlegen');
        if (name) { const x = newPart(name); p.parts.push(x); p.currentPartId = x.id; save(p); renderLeft(); }
        break;
      }
      case 'edit-project': S.returnTo = `#/projekt/${p.id}/fahrplan`; go(`#/projekt/${p.id}/bearbeiten`); break;
      default:
    }
  };

  renderLeft();
  renderRight();
  S.cleanup = () => { clearTimeout(noteTimer); save(p); };
}

// =====================================================================
// SCHRITTE AUS DER ANLEITUNG ÜBERNEHMEN
// =====================================================================
const importSources = (p) => p.instructions.filter((i) => i.type === 'pdf' || (i.type === 'text' && i.text && i.text.trim()));

// Passt ein Abschnitt der Anleitung zu einem Teil? („Ärmel“ ↔ „Linker Ärmel“, „Rücken“ ↔ „Rückenteil“)
const NAME_FILL = new Set(['linker', 'linke', 'linkes', 'rechter', 'rechte', 'rechtes', 'links', 'rechts', 'der', 'die', 'das', 'und', 'für', 'mit']);
function sectionMatchesPart(sec, partName) {
  const same = (w) => (/^(ausarbeit|fertigstell|zusammennäh|finish)/.test(w) ? 'fertig' : w.replace(/fuss/, 'fuß'));
  const lw = (x) => x.toLowerCase().replace(/[^a-zäöüß ]/g, ' ').split(/\s+/).filter((w) => w.length >= 3 && !NAME_FILL.has(w)).map(same);
  const a = lw(sec);
  const b = lw(partName);
  if (!a.length || !b.length) return false;
  return a.some((x) => b.some((y) => x === y || x.startsWith(y) || y.startsWith(x)));
}

// Zeigt die erkannten Schritte zum Auswählen. Gibt die Zahl der übernommenen Schritte zurück.
function importDialog(p, part) {
  const srcs = importSources(p);
  let items = [];
  let sizes = null;
  let size = -1;
  let perSection = false;
  let onlyPart = false;
  let matchSecs = [];
  // Alle Teile, die zu einem Abschnitt passen („Ärmel“ → „Linker Ärmel“, „Rechter Ärmel“)
  const partsFor = (sec) => p.parts.filter((x) => sectionMatchesPart(sec, x.name));
  const ssel = p.view && p.view.sel && srcs.find((i) => i.id === p.view.sel[i.type]);
  return modal({
    title: 'Schritte aus Anleitung',
    wide: true,
    body: `
      ${srcs.length > 1 ? `<label class="field"><span>Anleitung</span><select id="im-src">${srcs.map((i) => `<option value="${i.id}" ${ssel === i ? 'selected' : ''}>${esc(i.title)}</option>`).join('')}</select></label>` : ''}
      <div id="im-opts"></div>
      <div id="im-list" class="im-list"><div class="loading">Anleitung wird gelesen …</div></div>`,
    actions: [
      { label: 'Abbrechen', value: null },
      {
        label: 'Übernehmen', kind: 'primary',
        handler: (el) => {
          const picked = [...el.querySelectorAll('.im-step input:checked')].map((c) => items[+c.dataset.k]);
          if (!picked.length) { toast('Bitte wähle mindestens einen Schritt aus.'); return false; }
          const target = el.querySelector('#im-part') ? el.querySelector('#im-part').value : part.id;
          let firstPart = null;
          let added = 0;
          for (const it of picked) {
            let dest;
            let dests;
            if (perSection && it.section) {
              dests = partsFor(it.section);
              if (!dests.length) { const np = newPart(it.section); p.parts.push(np); dests = [np]; }
            } else dests = [p.parts.find((x) => x.id === target) || part];
            if (!firstPart) firstPart = dests[0];
            const st = stepForSize(it, size, sizes && sizes.length);
            dests.forEach((dest) => {
              if (dest.steps.some((x) => x.title === st.title && x.desc === st.desc)) return; // schon vorhanden
              dest.steps.push({ id: uid(), title: st.title, desc: st.desc, done: false, reminder: null });
              added += 1;
            });
          }
          if (firstPart) p.currentPartId = firstPart.id;
          if (!added) toast('Diese Schritte sind schon im Fahrplan.');
          return added || null;
        },
      },
    ],
    onMount: (el) => {
      const list = el.querySelector('#im-list');
      const opts = el.querySelector('#im-opts');
      const okBtn = el.querySelector('.modal-actions [data-i="1"]');
      const sections = () => [...new Set(items.filter((x) => x.type === 'step' && x.section && !x.info).map((x) => x.section))];
      const updateCount = () => {
        const n = el.querySelectorAll('.im-step input:checked').length;
        const ps = el.querySelector('#im-part');
        const tp = ps ? p.parts.find((x) => x.id === ps.value) : null;
        const where = perSection && !onlyPart ? ' in passende Teile' : tp ? ` zu „${tp.name}“` : '';
        okBtn.textContent = `${n === 1 ? '1 Schritt' : `${n} Schritte`}${where} übernehmen`;
        okBtn.disabled = !n;
        const c = el.querySelector('#im-count');
        if (c) c.textContent = `${n} von ${el.querySelectorAll('.im-step').length} ausgewählt`;
      };
      const renderOpts = () => {
        const secs = sections().filter((x) => items.some((y) => y.section === x && y.checked));
        opts.innerHTML = `
          ${sizes ? `<label class="field"><span>Größe für dieses Projekt</span><select id="im-size"><option value="-1">Alle Größen anzeigen</option>${sizes.map((x, i) => `<option value="${i}" ${i === size ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></label>` : ''}
          <div class="field"><span>Hinzufügen zu</span>
            ${secs.length > 1 && !onlyPart ? `<div class="segmented" id="im-mode"><button type="button" data-m="one" class="${perSection ? '' : 'on'}">Einem Teil</button><button type="button" data-m="sec" class="${perSection ? 'on' : ''}">Je Abschnitt ein Teil</button></div>` : ''}
            ${perSection && !onlyPart
              ? '<small class="muted">Jeder Schritt kommt in das passende Teil (z. B. „Ärmel“ in „Linker Ärmel“ und „Rechter Ärmel“). Fehlende Teile werden angelegt.</small>'
              : `<select id="im-part">${p.parts.map((x) => `<option value="${x.id}" ${x.id === part.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>`}
          </div>`;
      };
      const renderList = () => {
        const n = sizes && sizes.length;
        let html = '';
        if (matchSecs.length) {
          html += onlyPart
            ? `<div class="im-filter">${icon('list')}<span>Nur der Abschnitt ${matchSecs.map((x) => `„${esc(x)}“`).join(', ')} für „${esc(part.name)}“</span><button type="button" class="btn small" data-only="0">Ganze Anleitung</button></div>`
            : `<div class="im-filter">${icon('list')}<span>Ganze Anleitung</span><button type="button" class="btn small" data-only="1">Nur ${matchSecs.map((x) => `„${esc(x)}“`).join(', ')}</button></div>`;
        }
        html += `<div class="im-top"><span id="im-count"></span><button type="button" class="btn small" data-all="0">Keine</button></div>`;
        items.forEach((it, k) => {
          if (onlyPart && !matchSecs.includes(it.type === 'section' ? it.title : it.section)) return;
          if (it.type === 'section') {
            html += `<div class="im-sec"><span>${esc(it.title)}${it.info ? ' <small>· Info</small>' : ''}</span><button type="button" class="btn small" data-sec="${k}">Alle</button></div>`;
          } else {
            const { title, desc } = stepForSize(it, size, n);
            html += `<label class="im-step"><input type="checkbox" data-k="${k}" ${it.checked ? 'checked' : ''}><span><strong>${esc(title)}</strong>${desc && desc !== title ? `<small>${esc(desc)}</small>` : ''}</span>${it.page ? `<span class="im-page">S. ${it.page}</span>` : ''}</label>`;
          }
        });
        list.innerHTML = html;
        updateCount();
      };
      const load = async (src) => {
        list.innerHTML = '<div class="loading">Anleitung wird gelesen …</div>';
        okBtn.disabled = true;
        let lines;
        try {
          lines = src.type === 'pdf' ? await pdfLines(await getDoc(src.fileId)) : textLines(src.text);
        } catch (e) {
          list.innerHTML = '<p class="im-msg">Die Anleitung konnte nicht gelesen werden.</p>';
          return;
        }
        const words = lines.reduce((a, l) => a + l.text.trim().split(/\s+/).length, 0);
        if (words < 15) {
          items = [];
          opts.innerHTML = '';
          list.innerHTML = `<p class="im-msg">In dieser PDF ist kein lesbarer Text. Wahrscheinlich wurde sie eingescannt oder fotografiert. Die Schritte musst du dann leider von Hand anlegen.</p>`;
          return;
        }
        items = suggestSteps(lines);
        sizes = detectSizes(lines);
        // Größe aus dem Projekt („Größe“ in Projekt bearbeiten) oder zuletzt gewählte Größe
        const norm = (x) => String(x || '').toLowerCase().replace(/\s/g, '');
        const fromProject = sizes ? sizes.findIndex((x) => norm(x) === norm(p.size)) : -1;
        size = fromProject >= 0 ? fromProject : sizes && p.patternSize != null && p.patternSize < sizes.length ? p.patternSize : -1;
        matchSecs = sections().filter((x) => sectionMatchesPart(x, part.name));
        onlyPart = matchSecs.length > 0;
        if (onlyPart) items.forEach((x) => { if (x.type === 'step' && matchSecs.includes(x.section)) x.checked = true; });
        perSection = !onlyPart && sections().filter((x) => items.some((y) => y.section === x && y.checked)).length > 1;
        if (!items.some((x) => x.type === 'step')) {
          opts.innerHTML = '';
          list.innerHTML = '<p class="im-msg">In dieser Anleitung wurden keine Schritte erkannt. Du kannst im Stricken-Bildschirm Text in der PDF markieren und mit „Als Schritt übernehmen“ einzeln holen.</p>';
          return;
        }
        renderOpts();
        renderList();
      };
      el.addEventListener('change', (e) => {
        if (e.target.id === 'im-src') load(srcs.find((i) => i.id === e.target.value));
        else if (e.target.id === 'im-size') {
          size = +e.target.value;
          p.patternSize = size >= 0 ? size : null;
          if (size >= 0 && !String(p.size || '').trim()) p.size = sizes[size]; // Größe im Projekt eintragen
          save(p);
          renderList();
        }
        else if (e.target.matches('.im-step input')) { items[+e.target.dataset.k].checked = e.target.checked; updateCount(); }
        else if (e.target.id === 'im-part') updateCount();
      });
      el.addEventListener('click', (e) => {
        const m = e.target.closest('[data-m]');
        if (m) { perSection = m.dataset.m === 'sec'; renderOpts(); updateCount(); return; }
        const only = e.target.closest('[data-only]');
        if (only) { onlyPart = only.dataset.only === '1'; if (onlyPart) perSection = false; renderOpts(); renderList(); return; }
        const sec = e.target.closest('[data-sec]');
        const all = e.target.closest('[data-all]');
        if (sec || all) {
          const k0 = sec ? +sec.dataset.sec : -1;
          const boxes = [];
          for (let k = k0 + 1; k < items.length; k++) {
            if (sec && items[k].type === 'section') break;
            if (items[k].type === 'step' && (!onlyPart || matchSecs.includes(items[k].section))) boxes.push(k);
          }
          const on = sec ? !boxes.every((k) => items[k].checked) : false;
          boxes.forEach((k) => { items[k].checked = on; });
          el.querySelectorAll('.im-step input').forEach((c) => { c.checked = !!items[+c.dataset.k].checked; });
          updateCount();
        }
      });
      load(ssel || srcs[0]);
    },
  });
}

// Schritt anlegen/bearbeiten. Gibt true, 'delete' oder null zurück.
function stepDialog(p, part, s, isNew = false) {
  const r = s.reminder || {};
  const type = r.type || 'none';
  const curPos = part.mode === 'cm' ? (part.cm || 0) : (part.rows || 0);
  const repUnit = r.unit || (part.mode === 'cm' ? 'cm' : 'row');
  return modal({
    title: isNew ? 'Neuer Schritt' : 'Schritt bearbeiten',
    wide: true,
    body: `
      <label class="field"><span>Titel *</span><input type="text" id="sd-title" value="${esc(s.title)}" placeholder="z. B. Abnahmen Armausschnitt"></label>
      <label class="field"><span>Beschreibung</span><textarea id="sd-desc" rows="3" placeholder="Was genau ist zu tun?">${esc(s.desc)}</textarea></label>
      <div class="field"><span>Erinnerung</span>
        <div class="segmented" id="sd-type">
          ${[['none', 'Keine'], ['cm', 'Bei cm'], ['row', 'Bei Reihe'], ['repeat', 'Wiederkehrend']].map(([k, l]) => `<button type="button" data-t="${k}" class="${type === k ? 'on' : ''}">${l}</button>`).join('')}
        </div>
      </div>
      <div class="sd-box" data-box="cm"><label class="field inline"><span>bei</span><input type="text" inputmode="decimal" id="sd-cm" value="${type === 'cm' ? fmt(r.value) : ''}" placeholder="35"><span>cm</span></label></div>
      <div class="sd-box" data-box="row"><label class="field inline"><span>bei Reihe</span><input type="text" inputmode="numeric" id="sd-row" value="${type === 'row' ? r.value : ''}" placeholder="126"></label></div>
      <div class="sd-box" data-box="repeat">
        <div class="inline-wrap">
          <label class="field inline"><span>alle</span><input type="text" inputmode="decimal" id="sd-every" value="${type === 'repeat' ? fmt(r.every) : ''}" placeholder="8"></label>
          <div class="segmented small" id="sd-unit"><button type="button" data-u="row" class="${repUnit === 'row' ? 'on' : ''}">Reihen</button><button type="button" data-u="cm" class="${repUnit === 'cm' ? 'on' : ''}">cm</button></div>
          <label class="field inline"><input type="text" inputmode="numeric" id="sd-times" value="${type === 'repeat' ? r.times : ''}" placeholder="10"><span>-mal</span></label>
        </div>
        <label class="field inline"><span>gezählt ab</span><input type="text" inputmode="decimal" id="sd-start" value="${type === 'repeat' ? fmt(r.start || 0) : fmt(curPos)}"><span id="sd-start-unit"></span></label>
        <small class="muted">Beispiel: „alle 8 Reihen, 10-mal, gezählt ab Reihe 40“ erinnert dich in Reihe 48, 56, 64 …</small>
      </div>
      <div class="sd-preview" id="sd-preview"></div>`,
    actions: [
      ...(isNew ? [] : [{ label: 'Löschen', kind: 'danger-text left', handler: async () => ((await confirmBox('Schritt löschen?', `„${esc(s.title)}“ wird gelöscht.`, 'Löschen', true)) ? 'delete' : false) }]),
      { label: 'Abbrechen', value: null },
      {
        label: 'Speichern', kind: 'primary',
        handler: (el) => {
          const title = el.querySelector('#sd-title').value.trim();
          if (!title) { toast('Bitte gib dem Schritt einen Titel.'); return false; }
          const rem = readReminder(el);
          if (rem === false) return false;
          s.title = title;
          s.desc = el.querySelector('#sd-desc').value.trim();
          s.reminder = rem;
          return true;
        },
      },
    ],
    onMount: (el) => {
      let t = type;
      let unit = repUnit;
      const update = () => {
        el.querySelectorAll('.sd-box').forEach((b) => { b.hidden = b.dataset.box !== t; });
        el.querySelector('#sd-start-unit').textContent = unit === 'cm' ? 'cm' : '(Reihe)';
        const rem = readReminder(el, true);
        let txt = '';
        if (rem) {
          txt = reminderLabel(p, rem);
          if (rem.type === 'repeat') {
            const list = [];
            for (let i = 1; i <= Math.min(rem.times, 6); i++) list.push(fmt(rem.start + rem.every * i));
            txt += `<br><span class="muted">${unit === 'cm' ? 'bei' : 'in Reihe'} ${list.join(', ')}${rem.times > 6 ? ' …' : ''}${unit === 'cm' ? ' cm' : ''}</span>`;
          }
          if (!rowsPerCm(p)) txt += '<br><span class="muted">Tipp: Trage die Maschenprobe ein, dann rechnet die App cm und Reihen um.</span>';
        }
        el.querySelector('#sd-preview').innerHTML = txt ? `${icon('bell')}<div>${txt}</div>` : '';
      };
      el.dataset.unit = unit;
      el.dataset.type = t;
      el.querySelector('#sd-type').addEventListener('click', (e) => {
        const b = e.target.closest('[data-t]');
        if (!b) return;
        t = b.dataset.t; el.dataset.type = t;
        el.querySelectorAll('#sd-type button').forEach((x) => x.classList.toggle('on', x === b));
        update();
      });
      el.querySelector('#sd-unit').addEventListener('click', (e) => {
        const b = e.target.closest('[data-u]');
        if (!b) return;
        unit = b.dataset.u; el.dataset.unit = unit;
        el.querySelectorAll('#sd-unit button').forEach((x) => x.classList.toggle('on', x === b));
        update();
      });
      el.addEventListener('input', update);
      update();
      if (isNew) setTimeout(() => el.querySelector('#sd-title').focus(), 50);
    },
  });
}

// Liest die Erinnerung aus dem Dialog. quiet = keine Fehlermeldungen (für die Vorschau)
function readReminder(el, quiet = false) {
  const t = el.dataset.type;
  const fail = (msg) => { if (!quiet) toast(msg); return quiet ? null : false; };
  if (t === 'none') return null;
  if (t === 'cm') {
    const v = num(el.querySelector('#sd-cm').value);
    if (!(v > 0)) return fail('Bitte gib ein, bei wie vielen cm erinnert werden soll.');
    return { type: 'cm', value: Math.round(v * 10) / 10 };
  }
  if (t === 'row') {
    const v = num(el.querySelector('#sd-row').value);
    if (!(v > 0)) return fail('Bitte gib die Reihe ein.');
    return { type: 'row', value: Math.round(v) };
  }
  const unit = el.dataset.unit === 'cm' ? 'cm' : 'row';
  let every = num(el.querySelector('#sd-every').value);
  const times = Math.round(num(el.querySelector('#sd-times').value) || 0);
  let start = num(el.querySelector('#sd-start').value) || 0;
  if (!(every > 0)) return fail('Bitte gib ein, alle wie viele Reihen oder cm.');
  if (!(times >= 1)) return fail('Bitte gib ein, wie oft.');
  if (unit === 'row') { every = Math.round(every); start = Math.round(start); }
  return { type: 'repeat', unit, every, times, start: clamp(start, 0, 100000) };
}

start();
