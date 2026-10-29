// Erkennung einer Gestell-Etikette auf einem Foto: Strichcode (wenn vorhanden) + Texterkennung (offline),
// danach Abgleich mit der Artikelliste aus dem ERP-Export.
// Aufbau der Etiketten: [Strichcode] / Bezeichnung (fett) / Artikelnummer (dünn, grau) / Preis.
(function () {
  'use strict';

  const MAX_SEITE = 2800;   // grösste Bildseite für die Texterkennung (Tab-Fotos haben 4128 px)
  const MITTE = [0.18, 0.12, 0.82, 0.88]; // 1. Durchgang: Bildmitte in voller Auflösung (dort ist meist die Etikette)
  const pfad = p => new URL(p, location.href).href;

  // ---------- Vergleich von Artikelnummern ----------
  // Zeichen, die die Texterkennung oft verwechselt, auf eine Form bringen (gilt für Liste und Gelesenes gleich).
  const VERWECHSLUNG = { O: '0', Q: '0', I: '1', L: '1', '|': '1', '!': '1', S: '5', Z: '2', B: '8', G: '6' };
  function norm(nr) { return String(nr || '').toUpperCase().replace(/[–—]/g, '-').replace(/_/g, '/').replace(/\s+/g, ''); }
  function skelett(nr) { return norm(nr).replace(/[OQIL|!SZBG]/g, c => VERWECHSLUNG[c]); }
  // Strichcode vergleichbar machen: nur Ziffern, ohne führende Nullen (UPC-A 12-stellig = EAN-13 mit 0 davor)
  function eanNorm(c) { return String(c || '').replace(/\D/g, '').replace(/^0+/, ''); }
  // Bezeichnung vergleichbar machen (das Lesemodell kennt keine Umlaute: «Handsage» statt «Handsäge»)
  function normText(s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  function abstand(a, b, max) { // Levenshtein mit Abbruch
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let vor = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const akt = [i]; let min = i;
      for (let j = 1; j <= b.length; j++) {
        akt[j] = Math.min(vor[j] + 1, akt[j - 1] + 1, vor[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (akt[j] < min) min = akt[j];
      }
      if (min > max) return max + 1;
      vor = akt;
    }
    return vor[b.length];
  }

  /** Suchindex über die Artikelliste */
  function index(artikel) {
    const nachNr = new Map(), nachSkelett = new Map(), nachEan = new Map(), nachWort = new Map();
    const add = (m, k, a) => { if (!k) return; const l = m.get(k); l ? l.push(a) : m.set(k, [a]); };
    for (const a of artikel) {
      a._norm = norm(a.nr); a._skelett = skelett(a.nr); a._text = normText(a.text);
      add(nachNr, a._norm, a); add(nachSkelett, a._skelett, a); add(nachEan, eanNorm(a.ean), a);
      for (const w of new Set(a._text.split(' '))) if (w.length >= 4 && !/^\d+$/.test(w)) add(nachWort, w, a);
    }
    return { artikel, nachNr, nachSkelett, nachEan, nachWort };
  }

  // Gelesene Nummer -> Artikel mit Güte (1 = genau … 0.35 = entfernt ähnlich)
  function nrTreffer(idx, wort) {
    const n = norm(wort), s = skelett(wort);
    if (idx.nachNr.has(n)) return idx.nachNr.get(n).map(a => ({ a, guete: 1 }));
    if (idx.nachSkelett.has(s)) return idx.nachSkelett.get(s).map(a => ({ a, guete: 0.9 }));
    if (s.length < 6) return [];
    const max = s.length >= 14 ? 3 : s.length >= 10 ? 2 : 1;
    const res = [];
    for (const a of idx.artikel) {
      const d = abstand(s, a._skelett, max);
      if (d <= max) res.push({ a, guete: [1, 0.75, 0.5, 0.35][d] });
    }
    return res.length <= 8 ? res : [];
  }

  // Gelesene Zeile -> Artikel mit ähnlicher Bezeichnung (Güte 0 … 1)
  function textTreffer(idx, zeile) {
    const t = normText(zeile);
    if (t.length < 10) return [];
    const moegliche = new Set();
    for (const w of t.split(' ')) for (const a of idx.nachWort.get(w) || []) moegliche.add(a);
    const res = [];
    for (const a of moegliche) {
      const max = Math.floor(Math.max(t.length, a._text.length) * 0.3);
      const d = abstand(t, a._text, max);
      if (d <= max) res.push({ a, guete: 1 - d / Math.max(t.length, a._text.length) / 0.3 });
    }
    return res;
  }

  // Sieht ein Wort wie eine Artikelnummer aus? (enthält Ziffer, kein Preis, kein Strichcode)
  function wieArtNr(w) {
    return w.length >= 5 && /\d/.test(w) && /^[A-Z0-9][A-Z0-9\-\/._]+$/i.test(w) && !/^\d+[.,]\d{2}/.test(w) && !/^\d{8,14}$/.test(w);
  }
  function putzen(w) { return String(w || '').replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, ''); }

  // ---------- Bild ----------
  // Ausschnitt (Anteile 0…1 des Fotos) als Graustufenbild; zoom > 1 vergrössert kleine Ausschnitte
  function ausschnitt(bmp, [x0, y0, x1, y1], zoom = 1) {
    x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(1, x1); y1 = Math.min(1, y1);
    const sx = bmp.width * x0, sy = bmp.height * y0, sw = bmp.width * (x1 - x0), sh = bmp.height * (y1 - y0);
    const f = Math.min(zoom, MAX_SEITE / Math.max(sw, sh));
    const c = document.createElement('canvas');
    c.width = Math.round(sw * f); c.height = Math.round(sh * f);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.filter = 'grayscale(1) contrast(1.35)';
    ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, c.width, c.height);
    // Umrechnung Bildpunkt im Ausschnitt -> Anteil im ganzen Foto
    c.inFoto = (px, py) => [x0 + px / f / bmp.width, y0 + py / f / bmp.height];
    return c;
  }

  // Die Etikette über den Preis finden («133.00» wird fast immer gelesen) und eng ausschneiden.
  // Massstab ist die Breite b der Preiszahl (die Höhe liest Tesseract wegen der Lochwand oft zu gross):
  // Etikette reicht von 4.6 b links bis 1.3 b rechts vom Zahlende, 2.4 b über bis 0.9 b unter die Zahlmitte.
  function etiketteUeberPreis(bmp, canvas, gel) {
    const preis = gel.woerter.filter(w => /^\d{1,5}[.,]\d{2}$/.test(putzen(w.text))).sort((a, b) => a.mitte - b.mitte)[0];
    if (!preis) return null;
    const { x0, y0, x1, y1 } = preis.b, b = x1 - x0, cy = (y0 + y1) / 2;
    const [a0, b0] = canvas.inFoto(x1 - 4.6 * b, cy - 2.4 * b);
    const [a1, b1] = canvas.inFoto(x1 + 1.3 * b, cy + 0.9 * b);
    return ausschnitt(bmp, [a0, b0, a1, b1], Math.max(1, 2200 / ((a1 - a0) * bmp.width)));
  }

  // Alle Strichcode-Arten, die das Gerät kennt (Produkte tragen nicht nur EAN-13). Findet der Leser im vollen Foto
  // nichts, nochmals verkleinert versuchen: grosse, nah fotografierte Codes werden so oft doch noch gelesen.
  async function strichcodes(bmp) {
    if (!('BarcodeDetector' in window)) return [];
    try {
      const d = new BarcodeDetector();
      for (const seite of [0, 1600, 900]) {
        let bild = bmp, W = bmp.width, H = bmp.height;
        if (seite) {
          const f = seite / Math.max(W, H);
          if (f >= 1) continue;
          bild = document.createElement('canvas'); bild.width = Math.round(W * f); bild.height = Math.round(H * f);
          bild.getContext('2d').drawImage(bmp, 0, 0, bild.width, bild.height);
          W = bild.width; H = bild.height;
        }
        const gefunden = await d.detect(bild);
        if (gefunden.length) return gefunden.map(b => ({
          wert: /^\d+$/.test(b.rawValue) ? eanNorm(b.rawValue) : b.rawValue.trim(),
          mitte: Math.hypot((b.boundingBox.x + b.boundingBox.width / 2 - W / 2) / W, (b.boundingBox.y + b.boundingBox.height / 2 - H / 2) / H),
        })).sort((a, b) => a.mitte - b.mitte);
      }
      return [];
    } catch (e) { console.warn('Strichcode', e); return []; }
  }

  // ---------- Texterkennung (Tesseract, alles lokal aus lib/) ----------
  let worker = null;
  async function vorbereiten() {
    if (!worker) {
      worker = (async () => {
        const w = await Tesseract.createWorker('eng', 1, {
          workerPath: pfad('lib/worker.min.js'),
          corePath: pfad('lib/tesseract-core-simd-lstm.wasm.js'),
          langPath: pfad('lib'),
          workerBlobURL: false,
          gzip: true,
        });
        await w.setParameters({ preserve_interword_spaces: '1' });
        return w;
      })();
      worker.catch(() => { worker = null; });
    }
    return worker;
  }

  // Ein Durchgang Texterkennung -> Wörter (mit Abstand zur Bildmitte) und Zeilen.
  // psm 11 = verstreuter Text (ganzes Foto), psm 6 = ein Textblock (ausgeschnittene Etikette)
  async function lesen(canvas, psm = '11') {
    const w = await vorbereiten();
    await w.setParameters({ tessedit_pageseg_mode: psm });
    const { data } = await w.recognize(canvas);
    const W = canvas.width, H = canvas.height;
    const mitte = b => Math.hypot(((b.x0 + b.x1) / 2 - W / 2) / W, ((b.y0 + b.y1) / 2 - H / 2) / H);
    let woerter = data.words || [];
    let zeilen = data.lines || [];
    if (!woerter.length && data.blocks) { // neuere Fassungen liefern nur blocks
      zeilen = data.blocks.flatMap(b => b.paragraphs.flatMap(p => p.lines));
      woerter = zeilen.flatMap(l => l.words.map(w => ({ ...w, line: l })));
    }
    return {
      woerter: woerter.map(w => ({ text: w.text, b: w.bbox, line: w.line, mitte: mitte(w.bbox) })),
      zeilen: zeilen.map(l => ({ text: l.text.trim(), b: l.bbox, mitte: mitte(l.bbox) })).filter(l => l.text),
    };
  }

  // Wörter, die eine Artikelnummer sein könnten (auch zwei Nachbarn zusammen, falls getrennt gelesen)
  function nummernStuecke(woerter) {
    const res = [];
    woerter.forEach((w, i) => {
      const t = putzen(w.text);
      if (wieArtNr(t)) res.push({ t, w });
      const n = woerter[i + 1];
      if (n && n.line === w.line) { const z = putzen(w.text + n.text); if (wieArtNr(z) && z.length <= 24) res.push({ t: z, w }); }
    });
    return res;
  }

  // Strichcode -> Artikel: über die EAN, sonst steht im Code evtl. direkt die Artikelnummer
  function codeTreffer(idx, wert) { return idx.nachEan.get(eanNorm(wert)) || idx.nachNr.get(norm(wert)) || []; }

  // Punkte pro Artikel: Nummer + Bezeichnung + Strichcode, Abzug für Abstand zur Bildmitte
  function bewerten(idx, gel, codes) {
    const k = new Map(); // nr -> {a, nr, text, ean, mitte}
    const eintrag = a => { let e = k.get(a.nr); if (!e) k.set(a.nr, e = { a, nr: 0, text: 0, ean: 0, mitte: 1 }); return e; };
    for (const s of nummernStuecke(gel.woerter)) for (const t of nrTreffer(idx, s.t)) {
      const e = eintrag(t.a); if (t.guete > e.nr) { e.nr = t.guete; e.mitte = Math.min(e.mitte, s.w.mitte); }
    }
    for (const z of gel.zeilen) for (const t of textTreffer(idx, z.text)) {
      const e = eintrag(t.a); if (t.guete > e.text) { e.text = t.guete; e.mitte = Math.min(e.mitte, z.mitte); }
    }
    for (const c of codes) for (const a of codeTreffer(idx, c.wert)) { const e = eintrag(a); e.ean = 1; e.mitte = Math.min(e.mitte, c.mitte); }
    return [...k.values()].map(e => ({
      a: e.a,
      punkte: e.nr + 0.6 * e.text + 0.5 * e.ean - 0.6 * e.mitte,
      grund: [e.nr >= 1 ? 'Nummer gelesen' : e.nr ? 'Nummer ähnlich' : '', e.text ? 'Bezeichnung' : '', e.ean ? 'Strichcode' : ''].filter(Boolean).join(' + '),
    })).sort((a, b) => b.punkte - a.punkte).slice(0, 6);
  }
  const istSicher = ([k1, k2]) => !!k1 && k1.punkte >= 0.75 && (!k2 || k1.punkte - k2.punkte >= 0.25);

  // Ohne Treffer in der Liste: Nummer nahe der Bildmitte, Bezeichnung = Textzeile direkt darüber.
  // Die Nummer steht auf der Etikette allein auf ihrer Zeile und beginnt meist mit einem Kürzel (KSI…, AR-…).
  const textZeile = t => t.replace(/[|_~=«»"“”]+/g, ' ').replace(/\s+/g, ' ').trim();
  function rohLesen(gel) {
    const kuerzel = Object.keys(window.LA_KUERZEL || {}).map(norm);
    const stuecke = nummernStuecke(gel.woerter).map(s => {
      const allein = s.w.line && putzen(textZeile(s.w.line.text || '')).replace(/\s/g, '') === s.t;
      const mitKuerzel = kuerzel.some(k => norm(s.t).startsWith(k));
      return { ...s, wert: s.w.mitte - (allein ? 0.3 : 0) - (mitKuerzel ? 0.2 : 0) - (/^[A-Z]/i.test(s.t) ? 0.1 : 0) };
    }).sort((a, b) => a.wert - b.wert);
    const best = stuecke[0];
    if (!best) return null;
    const b = best.w.b, h = b.y1 - b.y0;
    const darueber = gel.zeilen
      .map(l => ({ ...l, text: textZeile(l.text) }))
      .filter(l => /[A-Za-z]{3,}\S*\s+\S/.test(l.text) && l.b.y1 <= b.y0 + h * 0.5 && l.b.y1 > b.y0 - h * 4)
      .sort((x, y) => y.b.y1 - x.b.y1);
    return { nr: norm(best.t), text: darueber.length ? darueber[0].text : '' };
  }

  /**
   * Foto auswerten. idx: Suchindex (oder null ohne Artikelliste).
   * Ergebnis: { kandidaten: [{a, punkte, grund}], sicher, roh: {nr, text}, ean, zeit, gelesen }
   */
  async function erkennen(datei, idx) {
    const t0 = performance.now();
    const bmp = await createImageBitmap(datei, { imageOrientation: 'from-image' });
    try {
      const codesP = strichcodes(bmp);
      // Strichcode zuerst: Gehört der Code der mittleren Etikette zu genau einem Artikel, ist das sicher genug
      // (keine Texterkennung nötig). Ein zweiter Code fast gleich nah an der Mitte (Nachbar-Etikette) -> doch lesen.
      if (idx) {
        const codes = await codesP;
        const [c1, c2] = codes.filter(c => codeTreffer(idx, c.wert).length);
        const treffer = c1 ? codeTreffer(idx, c1.wert) : [];
        const nachbar = c2 && c2.wert !== c1.wert && c2.mitte - c1.mitte < 0.1;
        if (treffer.length === 1 && !nachbar) {
          return { kandidaten: [{ a: treffer[0], punkte: 2, grund: 'Strichcode' }], sicher: true, roh: null, ean: c1.wert,
            zeit: Math.round(performance.now() - t0), gelesen: [] };
        }
      }
      const mitte = ausschnitt(bmp, MITTE);
      let gel = await lesen(mitte);
      const codes = await codesP;
      let kandidaten = idx ? bewerten(idx, gel, codes) : [];
      let roh = rohLesen(gel);
      // 2. Durchgang: nur die Etikette (über den Preis gefunden), vergrössert – die Lochwand rundherum stört sonst
      if (!istSicher(kandidaten)) {
        const etikette = etiketteUeberPreis(bmp, mitte, gel);
        if (etikette) {
          const gelE = await lesen(etikette, '6');
          const kE = idx ? bewerten(idx, gelE, codes) : [];
          if (!idx || istSicher(kE) || (kE[0] && (!kandidaten[0] || kE[0].punkte > kandidaten[0].punkte))) { kandidaten = kE; gel = gelE; }
          roh = rohLesen(gelE) || roh;
        }
      }
      // 3. Durchgang über das ganze Bild, wenn das nicht reicht (Etikette am Rand oder sehr nah fotografiert)
      if (!istSicher(kandidaten) && !(roh && !idx)) {
        const gel2 = await lesen(ausschnitt(bmp, [0, 0, 1, 1]));
        const k2 = idx ? bewerten(idx, gel2, codes) : [];
        if (istSicher(k2) || (k2[0] && (!kandidaten[0] || k2[0].punkte > kandidaten[0].punkte))) { kandidaten = k2; gel = gel2; }
        roh = roh || rohLesen(gel2);
      }
      return { kandidaten, sicher: istSicher(kandidaten), roh, ean: codes[0] ? codes[0].wert : '',
        zeit: Math.round(performance.now() - t0), gelesen: gel.zeilen.map(z => z.text) };
    } finally { bmp.close && bmp.close(); }
  }

  // _intern: nur zum Abstimmen der Erkennung (Konsole), wird vom Tool selbst nicht gebraucht
  window.LA_ERKENNUNG = { index, erkennen, vorbereiten, norm, skelett, codeTreffer, eanNorm, MITTE, _intern: { ausschnitt, lesen, etiketteUeberPreis, bewerten, textTreffer, MITTE } };
})();
