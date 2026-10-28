// Material-Verkaufsladen – Liste der Artikel, die im Laden fehlen. Alles bleibt auf dem Tab (localStorage).
(function () {
  'use strict';

  const VERSION = '0.2.3 (28.10.2026)';
  const $ = id => document.getElementById(id);
  const E = window.LA_ERKENNUNG;

  // ---------- Speicher ----------
  function laden(k, std) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : std; } catch { return std; } }
  function speichern(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); }
    catch (e) { meldung('Speichern ging nicht: ' + e.message, 'fehler'); }
  }
  let liste = laden('la-liste', []);         // [{nr, text, marke, menge, erledigt, unsicher, zeit}]
  let stamm = laden('la-artikel', null);      // {datei, stand, artikel: [{nr, text, ean, kategorie, marke}]}
  let idx = stamm ? E.index(stamm.artikel) : null;
  const sichern = () => speichern('la-liste', liste);
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  // ---------- Marke ----------
  // Reihenfolge: Spalte Marke (ERP) -> Kürzelverzeichnis -> Artikelkategorie (ERP)
  // Das Kürzelverzeichnis ist nicht im Programm (das liegt öffentlich im Internet), es wird auf dem Tab geladen.
  let kuerzelStamm = laden('la-kuerzel', null); // {datei, stand, kuerzel: {KÜRZEL: Marke}}
  let KUERZEL = [];
  function kuerzelBereit() {
    window.LA_KUERZEL = kuerzelStamm ? kuerzelStamm.kuerzel : {}; // auch für die Texterkennung ohne Artikelliste
    KUERZEL = Object.entries(window.LA_KUERZEL)
      .map(([k, m]) => [k.toUpperCase().replace(/_/g, '/'), m]).sort((a, b) => b[0].length - a[0].length);
  }
  kuerzelBereit();
  function kuerzelMarke(nr) {
    const n = E.norm(nr);
    const t = KUERZEL.find(([k]) => n.startsWith(k));
    return t ? t[1] : '';
  }
  function markeFuer(nr, a) {
    if (a && a.marke) return a.marke;
    let k = kuerzelMarke(nr);
    if (k.includes('|')) { // mehrere Marken möglich: die nehmen, die in der Kategorie vorkommt
      const opt = k.split('|');
      k = (a && opt.find(o => a.kategorie.toLowerCase().includes(o.toLowerCase()))) || opt[0];
    }
    if (k) return k;
    if (a && a.kategorie) return a.kategorie;
    return 'Ohne Marke';
  }
  function artikelZu(nr) { return idx ? (idx.nachNr.get(E.norm(nr)) || [])[0] : null; }

  // ---------- Liste ändern ----------
  let zuletzt = null; // für «Rückgängig»
  function hinzufuegen(nr, text, unsicher) {
    nr = E.norm(nr);
    const a = artikelZu(nr);
    let z = liste.find(x => E.norm(x.nr) === nr);
    if (z) { z.menge++; z.erledigt = false; }
    else {
      z = { nr: a ? a.nr : nr, text: a ? a.text : (text || ''), marke: markeFuer(nr, a), menge: 1, erledigt: false, unsicher: !a && !!unsicher, zeit: Date.now() };
      liste.push(z);
    }
    zuletzt = z.nr;
    sichern(); zeichnen(z.nr);
    meldung(`${z.nr} · ${z.menge} Stk.`, 'ok', 'Rückgängig', () => {
      const y = liste.find(x => x.nr === zuletzt);
      if (!y) return;
      if (y.menge > 1) y.menge--; else liste = liste.filter(x => x !== y);
      sichern(); zeichnen(); meldung('Rückgängig gemacht');
    });
  }
  function ersetzen(alt, nr, text) {
    const a = artikelZu(nr);
    const z = liste.find(x => x.nr === alt);
    if (!z) return;
    const doppelt = liste.find(x => x !== z && E.norm(x.nr) === E.norm(nr));
    if (doppelt) { doppelt.menge += z.menge; liste = liste.filter(x => x !== z); }
    else Object.assign(z, { nr: a ? a.nr : E.norm(nr), text: a ? a.text : text, marke: markeFuer(nr, a), unsicher: false });
    sichern(); zeichnen(a ? a.nr : E.norm(nr));
  }

  // ---------- Anzeige ----------
  const sortierer = new Intl.Collator('de-CH', { numeric: true, sensitivity: 'base' });
  function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }

  function zeichnen(neu) {
    // Status Artikelliste
    const st = $('status-artikel');
    if (stamm) {
      st.className = 'hb-hinweis'; st.innerHTML = `Artikelliste vom <b>${esc(stamm.stand)}</b> · ${stamm.artikel.length} Artikel` +
        (kuerzelStamm ? ` · Kürzel vom <b>${esc(kuerzelStamm.stand)}</b>` : ' · <button type="button" class="leise" data-aktion="kuerzel">Kürzelverzeichnis laden</button>');
    }
    else { st.className = 'hb-hinweis warn'; st.innerHTML = 'Noch keine Artikelliste geladen. Ohne Liste übernimmt das Tool nur, was es von der Etikette lesen kann. <button type="button" class="leise" data-aktion="erp">Artikelliste laden</button>'; }

    const offen = liste.filter(z => !z.erledigt);
    $('zusammenfassung').innerHTML = liste.length
      ? `<b>${liste.length}</b> Artikel · <b>${liste.reduce((s, z) => s + z.menge, 0)}</b> Stück · noch <b>${offen.length}</b> zu holen`
      : '';
    $('leer').hidden = liste.length > 0;

    const gruppen = new Map();
    for (const z of liste) { const g = gruppen.get(z.marke); g ? g.push(z) : gruppen.set(z.marke, [z]); }
    const namen = [...gruppen.keys()].sort((a, b) => (a === 'Ohne Marke') - (b === 'Ohne Marke') || sortierer.compare(a, b));
    $('liste').innerHTML = namen.map(m => {
      const zeilen = gruppen.get(m).sort((a, b) => a.erledigt - b.erledigt || sortierer.compare(a.nr, b.nr));
      const rest = zeilen.filter(z => !z.erledigt).length;
      return `<section class="la-gruppe"><div class="la-gruppe-kopf"><b>${esc(m)}</b><span>${rest ? rest + ' offen' : 'alles eingesammelt ✓'}</span></div>` +
        zeilen.map(z => `<div class="la-zeile${z.erledigt ? ' erledigt' : ''}${z.nr === neu ? ' neu' : ''}" data-nr="${esc(z.nr)}">
          <button type="button" class="la-haken" data-aktion="haken" aria-label="eingesammelt">✓</button>
          <div class="la-text" data-aktion="bearbeiten">
            <div class="la-nr">${esc(z.nr)}${z.unsicher ? '<span class="la-unsicher">bitte prüfen</span>' : ''}</div>
            <div class="la-bez">${esc(z.text) || '<span class="hb-leise">(ohne Bezeichnung)</span>'}</div>
          </div>
          <div class="la-menge">
            <button type="button" class="leise" data-aktion="minus" aria-label="weniger">−</button>
            <output>${z.menge}</output>
            <button type="button" data-aktion="plus" aria-label="mehr">+</button>
          </div></div>`).join('') + '</section>';
    }).join('');
    if (neu) { const el = document.querySelector(`.la-zeile[data-nr="${CSS.escape(neu)}"]`); el && el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  }

  $('liste').addEventListener('click', e => {
    const el = e.target.closest('[data-aktion]'); if (!el) return;
    const zeile = el.closest('.la-zeile'); if (!zeile) return;
    const z = liste.find(x => x.nr === zeile.dataset.nr); if (!z) return;
    const a = el.dataset.aktion;
    if (a === 'haken') { z.erledigt = !z.erledigt; }
    else if (a === 'plus') { z.menge++; z.erledigt = false; }
    else if (a === 'minus') {
      if (z.menge > 1) z.menge--;
      else { frage('Artikel entfernen?', `${z.nr} aus der Liste entfernen?`, 'Entfernen').then(ja => { if (ja) { liste = liste.filter(x => x !== z); sichern(); zeichnen(); } }); return; }
    }
    else if (a === 'bearbeiten') { artikelDialog({ modus: 'bearbeiten', zeile: z }); return; }
    sichern(); zeichnen();
  });

  // ---------- Meldungen ----------
  let meldungUhr;
  function meldung(text, art, knopfText, knopfFn) {
    const m = $('hb-meldung'), k = $('hb-meldung-knopf');
    if (art === 'fehler' && !knopfText) knopfText = 'OK';
    $('hb-meldung-text').textContent = text;
    m.className = 'an' + (art ? ' ' + art : '');
    k.hidden = !knopfText; k.textContent = knopfText || ''; k.onclick = () => { m.className = ''; knopfFn && knopfFn(); };
    clearTimeout(meldungUhr); meldungUhr = setTimeout(() => { m.className = ''; }, art === 'fehler' ? 15000 : knopfText ? 6000 : 3500); // Fehler lange stehen lassen (zum Lesen)
  }
  function warten(text) { $('hb-laden-text').textContent = text || 'Bitte warten …'; $('hb-laden').classList.toggle('an', !!text); }
  function frage(titel, text, ja) {
    const d = $('dlg-frage');
    $('dlg-frage-titel').textContent = titel; $('dlg-frage-text').textContent = text; $('dlg-frage-ja').textContent = ja || 'OK';
    d.showModal();
    return new Promise(res => {
      $('dlg-frage-ja').onclick = () => { d.close(); res(true); };
      $('dlg-frage-nein').onclick = () => { d.close(); res(false); };
      d.oncancel = () => res(false);
    });
  }

  // ---------- Artikel-Dialog (Auswahl nach Scan, Korrektur, Eintippen) ----------
  let dlg = null;
  function vorschlagHtml(a, grund) {
    return `<button type="button" class="la-vorschlag" data-nr="${esc(a.nr)}"><span class="la-nr">${esc(a.nr)}</span><br>${esc(a.text)}` +
      `<small>${esc(markeFuer(a.nr, a))}${a.ean ? ' · EAN ' + esc(a.ean) : ''}${grund ? ' · ' + esc(grund) : ''}</small></button>`;
  }
  function artikelDialog(o) {
    dlg = o;
    const d = $('dlg-artikel');
    $('dlg-artikel-titel').textContent = o.modus === 'scan' ? 'Welcher Artikel ist es?' : o.modus === 'bearbeiten' ? 'Artikel korrigieren' : 'Artikel eintippen';
    let info = '';
    if (o.modus === 'bearbeiten') info = `<div class="la-gross">${esc(o.zeile.nr)}</div><div>${esc(o.zeile.text)}</div><p class="hb-leise hb-klein">Falsch gelesen? Unten den richtigen Artikel suchen.</p>`;
    if (o.modus === 'scan') {
      info = o.kandidaten.length ? '<p class="hb-leise">Nicht ganz sicher gelesen – tippe auf den richtigen Artikel:</p>'
        : `<div class="hb-hinweis warn">${idx ? 'Kein passender Artikel in der Artikelliste gefunden.' : 'Keine Artikelliste geladen.'}` +
          `${o.roh ? ` Gelesen: <b>${esc(o.roh.nr)}</b>` : ' Auf dem Foto konnte keine Nummer gelesen werden.'}</div>`;
    }
    $('dlg-artikel-info').innerHTML = info;
    const bild = $('dlg-artikel-bild');
    bild.hidden = !o.bildUrl; bild.innerHTML = o.bildUrl ? `<img src="${o.bildUrl}" alt="Foto">` : '';
    $('dlg-artikel-vorschlaege').innerHTML = (o.kandidaten || []).map(k => vorschlagHtml(k.a, k.grund)).join('');
    $('dlg-artikel-suche').value = '';
    $('dlg-artikel-treffer').innerHTML = '';
    $('dlg-artikel-loeschen').hidden = o.modus !== 'bearbeiten';
    // Frei eintragen: ohne Liste immer, mit Liste nur wenn nichts gefunden
    const frei = $('dlg-artikel-frei');
    frei.hidden = !!idx && !(o.modus === 'scan' && !o.kandidaten.length);
    $('frei-nr').value = o.roh ? o.roh.nr : (o.zeile ? o.zeile.nr : '');
    $('frei-text').value = o.roh ? o.roh.text : (o.zeile ? o.zeile.text : '');
    d.showModal();
    if (o.modus === 'eintippen') setTimeout(() => $('dlg-artikel-suche').focus(), 50);
  }
  function dialogFertig(nr, text, unsicher) {
    $('dlg-artikel').close();
    if (dlg.bildUrl) URL.revokeObjectURL(dlg.bildUrl);
    if (dlg.modus === 'bearbeiten') ersetzen(dlg.zeile.nr, nr, text);
    else hinzufuegen(nr, text, unsicher);
  }
  $('dlg-artikel-vorschlaege').addEventListener('click', e => { const b = e.target.closest('[data-nr]'); if (b) dialogFertig(b.dataset.nr); });
  $('dlg-artikel-treffer').addEventListener('click', e => { const b = e.target.closest('[data-nr]'); if (b) dialogFertig(b.dataset.nr); });
  $('frei-ok').onclick = () => {
    const nr = $('frei-nr').value.trim();
    if (!nr) { $('frei-nr').focus(); return; }
    dialogFertig(nr, $('frei-text').value.trim(), dlg.modus === 'scan');
  };
  $('dlg-artikel-zu').onclick = () => { $('dlg-artikel').close(); if (dlg && dlg.bildUrl) URL.revokeObjectURL(dlg.bildUrl); };
  $('dlg-artikel-loeschen').onclick = () => {
    liste = liste.filter(x => x !== dlg.zeile); sichern(); $('dlg-artikel').close(); zeichnen(); meldung(`${dlg.zeile.nr} entfernt`);
  };
  $('dlg-artikel-suche').addEventListener('input', e => {
    const q = e.target.value.trim();
    const ziel = $('dlg-artikel-treffer');
    if (!idx) { if (q) $('frei-nr').value = q.toUpperCase(); ziel.innerHTML = ''; return; }
    if (q.length < 2) { ziel.innerHTML = ''; return; }
    const teile = q.toLowerCase().split(/\s+/);
    const qn = E.norm(q), qs = E.skelett(q);
    const res = [];
    for (const a of idx.artikel) {
      const hay = (a.nr + ' ' + a.text).toLowerCase();
      if (a._norm.includes(qn) || a._skelett.includes(qs) || teile.every(t => hay.includes(t))) {
        res.push(a); if (res.length >= 40) break;
      }
    }
    res.sort((x, y) => (y._norm.startsWith(qn)) - (x._norm.startsWith(qn)) || sortierer.compare(x.nr, y.nr));
    ziel.innerHTML = res.length ? res.slice(0, 25).map(a => vorschlagHtml(a)).join('')
      : '<p class="hb-leise">Nichts gefunden. <button type="button" class="leise" id="frei-zeigen">Trotzdem so eintragen</button></p>';
    const fz = $('frei-zeigen'); if (fz) fz.onclick = () => { $('dlg-artikel-frei').hidden = false; $('frei-nr').value = q.toUpperCase(); $('frei-text').focus(); };
  });

  // ---------- Scannen ----------
  $('knopf-scannen').onclick = () => { $('foto').value = ''; $('foto').click(); E.vorbereiten().catch(() => {}); };
  $('knopf-tippen').onclick = () => artikelDialog({ modus: 'eintippen', kandidaten: [] });
  $('foto').addEventListener('change', async e => {
    const datei = e.target.files && e.target.files[0];
    if (!datei) return;
    await fotoAuswerten(datei);
  });
  async function fotoAuswerten(datei) {
    warten('Etikette wird gelesen …');
    let r;
    try { r = await E.erkennen(datei, idx); }
    catch (err) { warten(); console.error(err); meldung('Lesen ging nicht: ' + (err.message || err), 'fehler'); return; }
    warten();
    console.info('Erkennung', r.zeit + ' ms', r);
    if (r.sicher) { hinzufuegen(r.kandidaten[0].a.nr); return r; }
    artikelDialog({ modus: 'scan', kandidaten: r.kandidaten, roh: r.roh, bildUrl: URL.createObjectURL(datei) });
    return r;
  }

  // Gewählte Datei sofort ganz einlesen, erst dann die Auswahl leeren: Android (Google Drive) entzieht sonst
  // die Leseberechtigung, und das Lesen scheitert mit «permission problems» (NotReadableError).
  async function dateiHolen(e) {
    const f = e.target.files && e.target.files[0];
    if (!f) return null;
    try { return new File([await f.arrayBuffer()], f.name, { lastModified: f.lastModified }); }
    catch (err) {
      console.error(err);
      meldung('Die Datei konnte nicht gelesen werden. Lade sie in Google Drive zuerst herunter (⋮ → Herunterladen) und wähle sie dann unter «Downloads».', 'fehler');
      return null;
    }
    finally { e.target.value = ''; }
  }

  // ---------- ERP-Export laden ----------
  $('datei-erp').addEventListener('change', async e => {
    warten('Artikelliste wird gelesen …');
    const datei = await dateiHolen(e);
    if (!datei) return warten();
    try {
      const r = await window.LA_XLSX.lesen(datei);
      if (!r.artikel.length) throw new Error('Keine Artikel in der Datei gefunden.');
      const m = datei.name.match(/(\d{4})-(\d{2})-(\d{2})/);
      const stand = m ? `${m[3]}.${m[2]}.${m[1]}` : new Date(datei.lastModified).toLocaleDateString('de-CH');
      stamm = { datei: datei.name, stand, artikel: r.artikel };
      speichern('la-artikel', stamm);
      idx = E.index(stamm.artikel);
      // Bestehende Liste mit den neuen Angaben auffrischen
      for (const z of liste) { const a = artikelZu(z.nr); if (a) Object.assign(z, { nr: a.nr, text: a.text, marke: markeFuer(a.nr, a), unsicher: false }); else z.marke = markeFuer(z.nr, null); }
      sichern(); warten(); zeichnen();
      const fehlt = ['text', 'ean', 'kategorie', 'marke'].filter(f => !r.spalten[f]);
      meldung(`${r.artikel.length} Artikel geladen` + (fehlt.length ? ` (Spalte fehlt: ${fehlt.join(', ')})` : ''), fehlt.length ? 'fehler' : 'ok');
    } catch (err) { warten(); console.error(err); meldung('Artikelliste: ' + (err.message || err), 'fehler'); }
  });

  // ---------- Kürzelverzeichnis laden ----------
  $('datei-kuerzel').addEventListener('change', async e => {
    warten('Kürzelverzeichnis wird gelesen …');
    const datei = await dateiHolen(e);
    if (!datei) return warten();
    try {
      const r = await window.LA_XLSX.kuerzelLesen(datei);
      const anzahl = Object.keys(r.kuerzel).length;
      if (!anzahl) throw new Error('Keine Kürzel in der Datei gefunden.');
      kuerzelStamm = { datei: datei.name, stand: new Date(datei.lastModified).toLocaleDateString('de-CH'), kuerzel: r.kuerzel };
      speichern('la-kuerzel', kuerzelStamm);
      kuerzelBereit();
      for (const z of liste) z.marke = markeFuer(z.nr, artikelZu(z.nr));
      sichern(); warten(); zeichnen();
      meldung(`${anzahl} Kürzel geladen`, 'ok');
    } catch (err) { warten(); console.error(err); meldung('Kürzelverzeichnis: ' + (err.message || err), 'fehler'); }
  });

  // Vor dem Laden kurz zeigen, wie es geht: Datei zuerst aus Google Drive herunterladen, dann unter Downloads wählen
  function ladenAnleitung(titel, datei, inputId) {
    const d = $('dlg-laden');
    $('dlg-laden-titel').textContent = titel;
    $('dlg-laden-datei').textContent = datei;
    $('dlg-laden-ja').onclick = () => { d.close(); $(inputId).click(); };
    $('dlg-laden-nein').onclick = () => d.close();
    d.showModal();
  }

  // ---------- Menü ----------
  document.addEventListener('click', async e => {
    const b = e.target.closest('[data-aktion]'); if (!b || b.closest('#liste')) return;
    const a = b.dataset.aktion;
    if (a === 'erp') { $('dlg-menue').close(); ladenAnleitung('Artikelliste laden', 'ERP-Export …xlsx', 'datei-erp'); }
    else if (a === 'kuerzel') { $('dlg-menue').close(); ladenAnleitung('Kürzelverzeichnis laden', 'Marken und Kuerzel.xlsx', 'datei-kuerzel'); }
    else if (a === 'leeren') {
      $('dlg-menue').close();
      if (!liste.length) return meldung('Die Liste ist schon leer.');
      if (await frage('Liste leeren?', `Alle ${liste.length} Artikel werden aus der Liste entfernt.`, 'Liste leeren')) { liste = []; sichern(); zeichnen(); meldung('Liste geleert', 'ok'); }
    }
    else if (a === 'info') {
      $('dlg-menue').close();
      frage('Material-Verkaufsladen', `Version ${VERSION}. Läuft ohne Internet; Liste und Artikelliste bleiben nur auf diesem Tablet. ` +
        (stamm ? `Artikelliste: ${stamm.datei} (${stamm.artikel.length} Artikel). ` : 'Keine Artikelliste geladen. ') +
        (kuerzelStamm ? `Kürzelverzeichnis: ${kuerzelStamm.datei} (${Object.keys(kuerzelStamm.kuerzel).length} Kürzel).` : 'Kein Kürzelverzeichnis geladen.'), 'OK');
    }
    else if (a === 'zu') $('dlg-menue').close();
  });
  $('knopf-menue').onclick = () => $('dlg-menue').showModal();

  // ---------- Offline ----------
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    // Neue Fassung im Offline-Speicher übernommen -> Seite einmal neu laden, damit sie gleich gilt (nicht erst beim nächsten Start)
    const hatteAlte = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (hatteAlte) location.reload(); });
    navigator.serviceWorker.register('sw.js').catch(e => console.warn('Offline-Speicher', e));
  }

  zeichnen();
  window.LA = { fotoAuswerten, get liste() { return liste; }, get stamm() { return stamm; } }; // zum Testen
})();
