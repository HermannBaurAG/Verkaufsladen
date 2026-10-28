// Liest aus dem ERP-Export und dem Kürzelverzeichnis (.xlsx) NUR die freigegebenen Spalten (Datenschutz, siehe CLAUDE.md).
// Die Spalten werden über die Bezeichnung in Zeile 1 gefunden, nicht über den Buchstaben.
// Eigene kleine Umsetzung (ZIP + XML), damit keine fremde Bibliothek nötig ist.
(function () {
  'use strict';

  // Feldname im Tool -> Spaltenbezeichnung im ERP-Export
  const SPALTEN = {
    text: ['Artikel'],
    nr: ['Artikel N°', 'Artikel Nr', 'Artikel No', 'Artikel-Nr.', /^artikel\s*n/],
    ean: ['EAN Code'],
    kategorie: ['Artikelkategorie'],
    marke: ['Marke'],
  };

  // ---------- ZIP ----------
  async function zipEintraege(buf) {
    const dv = new DataView(buf);
    let eocd = -1;
    for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 66000); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Die Datei ist keine Excel-Datei (.xlsx).');
    const anzahl = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const eintraege = {};
    const dec = new TextDecoder();
    for (let n = 0; n < anzahl; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const methode = dv.getUint16(p + 10, true);
      const groesse = dv.getUint32(p + 20, true);
      const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), kommLen = dv.getUint16(p + 32, true);
      const lokal = dv.getUint32(p + 42, true);
      const name = dec.decode(new Uint8Array(buf, p + 46, nameLen));
      eintraege[name] = { methode, groesse, lokal };
      p += 46 + nameLen + extraLen + kommLen;
    }
    return eintraege;
  }

  async function zipText(buf, eintraege, name) {
    const e = eintraege[name];
    if (!e) return null;
    const dv = new DataView(buf);
    const start = e.lokal + 30 + dv.getUint16(e.lokal + 26, true) + dv.getUint16(e.lokal + 28, true);
    const daten = new Uint8Array(buf, start, e.groesse);
    let text;
    if (e.methode === 0) text = new TextDecoder().decode(daten);
    else if (e.methode === 8) text = await new Response(new Blob([daten]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
    else throw new Error('Unbekannte Komprimierung in der Excel-Datei.');
    // WinOffice schreibt die Tags mit Präfix (<x:row>, <x:c>) – Präfixe entfernen, damit die Suche einfach bleibt
    return text.replace(/<(\/?)[A-Za-z][\w.-]*:/g, '<$1');
  }

  // ---------- XML-Hilfen ----------
  const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  function entschluesseln(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, c) =>
      c[0] === '#' ? String.fromCodePoint(c[1] === 'x' || c[1] === 'X' ? parseInt(c.slice(2), 16) : parseInt(c.slice(1), 10)) : (ENT[c] ?? m));
  }
  function textAus(xml) { // alle <t>…</t> zusammen (Rich Text)
    let s = '';
    for (const m of xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) s += m[1];
    return entschluesseln(s);
  }
  function normKopf(s) { return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase(); }

  // Tabellenblatt finden: das mit dem Namen, sonst das erste
  async function blattFinden(buf, eintraege, gesuchterName) {
    const wb = await zipText(buf, eintraege, 'xl/workbook.xml');
    const rels = await zipText(buf, eintraege, 'xl/_rels/workbook.xml.rels');
    const alle = wb ? [...wb.matchAll(/<sheet\b[^>]*>/g)].map(m => m[0]) : [];
    const nameVon = s => entschluesseln((s.match(/name="([^"]*)"/) || [])[1] || '');
    const sheet = gesuchterName ? [alle.find(s => normKopf(nameVon(s)) === normKopf(gesuchterName))] : alle;
    if (gesuchterName && !sheet[0]) return null;
    if (sheet[0] && rels) {
      const rid = (sheet[0].match(/r:id="([^"]+)"/) || [])[1];
      const blattName = entschluesseln((sheet[0].match(/name="([^"]*)"/) || [])[1] || '');
      for (const r of rels.matchAll(/<Relationship\b[^>]*>/g)) {
        if (r[0].includes(`Id="${rid}"`)) {
          let ziel = (r[0].match(/Target="([^"]+)"/) || [])[1];
          ziel = ziel.startsWith('/') ? ziel.slice(1) : 'xl/' + ziel;
          return { pfad: ziel, name: blattName };
        }
      }
    }
    return { pfad: 'xl/worksheets/sheet1.xml', name: '' };
  }

  // Zellwert als Text (ohne gemeinsame Texte aufzulösen: die kommen über den Index)
  function zellwert(attr, inhalt) {
    const t = (attr.match(/\bt="([^"]+)"/) || [])[1] || 'n';
    if (t === 'inlineStr') return { text: textAus(inhalt) };
    const v = (inhalt.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
    if (v === undefined) return { text: '' };
    if (t === 's') return { index: parseInt(v, 10) };
    if (t === 'n') { const z = Number(v); return { text: Number.isFinite(z) && Math.abs(z) >= 1e6 ? BigInt(Math.round(z)).toString() : v }; }
    return { text: entschluesseln(v) };
  }

  /**
   * Liest aus einem Blatt nur die Spalten in `spalten` ({feld: [Bezeichnungen]}).
   * Ergebnis: { zeilen: [{feld: wert}], blatt, spalten: {feld: 'E', …} }. Andere Spalten werden nie entschlüsselt.
   */
  async function tabelle(datei, spalten, pflicht, blattName) {
    const buf = await datei.arrayBuffer();
    const eintraege = await zipEintraege(buf);
    const blatt = await blattFinden(buf, eintraege, blattName);
    if (!blatt) throw new Error(`In der Datei fehlt das Blatt «${blattName}».`);
    const xml = await zipText(buf, eintraege, blatt.pfad);
    if (!xml) throw new Error('Tabellenblatt nicht gefunden.');

    // Gemeinsame Texte: nur die benötigten Einträge entschlüsseln
    let sstXml;
    async function gemeinsameTexte(benoetigt) {
      if (sstXml === undefined) sstXml = await zipText(buf, eintraege, 'xl/sharedStrings.xml');
      const res = new Map();
      if (!sstXml) return res;
      let i = 0;
      for (const m of sstXml.matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)) {
        if (benoetigt.has(i)) res.set(i, m[1] ? textAus(m[1]) : '');
        i++;
      }
      return res;
    }

    // Zelle: <c r="E12" t="s" …><v>…</v></c> – Reihenfolge der Attribute ist nicht fest
    const zelleRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    const adresse = attr => (attr.match(/\br="([A-Z]+)(\d+)"/) || []);

    // 1. Kopfzeile: Spalten über die Bezeichnung finden
    const kopf = {};
    const zeile1 = xml.match(/<row\b[^>]*\br="1"[^>]*>([\s\S]*?)<\/row>/);
    if (zeile1) for (const m of zeile1[1].matchAll(zelleRe)) { const a = adresse(m[1]); if (a[1]) kopf[a[1]] = zellwert(m[1], m[2] || ''); }
    const kopfIndex = new Set(Object.values(kopf).filter(w => w.index !== undefined).map(w => w.index));
    const kopfTexte = await gemeinsameTexte(kopfIndex);
    const namen = {};
    for (const [sp, w] of Object.entries(kopf)) namen[sp] = normKopf(w.index !== undefined ? kopfTexte.get(w.index) : w.text);
    const zuordnung = {}; // feld -> Spaltenbuchstabe
    for (const [feld, kandidaten] of Object.entries(spalten)) {
      const k = kandidaten.filter(x => typeof x === 'string').map(normKopf);
      const muster = kandidaten.find(x => x instanceof RegExp);
      let sp = Object.keys(namen).find(s => k.includes(namen[s]));
      if (!sp && muster) sp = Object.keys(namen).find(s => muster.test(namen[s]));
      if (sp) zuordnung[feld] = sp;
    }
    if (!zuordnung[pflicht]) throw new Error(`In der Datei fehlt die Spalte «${spalten[pflicht][0]}». Ist es die richtige Datei?`);
    const gesucht = new Set(Object.values(zuordnung));

    // 2. Nur Zellen der gesuchten Spalten sammeln
    const zeilen = new Map(); // zeile -> {spalte: wert}
    for (const m of xml.matchAll(zelleRe)) {
      const a = adresse(m[1]);
      const z = parseInt(a[2], 10);
      if (!a[1] || z === 1 || !gesucht.has(a[1])) continue;
      let r = zeilen.get(z); if (!r) zeilen.set(z, r = {});
      r[a[1]] = zellwert(m[1], m[2] || '');
    }

    // 3. Texte der gesuchten Spalten auflösen
    const benoetigt = new Set();
    for (const r of zeilen.values()) for (const w of Object.values(r)) if (w.index !== undefined) benoetigt.add(w.index);
    const gemeinsam = await gemeinsameTexte(benoetigt);
    const wert = (r, feld) => {
      const w = zuordnung[feld] && r[zuordnung[feld]];
      if (!w) return '';
      return String(w.index !== undefined ? (gemeinsam.get(w.index) ?? '') : w.text).trim();
    };

    const ergebnis = [];
    for (const z of [...zeilen.keys()].sort((a, b) => a - b)) {
      const r = zeilen.get(z), o = {};
      for (const feld of Object.keys(spalten)) o[feld] = wert(r, feld);
      if (o[pflicht]) ergebnis.push(o);
    }
    return { zeilen: ergebnis, blatt: blatt.name, spalten: zuordnung };
  }

  // ERP-Export (WinOffice Prime): erstes Blatt. Ergebnis: { artikel: [{nr, text, ean, kategorie, marke}], blatt, spalten }
  async function lesen(datei) {
    const r = await tabelle(datei, SPALTEN, 'nr');
    for (const a of r.zeilen) a.ean = a.ean.replace(/\s/g, '');
    return { artikel: r.zeilen, blatt: r.blatt, spalten: r.spalten };
  }

  // Kürzelverzeichnis («Marken und Kuerzel.xlsx», Blatt «Kürzelverzeichnis»): nur Kürzel, Markennamen und Lieferant.
  // Lieferant nur als Ersatz, wenn kein Markenname steht. Ergebnis: { kuerzel: {KÜRZEL: 'Marke' | 'A|B'}, spalten }
  const KUERZEL_SPALTEN = { kuerzel: ['Kürzel', 'Kuerzel'], marke: ['Markennamen', 'Markenname', 'Marke'], lieferant: ['Lieferant'] };
  async function kuerzelLesen(datei) {
    const r = await tabelle(datei, KUERZEL_SPALTEN, 'kuerzel', 'Kürzelverzeichnis');
    const marken = new Map(); // Kürzel -> verschiedene Marken (gleiches Kürzel bei mehreren Marken)
    for (const z of r.zeilen) {
      const k = z.kuerzel.toUpperCase().replace(/_/g, '/').replace(/\s/g, '');
      const m = z.marke || z.lieferant;
      if (!k || !m) continue;
      const s = marken.get(k) || new Set(); s.add(m); marken.set(k, s);
    }
    const kuerzel = {};
    for (const [k, s] of marken) kuerzel[k] = [...s].join('|');
    return { kuerzel, spalten: r.spalten };
  }

  window.LA_XLSX = { lesen, kuerzelLesen, SPALTEN };
})();
