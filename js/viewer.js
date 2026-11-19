// Anleitungs-Ansicht: PDF (pdf.js), Fotos und Text mit Zoom und Markierungslinie
import { icon } from './icons.js';
import { db } from './db.js';
import { esc, clamp, fileUrl } from './util.js';

const MINZ = 0.5;
const MAXZ = 5;
const TABS = [
  ['pdf', 'PDF', 'pdf', 'PDF-Anleitung', 'PDF'],
  ['photo', 'Fotos', 'photo', 'Fotos', 'Foto'],
  ['text', 'Text', 'text', 'Text-Anleitung', 'Text'],
];

let pdfjsPromise = null;
function pdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('../vendor/pdfjs/pdf.min.mjs').then((m) => {
      m.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
      return m;
    });
  }
  return pdfjsPromise;
}

const docCache = new Map();
function getDoc(fileId) {
  if (docCache.has(fileId)) return docCache.get(fileId);
  const pr = (async () => {
    const lib = await pdfjs();
    const rec = await db.get('files', fileId);
    if (!rec) throw new Error('Datei fehlt');
    return lib.getDocument({
      data: new Uint8Array(rec.data.slice(0)),
      isEvalSupported: false,
      standardFontDataUrl: new URL('../vendor/pdfjs/standard_fonts/', import.meta.url).href,
    }).promise;
  })();
  docCache.set(fileId, pr);
  pr.catch(() => docCache.delete(fileId));
  if (docCache.size > 3) {
    const [k, v] = docCache.entries().next().value;
    docCache.delete(k);
    v.then((d) => d.destroy()).catch(() => {});
  }
  return pr;
}

export function forgetPdf(fileId) {
  const v = docCache.get(fileId);
  if (v) { docCache.delete(fileId); v.then((d) => d.destroy()).catch(() => {}); }
}

export class Viewer {
  constructor(root, project, { save, add }) {
    this.root = root;
    this.p = project;
    this.save = save;
    this.add = add;
    this.p.view = this.p.view || {};
    this.p.view.sel = this.p.view.sel || {};
    if (!this.p.view.tab || !this.items(this.p.view.tab).length) {
      const first = TABS.find((t) => this.items(t[0]).length);
      this.p.view.tab = first ? first[0] : this.p.view.tab || 'pdf';
    }
    this.token = 0;
    this.lineStep = 20;
    this.ro = new ResizeObserver(() => {
      const w = this.vp && this.vp.clientWidth;
      if (w && w !== this.lastW) {
        this.lastW = w;
        clearTimeout(this.rt);
        this.rt = setTimeout(() => this.renderContent(), 150);
      }
    });
    this.root.onclick = (e) => this.onClick(e);
    this.root.onchange = (e) => {
      const s = e.target.closest('[data-vsel]');
      if (s) { this.p.view.sel[this.p.view.tab] = s.value; this.persist(); this.render(); }
    };
    this.render();
  }

  items(type) { return this.p.instructions.filter((i) => i.type === type); }

  current() {
    const tab = this.p.view.tab;
    const list = this.items(tab);
    if (!list.length) return null;
    let c = list.find((i) => i.id === this.p.view.sel[tab]);
    if (!c) { c = list[0]; this.p.view.sel[tab] = c.id; }
    return c;
  }

  show(instrId) {
    const i = this.p.instructions.find((x) => x.id === instrId);
    if (!i) return;
    this.p.view.tab = i.type;
    this.p.view.sel[i.type] = i.id;
    this.persist();
    this.render();
  }

  persist() {
    clearTimeout(this.st);
    this.st = setTimeout(() => { this.st = null; this.save(); }, 400);
  }

  destroy() {
    this.ro.disconnect();
    clearTimeout(this.rt);
    if (this.st) { clearTimeout(this.st); this.save(); }
    if (this.task) { try { this.task.cancel(); } catch (e) { /* egal */ } }
    this.token++;
    this.root.onclick = null;
    this.root.onchange = null;
  }

  render() {
    const tab = this.p.view.tab;
    const list = this.items(tab);
    const cur = this.current();
    const t = TABS.find((x) => x[0] === tab);
    let head = '';
    if (cur && tab !== 'photo' && list.length > 1) {
      head = `<select class="viewer-select" data-vsel aria-label="Anleitung wählen">${list.map((i) => `<option value="${i.id}" ${i.id === cur.id ? 'selected' : ''}>${esc(i.title)}</option>`).join('')}</select>`;
    } else if (cur) {
      head = `<div class="viewer-title">${esc(cur.title)}</div>`;
    }
    this.root.innerHTML = `
      <div class="viewer-head">
        <div class="segmented small">${TABS.map(([k, l, ic]) => {
          const n = this.items(k).length;
          return `<button data-vtab="${k}" class="${k === tab ? 'on' : ''}">${icon(ic)}<span>${l}</span>${n ? `<span class="count">${n}</span>` : ''}</button>`;
        }).join('')}</div>
        ${head}
      </div>
      ${cur ? `
        <div class="viewport" id="vp">
          <div class="sheet ${cur.type}" id="sheet">
            <div class="sheet-content"><div class="loading">Wird geladen …</div></div>
            <div class="marker" id="marker"><div class="marker-handle" id="mhandle" aria-label="Linie verschieben">${icon('grip')}</div></div>
          </div>
        </div>
        <div class="viewer-toolbar">${this.toolbarHtml(cur)}</div>` : `
        <div class="viewer-empty">
          ${icon(t[2], 'big')}
          <p>Noch keine ${t[3]} in diesem Projekt.</p>
          <button class="btn primary" data-vadd="${tab}">${icon('plus')}<span>${t[4]} hinzufügen</span></button>
        </div>`}`;
    this.vp = this.root.querySelector('#vp');
    this.sheet = this.root.querySelector('#sheet');
    this.marker = this.root.querySelector('#marker');
    this.ro.disconnect();
    if (!cur) return;
    this.lastW = this.vp.clientWidth;
    this.ro.observe(this.vp);
    this.wire();
    this.renderContent();
  }

  toolbarHtml(cur) {
    let nav = '';
    if (cur.type === 'pdf') {
      nav = `<button class="icon-btn" data-v="prev" aria-label="Vorige Seite">${icon('back')}</button>
        <span class="tb-label" id="pagelabel">Seite ${cur.page || 1}</span>
        <button class="icon-btn" data-v="next" aria-label="Nächste Seite">${icon('next')}</button>`;
    } else if (cur.type === 'photo') {
      const list = this.items('photo');
      if (list.length > 1) {
        nav = `<button class="icon-btn" data-v="prev" aria-label="Voriges Foto">${icon('back')}</button>
          <span class="tb-label">Foto ${list.indexOf(cur) + 1} / ${list.length}</span>
          <button class="icon-btn" data-v="next" aria-label="Nächstes Foto">${icon('next')}</button>`;
      }
    }
    return `
      <div class="tb-group">${nav}</div>
      <div class="tb-group">
        <button class="icon-btn" data-v="zout" aria-label="Verkleinern">${icon('zoomOut')}</button>
        <button class="tb-label tb-btn" data-v="zreset" id="zlabel" aria-label="Zoom zurücksetzen">${Math.round((cur.zoom || 1) * 100)} %</button>
        <button class="icon-btn" data-v="zin" aria-label="Vergrößern">${icon('zoomIn')}</button>
      </div>
      <div class="tb-group">
        <span class="tb-hint">Linie</span>
        <button class="icon-btn accent" data-v="mup" aria-label="Linie nach oben">${icon('up')}</button>
        <button class="icon-btn accent" data-v="mdown" aria-label="Linie nach unten">${icon('down')}</button>
      </div>`;
  }

  // ---------- Markierungslinie ----------
  getMarker() {
    const c = this.current();
    if (c.type === 'pdf') { c.markers = c.markers || {}; return c.markers[c.page || 1] ?? 0.04; }
    return c.marker ?? 0.02;
  }
  stepFrac() {
    const h = this.sheet.offsetHeight;
    return h ? this.lineStep / h : 0.02;
  }
  setMarker(v) {
    const c = this.current();
    v = clamp(v, 0, Math.max(0, 1 - this.stepFrac()));
    if (c.type === 'pdf') { c.markers = c.markers || {}; c.markers[c.page || 1] = v; } else c.marker = v;
    this.placeMarker();
    this.persist();
  }
  placeMarker() {
    if (!this.marker) return;
    const h = this.sheet.offsetHeight;
    this.marker.style.top = `${this.getMarker() * h}px`;
    this.marker.style.height = `${this.lineStep}px`;
    this.placeHandle();
  }
  placeHandle() {
    const hdl = this.root.querySelector('#mhandle');
    if (!hdl) return;
    hdl.style.left = `${Math.max(0, this.vp.scrollLeft - this.sheet.offsetLeft) + 6}px`;
  }
  ensureMarkerVisible() {
    const top = this.getMarker() * this.sheet.offsetHeight + this.sheet.offsetTop;
    const vh = this.vp.clientHeight;
    if (top < this.vp.scrollTop + 40 || top + this.lineStep > this.vp.scrollTop + vh - 40) {
      this.vp.scrollTo({ top: Math.max(0, top - vh * 0.3), behavior: 'smooth' });
    }
  }
  moveMarker(dir) {
    const c = this.current();
    const step = this.stepFrac();
    const v = this.getMarker() + dir * step;
    if (c.type === 'pdf' && dir > 0 && v + step > 1.0001 && (c.page || 1) < (this.numPages || 1)) {
      c.page = (c.page || 1) + 1;
      c.markers = c.markers || {};
      c.markers[c.page] = 0.04;
      this.pendingScroll = { left: this.vp.scrollLeft, top: 0 };
      this.persist();
      this.renderContent();
      return;
    }
    this.setMarker(v);
    this.ensureMarkerVisible();
  }

  wire() {
    const vp = this.vp;
    const sheet = this.sheet;
    const hdl = this.root.querySelector('#mhandle');
    vp.addEventListener('scroll', () => this.placeHandle(), { passive: true });

    // Linie mit dem Finger ziehen
    hdl.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      hdl.setPointerCapture(e.pointerId);
      const r = this.marker.getBoundingClientRect();
      this.drag = { off: e.clientY - r.top };
      this.marker.classList.add('dragging');
    });
    hdl.addEventListener('pointermove', (e) => {
      if (!this.drag) return;
      const r = sheet.getBoundingClientRect();
      this.setMarker((e.clientY - this.drag.off - r.top) / r.height);
      const vr = vp.getBoundingClientRect();
      if (e.clientY > vr.bottom - 50) vp.scrollTop += 10;
      if (e.clientY < vr.top + 50) vp.scrollTop -= 10;
    });
    const endDrag = () => { this.drag = null; this.marker.classList.remove('dragging'); };
    hdl.addEventListener('pointerup', endDrag);
    hdl.addEventListener('pointercancel', endDrag);

    // Antippen setzt die Linie an diese Stelle
    sheet.addEventListener('pointerdown', (e) => {
      if (e.target.closest('#mhandle') || !e.isPrimary) { this.tap = null; return; }
      this.tap = { x: e.clientX, y: e.clientY, t: Date.now() };
    });
    sheet.addEventListener('pointerup', (e) => {
      const t = this.tap;
      this.tap = null;
      if (!t || this.pinch) return;
      if (Math.hypot(e.clientX - t.x, e.clientY - t.y) > 10 || Date.now() - t.t > 400) return;
      const r = sheet.getBoundingClientRect();
      this.setMarker((e.clientY - r.top) / r.height - this.stepFrac() / 2);
    });
    sheet.addEventListener('pointercancel', () => { this.tap = null; });

    // Zoom mit zwei Fingern
    const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1;
    vp.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 2) return;
      e.preventDefault();
      this.tap = null;
      const [a, b] = e.touches;
      const vr = vp.getBoundingClientRect();
      const cx = (a.clientX + b.clientX) / 2 - vr.left;
      const cy = (a.clientY + b.clientY) / 2 - vr.top;
      this.pinch = { d: dist(a, b), cx, cy, ratio: 1, zoom: this.current().zoom || 1 };
      sheet.style.transformOrigin = `${cx + vp.scrollLeft - sheet.offsetLeft}px ${cy + vp.scrollTop - sheet.offsetTop}px`;
    }, { passive: false });
    vp.addEventListener('touchmove', (e) => {
      if (!this.pinch || e.touches.length !== 2) return;
      e.preventDefault();
      const [a, b] = e.touches;
      const z = clamp(this.pinch.zoom * (dist(a, b) / this.pinch.d), MINZ, MAXZ);
      this.pinch.ratio = z / this.pinch.zoom;
      sheet.style.transform = `scale(${this.pinch.ratio})`;
    }, { passive: false });
    const endPinch = (e) => {
      if (!this.pinch || e.touches.length >= 2) return;
      const pz = this.pinch;
      this.pinch = null;
      if (Math.abs(pz.ratio - 1) > 0.02) this.setZoom(pz.zoom * pz.ratio, { cx: pz.cx, cy: pz.cy });
      else sheet.style.transform = '';
    };
    vp.addEventListener('touchend', endPinch);
    vp.addEventListener('touchcancel', endPinch);
  }

  setZoom(z, anchor) {
    const c = this.current();
    const old = c.zoom || 1;
    z = clamp(Math.round(z * 100) / 100, MINZ, MAXZ);
    const cx = anchor ? anchor.cx : this.vp.clientWidth / 2;
    const cy = anchor ? anchor.cy : this.vp.clientHeight / 2;
    const f = z / old;
    this.pendingScroll = {
      left: (this.vp.scrollLeft + cx) * f - cx,
      top: (this.vp.scrollTop + cy) * f - cy,
    };
    c.zoom = z;
    this.persist();
    this.renderContent();
  }

  onClick(e) {
    const tabBtn = e.target.closest('[data-vtab]');
    if (tabBtn) { this.p.view.tab = tabBtn.dataset.vtab; this.persist(); this.render(); return; }
    const addBtn = e.target.closest('[data-vadd]');
    if (addBtn) { this.add(addBtn.dataset.vadd).then(() => this.render()); return; }
    const b = e.target.closest('[data-v]');
    if (!b) return;
    const c = this.current();
    if (!c) return;
    switch (b.dataset.v) {
      case 'zin': this.setZoom((c.zoom || 1) * 1.25); break;
      case 'zout': this.setZoom((c.zoom || 1) / 1.25); break;
      case 'zreset': this.setZoom(1); break;
      case 'mup': this.moveMarker(-1); break;
      case 'mdown': this.moveMarker(1); break;
      case 'prev':
      case 'next': {
        const d = b.dataset.v === 'next' ? 1 : -1;
        if (c.type === 'pdf') {
          const np = clamp((c.page || 1) + d, 1, this.numPages || 1);
          if (np === (c.page || 1)) return;
          c.page = np;
          this.pendingScroll = { left: this.vp.scrollLeft, top: 0 };
          this.persist();
          this.renderContent();
        } else {
          const list = this.items(c.type);
          const i = (list.indexOf(c) + d + list.length) % list.length;
          this.p.view.sel[c.type] = list[i].id;
          this.persist();
          this.render();
        }
        break;
      }
      default:
    }
  }

  async renderContent() {
    const cur = this.current();
    if (!cur || !this.vp) return;
    const token = ++this.token;
    const content = this.sheet.querySelector('.sheet-content');
    const avail = Math.max(200, this.vp.clientWidth - 24);
    const zoom = cur.zoom || 1;

    if (cur.type === 'pdf') {
      let doc;
      try { doc = await getDoc(cur.fileId); } catch (e) {
        content.innerHTML = '<p class="viewer-error">Die PDF konnte nicht geöffnet werden.</p>';
        return;
      }
      if (token !== this.token) return;
      this.numPages = doc.numPages;
      cur.page = clamp(cur.page || 1, 1, doc.numPages);
      const page = await doc.getPage(cur.page);
      if (token !== this.token) return;
      const v1 = page.getViewport({ scale: 1 });
      const scale = (avail / v1.width) * zoom;
      const viewport = page.getViewport({ scale });
      let out = Math.min(window.devicePixelRatio || 1, 2);
      const maxPx = 12e6;
      if (viewport.width * viewport.height * out * out > maxPx) out = Math.sqrt(maxPx / (viewport.width * viewport.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width * out);
      canvas.height = Math.floor(viewport.height * out);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      if (this.task) { try { this.task.cancel(); } catch (e) { /* egal */ } }
      const task = page.render({
        canvasContext: canvas.getContext('2d'),
        viewport,
        transform: out !== 1 ? [out, 0, 0, out, 0, 0] : undefined,
      });
      this.task = task;
      try { await task.promise; } catch (e) { canvas.width = 0; canvas.height = 0; return; }
      if (token !== this.token) { canvas.width = 0; canvas.height = 0; return; }
      const old = content.querySelector('canvas');
      content.replaceChildren(canvas);
      if (old) { old.width = 0; old.height = 0; }
      this.lineStep = Math.max(12, 14 * scale);
    } else if (cur.type === 'photo') {
      let img = content.querySelector('img');
      if (!img || img.dataset.id !== cur.fileId) {
        const url = await fileUrl(cur.fileId);
        if (token !== this.token) return;
        img = new Image();
        img.dataset.id = cur.fileId;
        img.alt = cur.title;
        img.src = url;
        try { await img.decode(); } catch (e) { /* trotzdem anzeigen */ }
        if (token !== this.token) return;
        content.replaceChildren(img);
      }
      const w = Math.round(avail * zoom);
      img.style.width = `${w}px`;
      const h = img.naturalWidth ? (w * img.naturalHeight) / img.naturalWidth : w;
      this.lineStep = Math.max(16, h / 45);
    } else {
      const fs = 18 * zoom;
      content.innerHTML = `<div class="text-content" style="font-size:${fs}px;width:${avail}px">${esc(cur.text)}</div>`;
      this.lineStep = fs * 1.6;
    }

    this.sheet.style.transform = '';
    const pl = this.root.querySelector('#pagelabel');
    if (pl && cur.type === 'pdf') pl.textContent = `Seite ${cur.page} / ${this.numPages}`;
    const zl = this.root.querySelector('#zlabel');
    if (zl) zl.textContent = `${Math.round(zoom * 100)} %`;
    if (this.pendingScroll) {
      this.vp.scrollLeft = this.pendingScroll.left;
      this.vp.scrollTop = this.pendingScroll.top;
      this.pendingScroll = null;
    }
    this.placeMarker();
  }
}
