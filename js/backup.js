// Sicherung: eine einzige Datei mit allen Projekten, PDFs und Fotos.
// Aufbau: MAGIC + 12-stellige Länge + "\n" + JSON-Kopf + Rohdaten aller Dateien hintereinander.
import { db } from './db.js';

const MAGIC = 'STRICKEN-SICHERUNG-1\n';

export async function buildBackup() {
  const projects = await db.getAll('projects');
  const files = await db.getAll('files');
  const header = {
    app: 'stricken',
    version: 1,
    created: new Date().toISOString(),
    projects,
    files: files.map((f) => ({ id: f.id, name: f.name, type: f.type, size: f.data.byteLength })),
  };
  const json = new TextEncoder().encode(JSON.stringify(header));
  const len = String(json.length).padStart(12, '0');
  const blob = new Blob([MAGIC, len, '\n', json, ...files.map((f) => f.data)], { type: 'application/octet-stream' });
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const name = `strick-sicherung-${stamp}.stricken`;
  const file = new File([blob], name, { type: 'application/octet-stream' });
  return { file, projectCount: projects.length, fileCount: files.length };
}

export async function readBackup(file) {
  const headStart = MAGIC.length + 13;
  const head = await file.slice(0, headStart).text();
  if (!head.startsWith(MAGIC)) throw new Error('Das ist keine Sicherungsdatei dieser App.');
  const len = parseInt(head.slice(MAGIC.length, MAGIC.length + 12), 10);
  if (!(len > 0)) throw new Error('Die Sicherungsdatei ist beschädigt.');
  const header = JSON.parse(await file.slice(headStart, headStart + len).text());
  if (header.app !== 'stricken') throw new Error('Das ist keine Sicherungsdatei dieser App.');
  return { header, dataStart: headStart + len };
}

export async function restoreBackup(file, parsed) {
  const { header, dataStart } = parsed;
  // Erst alle Dateien lesen, damit bei einem Fehler nichts verloren geht
  let off = dataStart;
  const files = [];
  for (const f of header.files) {
    const data = await file.slice(off, off + f.size).arrayBuffer();
    if (data.byteLength !== f.size) throw new Error('Die Sicherungsdatei ist unvollständig.');
    files.push({ id: f.id, name: f.name, type: f.type, data });
    off += f.size;
  }
  await db.clear('projects');
  await db.clear('files');
  for (const f of files) await db.put('files', f);
  for (const p of header.projects) await db.put('projects', p);
}
