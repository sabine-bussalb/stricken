// Liest den Text aus einer Anleitung (PDF oder Text) und schlägt daraus Schritte vor.
// Alles läuft auf dem Gerät, ohne Internet.

// ---------- Text aus der PDF holen ----------

// Gibt die Zeilen einer PDF zurück: [{ text, page, h, gap }]
// h = Schriftgröße, gap = Abstand zur vorigen Zeile (in Zeilenhöhen, Infinity bei neuer Seite)
export async function pdfLines(doc) {
  const out = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const tc = await page.getTextContent();
    let cur = null;
    let lastY = null; // Höhe der letzten Zeile mit Text
    const flush = () => {
      if (cur && cur.text.trim()) { out.push(cur); lastY = cur.y; }
      cur = null;
    };
    for (const it of tc.items) {
      if (typeof it.str !== 'string') continue;
      const y = it.transform[5];
      const h = Math.abs(it.transform[3]) || it.height || 10;
      if (cur && Math.abs(y - cur.y) > Math.max(cur.h, h) * 0.5) flush();
      if (it.str) {
        if (!cur) {
          const gap = lastY === null ? Infinity : Math.abs(lastY - y) / Math.max(h, 1);
          cur = { text: '', page: n, h, y, gap };
        }
        if (cur.text && !/\s$/.test(cur.text) && !/^[\s-]/.test(it.str) && it.str.trim()) {
          // Lücke zwischen zwei Textstücken auf derselben Zeile = Leerzeichen
          if (cur.endX != null && it.transform[4] - cur.endX > h * 0.15) cur.text += ' ';
        }
        cur.text += it.str;
        if (it.str.trim()) cur.h = Math.max(cur.h, h);
        cur.endX = it.transform[4] + (it.width || 0);
      }
      if (it.hasEOL) flush();
    }
    flush();
    page.cleanup();
  }
  return out.map(({ text, page, h, gap }) => ({ text, page, h, gap }));
}

// Zeilen aus einem einfachen Text (Text-Anleitung)
export function textLines(text) {
  const out = [];
  let blank = Infinity;
  for (const raw of String(text || '').split(/\r?\n/)) {
    if (!raw.trim()) { blank = 2; continue; }
    out.push({ text: raw, page: 0, h: 10, gap: blank === Infinity && !out.length ? Infinity : blank });
    blank = 1;
  }
  return out;
}

// ---------- Schritte erkennen ----------

const clean = (s) => s
  .replace(/[   ]/g, ' ')
  .replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl')
  .replace(/\s+/g, ' ')
  .trim();

// Beginn einer Reihen-/Runden-Angabe, z. B. „R 1:“, „1. Reihe“, „Rd 5–8“, „Reihe 12 (Rückreihe)“, „Row 3“
const RANGE = String.raw`\d+(?:\s*(?:-|–|—|bis|u\.|und|\+)\s*\d+)*`;
const ROW_WORD = String.raw`(?:Reihen?|Runden?|Rdn?|Rde|R|Hinr(?:eihe)?|Rückr(?:eihe)?|Hin-?\s*u(?:nd|\.)\s*Rückr(?:eihe)?n?|Rows?|Rounds?|Rnds?|Rnd)`;
const ROW_START = new RegExp(String.raw`^(?:(?:${RANGE})\.\s*${ROW_WORD}\b\.?|${ROW_WORD}\.?\s*${RANGE}\b\.?)(?:\s*\([^)]{0,40}\))?\s*[:.]?`, 'i');
const NUM_START = /^(?:\d{1,2}[.)]|[a-h]\))\s+(?=\S)/;
const BULLET = /^[•▪●◦·*–-]\s+(?=[A-ZÄÖÜ\d])/;

// Abschnitte, die keine Arbeitsschritte enthalten
const INFO_SECTIONS = /^(material|materialien|garn|wolle|nadeln?|zubehör|größen?|grösse|maße|masse|maschenprobe|abkürzungen|abk\.|legende|zeichenerklärung|hinweise?|tipps?|anmerkungen?|vorwort|einleitung|über|info|information|schwierigkeit|copyright|lizenz|kontakt|impressum|herausgeber|fotograf|foto|bitte beachten|verbrauch|benötigt|du brauchst|ihr braucht|sie brauchen|bezugsquellen?|strickschrift|zählmuster|schnitt|schnittschema|gauge|materials?|yarn|needles|notions|abbreviations|sizes?|finished measurements)\b|(muster|rand|probe|kante)$/i;
// Typische Teile einer Strickanleitung
const WORK_SECTIONS = /(bündchen|rücken|vorder|ärmel|arm|hals|ausschnitt|blende|kragen|ferse|käppchen|fuß|fuss|spitze|schaft|bein|passe|körper|rumpf|fertigstell|ausarbeit|ausführung|anleitung|kapuze|tasche|daumen|hand|zwickel|raglan|saum|anschlag|abnahme|zunahme|abketten|teil|schritt|beginn|yoke|sleeve|front|back|cuff|heel|toe|finishing|instructions)/i;
// Absätze, die nur Informationen enthalten (Größe, Material …)
const INFO_TEXT = /^(größen?\b|grösse|material|maschenprobe|machen sie (eine|die) maschenprobe|garn\b|wolle\b|nadeln?\b|verbrauch|du brauchst|ihr braucht|sie brauchen|benötigt|bitte beachten|die angaben für)/i;

const isNoise = (t) => !t
  || /^(seite|page|s\.)?\s*\d{1,3}\s*(\/|von|of)?\s*\d{0,3}$/i.test(t)
  || /(©|copyright|alle rechte|all rights|urheber|https?:\/\/|www\.)/i.test(t);

// Wenig Buchstaben, viele Zahlen: Maßskizze o. Ä.
const mostlyNumbers = (t) => (t.match(/[a-zäöüß]/gi) || []).length < t.replace(/\s/g, '').length * 0.45;

function isHeading(line, t, medianH) {
  if (t.length > 45 || ROW_START.test(t) || BULLET.test(t)) return false;
  if (/[.,;-]$/.test(t) || line.h < medianH * 0.85) return false;
  const words = t.split(' ').length;
  if (words > 6) return false;
  const big = line.h > medianH * 1.15;
  const caps = /[A-ZÄÖÜ]{3}/.test(t) && t === t.toUpperCase();
  const colon = /:$/.test(t) && words <= 4;
  const known = (INFO_SECTIONS.test(t) || WORK_SECTIONS.test(t)) && words <= 4 && !/\d{2,}/.test(t);
  return big || caps || colon || (known && line.gap > 1.4);
}

// „Rückenteil: 149 M anschlagen …“ → Überschrift am Absatzanfang
const INLINE_HEAD = /^([A-ZÄÖÜ][\wäöüßÄÖÜ-]{1,24}(?:\s+(?:und|&|\/|[A-ZÄÖÜ][\wäöüßÄÖÜ-]{0,20})){0,2}):\s+(?=\S)/;

function shorten(t, max = 70) {
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > 30 ? cut.slice(0, sp) : cut).replace(/[\s,;:–-]+$/, '')} …`;
}

// Abkürzungen, nach denen kein neuer Satz beginnt
const NO_SPLIT = /(?:^|[\s(/-])(?:nd|nr|ca|bzw|fb|lt|z|b|u|ggf|evtl|inkl|gr|abb|pos|tab|vgl|s|d|h|o|usw|etc|max|min|mind|std|hin|rück|art|col|fa|farbe)\.$/i;

// Teilt einen langen Absatz in einzelne Sätze (= Arbeitsschritte)
function sentences(t) {
  const parts = [];
  let startI = 0;
  const re = /[.!?]\s+(?=[A-ZÄÖÜ])/g;
  let m;
  while ((m = re.exec(t))) {
    const piece = t.slice(startI, m.index + 1);
    if (m[0][0] === '.' && (NO_SPLIT.test(piece) || /\d\.$/.test(piece))) continue; // „jeder 2. R“
    parts.push(piece.trim());
    startI = m.index + m[0].length;
  }
  parts.push(t.slice(startI).trim());
  // Sehr kurze Sätze an den nächsten hängen
  const out = [];
  let carry = '';
  for (const x of parts.filter(Boolean)) {
    const v = carry ? `${carry} ${x}` : x;
    if (v.length < 30) carry = v; else { out.push(v); carry = ''; }
  }
  if (carry) { if (out.length) out[out.length - 1] += ` ${carry}`; else out.push(carry); }
  return out;
}

// Macht aus einem Textblock einen Schritt-Vorschlag { title, desc }
function toStep(text, heading, firstInSection, kind) {
  const t = text.replace(/^[•▪●◦·*–-]\s+/, '');
  if (kind === 'para' && heading && firstInSection && t.length > 70) {
    return { title: shorten(heading.replace(/:$/, ''), 60), desc: t };
  }
  // „Halsblende: …“ → Titel vor dem Doppelpunkt
  const colon = t.indexOf(':');
  if (colon > 0 && colon <= 45 && t.length - colon > 3 && kind !== 'row') {
    const title = t.slice(0, colon).trim();
    return { title: shorten(title, 60), desc: t.slice(colon + 1).trim() };
  }
  if (t.length <= 70) return { title: t, desc: '' };
  return { title: shorten(t), desc: t };
}

// lines: [{ text, page, h, gap }]
// → [{ type: 'section', title, info } | { type: 'step', title, desc, page, section, checked }]
export function suggestSteps(lines) {
  const ls = lines.map((l) => ({ ...l, text: clean(l.text) })).filter((l) => !isNoise(l.text));
  if (!ls.length) return [];
  const hs = ls.map((l) => l.h).sort((a, b) => a - b);
  const medianH = hs[Math.floor(hs.length / 2)] || 10;

  // 1. Zeilen zu Blöcken zusammenfassen
  const blocks = [];
  let b = null;
  const end = () => { if (b) blocks.push(b); b = null; };
  for (const l of ls) {
    const t = l.text;
    if (isHeading(l, t, medianH)) {
      end();
      blocks.push({ kind: 'head', text: t, page: l.page });
      continue;
    }
    const kind = ROW_START.test(t) ? 'row' : NUM_START.test(t) ? 'num' : BULLET.test(t) ? 'bullet' : null;
    const prevEndsSentence = b && /[.!:)]$/.test(b.text);
    if (!b || kind || l.gap > 1.6 || (l.page !== b.page && prevEndsSentence) || Math.abs(l.h - b.h) > medianH * 0.15) {
      end();
      b = { kind: kind || 'para', text: t, page: l.page, h: l.h };
    } else {
      b.text = b.text.replace(/\s+-$/, '-');
      if (/[a-zäöüß]-$/.test(b.text) && /^[a-zäöüß]/.test(t)) b.text = b.text.slice(0, -1) + t; // Silbentrennung
      else if (/\S-$/.test(b.text) && /^[A-ZÄÖÜ]/.test(t)) b.text += t; // „Rand-“ + „M“
      else b.text += ` ${t}`;
    }
  }
  end();

  // Überschrift am Absatzanfang abtrennen
  const blocks2 = [];
  for (const x of blocks) {
    const m = x.kind === 'para' && x.text.match(INLINE_HEAD);
    if (m && m[1].split(' ').length <= 3 && !ROW_START.test(m[1])) {
      blocks2.push({ kind: 'head', text: m[1], page: x.page });
      blocks2.push({ ...x, text: x.text.slice(m[0].length) });
    } else blocks2.push(x);
  }

  // 2. Abschnitte und Schritte bilden
  const out = [];
  let heading = '';
  let info = false;
  let first = true;
  const structured = blocks2.some((x) => x.kind === 'row' || x.kind === 'num');
  const anyWork = blocks2.some((x) => x.kind === 'head' && WORK_SECTIONS.test(x.text) && !INFO_SECTIONS.test(x.text));
  for (const x of blocks2) {
    if (x.kind === 'head') {
      heading = x.text.replace(/:$/, '');
      info = INFO_SECTIONS.test(heading);
      first = true;
      out.push({ type: 'section', title: heading, info });
      continue;
    }
    if (x.text.length < 3 || mostlyNumbers(x.text) || x.h < medianH * 0.85) continue; // Skizzen, Fußnoten
    const work = !info && WORK_SECTIONS.test(heading);
    const infoText = INFO_TEXT.test(x.text) || /^\S{1,12}\s*=\s*/.test(x.text); // auch Abkürzung „re = rechts“
    const pieces = x.kind === 'para' && !info && !infoText && x.text.length > 140 ? sentences(x.text) : [x.text];
    for (const piece of pieces) {
      const opts = { heading, first: first && pieces.length === 1, kind: x.kind };
      const s = toStep(piece, opts.heading, opts.first, opts.kind);
      first = false;
      let checked;
      if (info || infoText) checked = false;
      else if (x.kind === 'row' || x.kind === 'num') checked = true;
      else if (structured) checked = work;
      else checked = work || !anyWork;
      out.push({ type: 'step', title: s.title, desc: s.desc, raw: piece, opts, page: x.page, section: heading, checked });
    }
  }
  // Abschnitte ohne Schritte entfernen
  return out.filter((x, i) => x.type === 'step' || (out[i + 1] && out[i + 1].type === 'step'));
}

// ---------- Größen ----------

// „Größe 48/50, 52/54 und 56/58“ → ['48/50', '52/54', '56/58']
export function detectSizes(lines) {
  const all = lines.map((l) => clean(l.text)).join(' ');
  const m = all.match(/Gr(?:ö|oe)(?:ß|ss)en?:?\s+((?:[\dA-Z][\w/]*)(?:\s*(?:,|und|\(|\)|-|–|bis)\s*(?:[\dA-Z][\w/]*))+)/);
  if (!m) return null;
  const list = m[1].split(/\s*(?:,|und|\(|\)|-|–|bis)\s*/).map((x) => x.trim()).filter(Boolean);
  return list.length >= 2 && list.length <= 8 ? list : null;
}

// „149 (161 - 173) M“ → bei Größe 2: „161 M“
export function applySize(text, i, n) {
  if (i == null || i < 0 || !n) return text;
  return text.replace(/(\d+(?:,\d+)?x?)\s*\(\s*(\d+(?:,\d+)?x?(?:\s*[-–]\s*\d+(?:,\d+)?x?)*)\s*\)/g, (all, a, inner) => {
    const vals = [a, ...inner.split(/\s*[-–]\s*/)];
    return vals.length === n ? vals[i] : all;
  });
}

// Schritt-Vorschlag für eine bestimmte Größe (Größe zuerst einsetzen, dann kürzen)
export function stepForSize(item, i, n) {
  if (i == null || i < 0 || !n || !item.raw) return { title: item.title, desc: item.desc };
  return toStep(applySize(item.raw, i, n), item.opts.heading, item.opts.first, item.opts.kind);
}

// Für markierten Text: Titel und Beschreibung
export function stepFromText(text) {
  const t = String(text || '').replace(/\r/g, '').split('\n').map(clean).filter(Boolean).join(' ');
  return toStep(t, '', false, ROW_START.test(t) ? 'row' : 'para');
}
