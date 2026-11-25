/* Tileprint – deler et bilde eller en PDF opp i ark for utskrift.
 * Alt kjører i nettleseren. Mål internt er i millimeter, origo øverst til venstre på arket.
 * Den samme layout-funksjonen (sheetLayout) brukes både av forhåndsvisningen (canvas)
 * og av PDF-eksporten, slik at de alltid viser det samme. */
'use strict';

(() => {
  const PAPERS = {
    A4: { w: 210, h: 297, name: 'A4' },
    A3: { w: 297, h: 420, name: 'A3' },
    Letter: { w: 215.9, h: 279.4, name: 'Letter' },
  };
  const MM_TO_PT = 72 / 25.4;
  const LIMITS = {
    maxSheets: 400,
    maxPerSide: 30,
    warnBytes: 50 * 1024 * 1024,
    warnPx: 6000,
    lowDpi: 100,
    previewPx: 2400,
    maxCanvasPx: 16e6, // Safari-grense for canvas-areal
    maxRasterSide: 8000,
  };
  const CDN = {
    pdfLib: 'https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js',
    pdfjs: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
    pdfjsWorker: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
  };
  const STORE_KEY = 'plakat-splitter:innstillinger:v1';
  const DEFAULTS = {
    paper: 'A4',
    orient: 'auto',
    margin: 6,
    borderless: false,
    mode: 'grid',
    cols: 3,
    rows: 4,
    sizeDim: 'width',
    sizeCm: 60,
    overlap: 10,
    edges: { top: false, right: true, bottom: true, left: false },
    cropMarks: true,
    labels: true,
    overview: false,
  };

  const $ = (id) => document.getElementById(id);
  const fmt = (n, d = 1) => n.toLocaleString('nb-NO', { maximumFractionDigits: d, minimumFractionDigits: 0 });
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  const state = {
    settings: loadSettings(),
    source: null,
    geom: null,
    sheet: 0,
    downloadUrl: null,
    busy: false,
  };

  // ---------- Innstillinger ----------

  function loadSettings() {
    const s = structuredClone(DEFAULTS);
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        for (const k of Object.keys(DEFAULTS)) {
          if (k === 'edges' && saved.edges && typeof saved.edges === 'object') {
            for (const e of Object.keys(DEFAULTS.edges)) {
              if (typeof saved.edges[e] === 'boolean') s.edges[e] = saved.edges[e];
            }
          } else if (k in saved && typeof saved[k] === typeof DEFAULTS[k]) {
            s[k] = saved[k];
          }
        }
      }
    } catch (_) { /* privat modus e.l. – bruk standardverdier */ }
    if (!PAPERS[s.paper]) s.paper = DEFAULTS.paper;
    return s;
  }

  function saveSettings() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state.settings)); } catch (_) { /* ignorer */ }
  }

  // ---------- Lasting av eksterne biblioteker ----------

  const scriptCache = {};
  function loadScript(src) {
    if (!scriptCache[src]) {
      scriptCache[src] = new Promise((resolve, reject) => {
        const el = document.createElement('script');
        el.src = src;
        el.async = true;
        el.onload = () => resolve();
        el.onerror = () => {
          delete scriptCache[src];
          el.remove();
          reject(new Error('Kunne ikke laste et nødvendig bibliotek. Sjekk nettforbindelsen og prøv igjen.'));
        };
        document.head.appendChild(el);
      });
    }
    return scriptCache[src];
  }
  async function getPdfLib() {
    if (!window.PDFLib) await loadScript(CDN.pdfLib);
    return window.PDFLib;
  }
  async function getPdfjs() {
    if (!window.pdfjsLib) await loadScript(CDN.pdfjs);
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = CDN.pdfjsWorker;
    return window.pdfjsLib;
  }

  // ---------- Filinnlesing ----------

  function sniffType(buf) {
    const b = new Uint8Array(buf, 0, Math.min(8, buf.byteLength));
    if (b[0] === 0xff && b[1] === 0xd8) return 'jpeg';
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
    if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'pdf';
    return 'other';
  }

  /** Leser EXIF-orientering (1–8) fra en JPEG. Returnerer 1 hvis den mangler. */
  function jpegOrientation(buf) {
    try {
      const v = new DataView(buf);
      if (v.getUint16(0) !== 0xffd8) return 1;
      let off = 2;
      while (off + 4 <= v.byteLength) {
        const marker = v.getUint16(off);
        if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) break;
        const len = v.getUint16(off + 2);
        if (marker === 0xffe1 && v.getUint32(off + 4) === 0x45786966) { // "Exif"
          const tiff = off + 10;
          const little = v.getUint16(tiff) === 0x4949;
          const ifd = tiff + v.getUint32(tiff + 4, little);
          const n = v.getUint16(ifd, little);
          for (let i = 0; i < n; i++) {
            const e = ifd + 2 + i * 12;
            if (v.getUint16(e, little) === 0x0112) {
              const o = v.getUint16(e + 8, little);
              return o >= 1 && o <= 8 ? o : 1;
            }
          }
          return 1;
        }
        off += 2 + len;
      }
    } catch (_) { /* ødelagt EXIF – ignorer */ }
    return 1;
  }

  function fitCanvasSize(w, h, maxSide, maxArea) {
    let k = Math.min(1, maxSide / Math.max(w, h));
    if (w * h * k * k > maxArea) k = Math.sqrt(maxArea / (w * h));
    return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
  }

  function drawToCanvas(src, w, h, maxSide, maxArea = LIMITS.maxCanvasPx) {
    const size = fitCanvasSize(w, h, maxSide, maxArea);
    const c = document.createElement('canvas');
    c.width = size.w;
    c.height = size.h;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, size.w, size.h);
    return c;
  }

  function canvasToBytes(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) return reject(new Error('Kunne ikke konvertere bildet.'));
        blob.arrayBuffer().then(resolve, reject);
      }, type, quality);
    });
  }

  async function loadImageFile(file, bytes) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      try {
        await img.decode();
      } catch (_) {
        throw new Error('Kunne ikke lese bildet. Er filen et gyldig PNG-, JPG- eller WebP-bilde?');
      }
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      let type = sniffType(bytes);
      let orientation = type === 'jpeg' ? jpegOrientation(bytes) : 1;
      const preview = drawToCanvas(img, w, h, LIMITS.previewPx);
      let exportBytes = bytes;
      let note = null;
      if (type !== 'jpeg' && type !== 'png') {
        // Andre formater (f.eks. WebP) gjøres om til PNG for PDF-en.
        const full = drawToCanvas(img, w, h, Infinity);
        if (full.width < w) note = `Bildet er skalert ned til ${full.width} × ${full.height} px for PDF-en (nettleserens grense).`;
        exportBytes = await canvasToBytes(full, 'image/png');
        type = 'png';
        orientation = 1;
      }
      return {
        kind: 'image', name: file.name, size: file.size,
        w, h, pxW: w, pxH: h,
        imgType: type, orientation, exportBytes, preview, note,
      };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function renderPdfPage(page, scale) {
    const viewport = page.getViewport({ scale });
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.floor(viewport.width));
    c.height = Math.max(1, Math.floor(viewport.height));
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    return c;
  }

  async function loadPdfFile(file, bytes) {
    const pdfjs = await getPdfjs();
    let doc;
    try {
      doc = await pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)), isEvalSupported: false }).promise;
    } catch (err) {
      if (err && err.name === 'PasswordException') throw new Error('PDF-en er passordbeskyttet og kan ikke åpnes.');
      throw new Error('Kunne ikke lese PDF-en.');
    }
    const page = await doc.getPage(1);
    const vp = page.getViewport({ scale: 1 });
    const pre = fitCanvasSize(vp.width, vp.height, LIMITS.previewPx, LIMITS.maxCanvasPx);
    const preview = await renderPdfPage(page, pre.w / vp.width);

    // Kan siden bygges inn som vektor (skarp i alle størrelser)?
    let vector = false;
    try {
      const PDFLib = await getPdfLib();
      const src = await PDFLib.PDFDocument.load(bytes.slice(0), { ignoreEncryption: true, updateMetadata: false });
      const rot = ((src.getPage(0).getRotation().angle % 360) + 360) % 360;
      vector = !src.isEncrypted && rot === 0;
    } catch (_) { vector = false; }

    return {
      kind: 'pdf', name: file.name, size: file.size,
      w: vp.width, h: vp.height, pxW: null, pxH: null,
      pdfBytes: bytes, pdfPage: page, pageCount: doc.numPages, vector, preview, note: null,
    };
  }

  async function handleFile(file) {
    if (!file || state.busy) return;
    state.busy = true;
    setStatus('Leser filen …');
    showError(null);
    try {
      const bytes = await file.arrayBuffer();
      const type = sniffType(bytes);
      const src = type === 'pdf' ? await loadPdfFile(file, bytes) : await loadImageFile(file, bytes);
      state.source = src;
      state.sheet = 0;
      clearDownload();
      setStatus('');
      if (state.settings.mode === 'grid' && !state.userSetRows) fitRowsToImage();
      renderFileInfo();
      update();
      getPdfLib().catch(() => {}); // forhåndslast for raskere eksport
    } catch (err) {
      setStatus('');
      showError(err.message || String(err));
    } finally {
      state.busy = false;
      refreshExportButton();
    }
  }

  // ---------- Geometri ----------

  function paperDims(s, orient) {
    const p = PAPERS[s.paper];
    return orient === 'landscape' ? { w: p.h, h: p.w } : { w: p.w, h: p.h };
  }

  function geomFor(s, src, orient) {
    const paper = paperDims(s, orient);
    const m = s.borderless ? 0 : s.margin;
    const ov = s.overlap;
    const o = {
      l: s.edges.left ? ov : 0, r: s.edges.right ? ov : 0,
      t: s.edges.top ? ov : 0, b: s.edges.bottom ? ov : 0,
    };
    const coreW = paper.w - 2 * m - o.l - o.r;
    const coreH = paper.h - 2 * m - o.t - o.b;
    const g = { orient, paper, m, o, coreW, coreH };
    if (coreW < 20 || coreH < 20) {
      return { ...g, error: 'Marg og overlapp er for store for papirstørrelsen. Reduser en av dem.' };
    }
    let cols, rows, posterW, posterH;
    if (s.mode === 'grid') {
      cols = s.cols;
      rows = s.rows;
      const k = Math.min((cols * coreW) / src.w, (rows * coreH) / src.h);
      posterW = src.w * k;
      posterH = src.h * k;
    } else {
      const aspect = src.h / src.w;
      if (s.sizeDim === 'height') { posterH = s.sizeCm * 10; posterW = posterH / aspect; }
      else { posterW = s.sizeCm * 10; posterH = posterW * aspect; }
      cols = Math.max(1, Math.ceil(posterW / coreW - 1e-6));
      rows = Math.max(1, Math.ceil(posterH / coreH - 1e-6));
    }
    const gridW = cols * coreW;
    const gridH = rows * coreH;
    Object.assign(g, {
      cols, rows, sheets: cols * rows, gridW, gridH, posterW, posterH,
      imgX: (gridW - posterW) / 2, imgY: (gridH - posterH) / 2,
      dpi: src.pxW ? src.pxW / (posterW / 25.4) : null,
    });
    if (g.sheets > LIMITS.maxSheets || cols > 99 || rows > 99) {
      g.error = `Det blir ${g.sheets} ark – det er for mange. Maks er ${LIMITS.maxSheets}.`;
    }
    return g;
  }

  function computeGeometry(s, src) {
    if (!src) return null;
    const options = s.orient === 'auto' ? ['portrait', 'landscape'] : [s.orient];
    let best = null;
    for (const o of options) {
      const g = geomFor(s, src, o);
      if (!best) { best = g; continue; }
      if (best.error && !g.error) { best = g; continue; }
      if (g.error) continue;
      const better = s.mode === 'size'
        ? g.sheets < best.sheets
        : g.posterW * g.posterH > best.posterW * best.posterH * (1 + 1e-9);
      if (better) best = g;
    }
    return best;
  }

  function colName(c) {
    let s = '';
    let n = c + 1;
    while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
    return s;
  }
  const sheetName = (c, r) => `${colName(c)}${r + 1}`;

  const BLACK = [0, 0, 0];
  const WHITE = [1, 1, 1];
  const GREY = [0.35, 0.35, 0.35];

  function estimateTextWidth(text, sizeMm, bold) {
    return text.length * sizeMm * (bold ? 0.56 : 0.52);
  }

  function labelOp(text, x, y, sizeMm, rot = 0, align = 'left') {
    const w = estimateTextWidth(text, sizeMm, false);
    if (align === 'center') {
      if (rot === 0) x -= w / 2; else y += w / 2;
    }
    return { t: 'label', text, x, y, sizeMm, rot, w };
  }

  /**
   * Beskriver alt som tegnes på ett ark (kolonne c, rad r) som en liste med
   * tegneoperasjoner i mm. Brukes av både forhåndsvisning og PDF-eksport.
   */
  function sheetLayout(g, c, r, s) {
    const { paper, m, o, coreW, coreH, cols, rows } = g;
    const x0 = m + o.l;
    const y0 = m + o.t;
    const ops = [];

    // Bildet: hele plakaten plassert slik at ark (c, r) sin kjerne havner i [x0, x0+coreW].
    // Klipp til kjernen + overlappsfeltene som har en nabo (ellers er feltet tomt uansett).
    const cx1 = c > 0 ? x0 - o.l : x0;
    const cx2 = c < cols - 1 ? x0 + coreW + o.r : x0 + coreW;
    const cy1 = r > 0 ? y0 - o.t : y0;
    const cy2 = r < rows - 1 ? y0 + coreH + o.b : y0 + coreH;
    ops.push({
      t: 'image',
      clip: { x: cx1, y: cy1, w: cx2 - cx1, h: cy2 - cy1 },
      x: x0 - c * coreW + g.imgX, y: y0 - r * coreH + g.imgY, w: g.posterW, h: g.posterH,
    });

    if (s.cropMarks) {
      const gap = 1;
      const len = Math.min(5, m - gap);
      if (len >= 1) {
        const lw = 0.2;
        for (const x of [x0, x0 + coreW]) {
          ops.push({ t: 'line', x1: x, y1: m - gap, x2: x, y2: m - gap - len, w: lw, color: BLACK });
          ops.push({ t: 'line', x1: x, y1: paper.h - m + gap, x2: x, y2: paper.h - m + gap + len, w: lw, color: BLACK });
        }
        for (const y of [y0, y0 + coreH]) {
          ops.push({ t: 'line', x1: m - gap, y1: y, x2: m - gap - len, y2: y, w: lw, color: BLACK });
          ops.push({ t: 'line', x1: paper.w - m + gap, y1: y, x2: paper.w - m + gap + len, y2: y, w: lw, color: BLACK });
        }
      }
    }

    if (s.labels) {
      const text = `${sheetName(c, r)}  ·  ark ${r * cols + c + 1} av ${cols * rows}  ·  ${cols}×${rows}`;
      // Plasser etiketten i et overlappsfelt (det dekkes av nabo-arket), ellers i margen.
      const sizeFor = (t) => clamp(t * 0.42, 1.8, 3.2); // mm
      if (o.b >= 4) {
        const sz = sizeFor(o.b);
        ops.push(labelOp(text, x0 + 3, y0 + coreH + o.b / 2 + sz * 0.36, sz));
      } else if (o.t >= 4) {
        const sz = sizeFor(o.t);
        ops.push(labelOp(text, x0 + 3, m + o.t / 2 + sz * 0.36, sz));
      } else if (o.r >= 4) {
        const sz = sizeFor(o.r);
        ops.push(labelOp(text, x0 + coreW + o.r / 2 + sz * 0.36, y0 + coreH - 3, sz, 90));
      } else if (o.l >= 4) {
        const sz = sizeFor(o.l);
        ops.push(labelOp(text, m + o.l / 2 + sz * 0.36, y0 + coreH - 3, sz, 90));
      } else if (m >= 4) {
        const sz = sizeFor(m);
        ops.push(labelOp(text, x0 + 8, paper.h - m / 2 + sz * 0.36, sz));
      }
    }

    // Kun for forhåndsvisning: utskriftsområde og overlappsfelt.
    const overlays = {
      printable: { x: m, y: m, w: paper.w - 2 * m, h: paper.h - 2 * m },
      strips: [
        o.t && r > 0 && { x: x0, y: m, w: coreW, h: o.t },
        o.b && r < rows - 1 && { x: x0, y: y0 + coreH, w: coreW, h: o.b },
        o.l && c > 0 && { x: m, y: m, w: o.l, h: paper.h - 2 * m },
        o.r && c < cols - 1 && { x: x0 + coreW, y: m, w: o.r, h: paper.h - 2 * m },
      ].filter(Boolean),
    };
    return { ops, overlays };
  }

  function overviewLayout(g, s, src) {
    const { paper } = g;
    const m = Math.max(g.m, 8);
    const ops = [];
    const title = `Oversikt: ${g.cols} × ${g.rows} ark (${g.sheets} ${PAPERS[s.paper].name}, ${g.orient === 'landscape' ? 'liggende' : 'stående'})`;
    const size = `Plakat: ${fmt(g.posterW / 10)} × ${fmt(g.posterH / 10)} cm · Overlapp: ${fmt(s.overlap)} mm · Fil: ${src.name}`;
    const info = 'Skriv ut med «Faktisk størrelse» (100 %). Klipp langs merkene på kantene uten overlapp og legg arket over nabo-arkets overlappsfelt.';
    const top = Math.max(m, 8);
    ops.push({ t: 'text', text: title, x: m, y: top + 4.5, sizeMm: 4.6, bold: true, color: BLACK });
    ops.push({ t: 'text', text: size, x: m, y: top + 10.5, sizeMm: 3, color: GREY });
    ops.push({ t: 'text', text: info, x: m, y: top + 15.5, sizeMm: 2.6, color: GREY, maxW: paper.w - 2 * m });

    const avail = { x: m, y: top + 22, w: paper.w - 2 * m, h: paper.h - m - (top + 22) };
    const k = Math.min(avail.w / g.gridW, avail.h / g.gridH);
    const gw = g.gridW * k;
    const gh = g.gridH * k;
    const ox = avail.x + (avail.w - gw) / 2;
    const oy = avail.y;
    ops.push({
      t: 'image', clip: { x: ox, y: oy, w: gw, h: gh },
      x: ox + g.imgX * k, y: oy + g.imgY * k, w: g.posterW * k, h: g.posterH * k,
    });
    for (let c = 1; c < g.cols; c++) {
      const x = ox + c * g.coreW * k;
      ops.push({ t: 'line', x1: x, y1: oy, x2: x, y2: oy + gh, w: 0.3, color: [0.85, 0.1, 0.1] });
    }
    for (let r = 1; r < g.rows; r++) {
      const y = oy + r * g.coreH * k;
      ops.push({ t: 'line', x1: ox, y1: y, x2: ox + gw, y2: y, w: 0.3, color: [0.85, 0.1, 0.1] });
    }
    ops.push({ t: 'rect', x: ox, y: oy, w: gw, h: gh, stroke: BLACK, lw: 0.3 });
    const cellMin = Math.min(g.coreW, g.coreH) * k;
    const sz = clamp(cellMin * 0.16, 1.8, 6);
    for (let r = 0; r < g.rows; r++) {
      for (let c = 0; c < g.cols; c++) {
        const cx = ox + (c + 0.5) * g.coreW * k;
        const cy = oy + (r + 0.5) * g.coreH * k;
        ops.push(labelOp(sheetName(c, r), cx, cy + sz * 0.36, sz, 0, 'center'));
      }
    }
    return { ops, overlays: null };
  }

  /**
   * Testark: skalaer fra hver papirkant og inn (0–15 mm) viser hvor mye skriveren
   * kutter, og et kvadrat på 100 × 100 mm viser om skalaen er riktig.
   */
  function testSheetLayout(paper, s) {
    const ops = [];
    const lw = 0.15;
    const cx = paper.w / 2;
    const cy = paper.h / 2;
    const max = 15;
    for (let d = 0; d <= max; d++) {
      const len = d % 5 === 0 ? 8 : 4;
      const p = d === 0 ? lw / 2 : d; // streken ved 0 mm ligger helt inne på arket
      ops.push({ t: 'line', x1: cx - len / 2, y1: p, x2: cx + len / 2, y2: p, w: lw, color: BLACK }); // topp
      ops.push({ t: 'line', x1: cx - len / 2, y1: paper.h - p, x2: cx + len / 2, y2: paper.h - p, w: lw, color: BLACK }); // bunn
      ops.push({ t: 'line', x1: p, y1: cy - len / 2, x2: p, y2: cy + len / 2, w: lw, color: BLACK }); // venstre
      ops.push({ t: 'line', x1: paper.w - p, y1: cy - len / 2, x2: paper.w - p, y2: cy + len / 2, w: lw, color: BLACK }); // høyre
      if (d > 0 && d % 5 === 0) {
        const sz = 2.2;
        ops.push({ t: 'text', text: `${d}`, x: cx + 5, y: d + sz * 0.36, sizeMm: sz, color: BLACK });
        ops.push({ t: 'text', text: `${d}`, x: cx + 5, y: paper.h - d + sz * 0.36, sizeMm: sz, color: BLACK });
        ops.push({ t: 'text', text: `${d}`, x: d - 1, y: cy - 5, sizeMm: sz, color: BLACK });
        ops.push({ t: 'text', text: `${d}`, x: paper.w - d - 1, y: cy - 5, sizeMm: sz, color: BLACK });
      }
    }
    // Kvadrat på 100 × 100 mm
    const q = 100;
    const qx = cx - q / 2;
    const qy = cy - q / 2;
    ops.push({ t: 'rect', x: qx, y: qy, w: q, h: q, stroke: BLACK, lw: 0.2 });
    ops.push({ t: 'text', text: '100 × 100 mm', x: qx + 3, y: qy + 7, sizeMm: 4, bold: true, color: BLACK });
    const lines = [
      `Testark (${PAPERS[s.paper].name}). Skriv ut med de samme innstillingene som plakaten.`,
      '1. Mål kvadratet. Det skal være nøyaktig 100 mm på begge ledd.',
      '   Er det større eller mindre, skalerer skriveren – bruk «Faktisk størrelse» / 100 %',
      '   og slå av forstørrelse ved kantløs utskrift.',
      '2. Se på skalaene midt på hver kant. Første synlige strek viser hvor mange mm',
      '   skriveren ikke når ut til (eller kutter bort ved kantløs utskrift).',
      '   Sett utskriftsmargen litt større enn dette. Kutter kantløs utskrift bort noe,',
      '   velg overlapp på alle fire kanter.',
    ];
    lines.forEach((text, i) => ops.push({ t: 'text', text, x: 20, y: qy + q + 14 + i * 4.6, sizeMm: 2.8, color: GREY }));
    return ops;
  }

  // ---------- Tegning på canvas (forhåndsvisning) ----------

  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const rgbCss = (c) => `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`;

  function labelBox(op) {
    const asc = op.sizeMm * 0.75;
    const desc = op.sizeMm * 0.22;
    const pad = 0.8;
    if (op.rot === 90) {
      return { x: op.x - asc - pad, y: op.y - op.w - pad, w: asc + desc + 2 * pad, h: op.w + 2 * pad };
    }
    return { x: op.x - pad, y: op.y - asc - pad, w: op.w + 2 * pad, h: asc + desc + 2 * pad };
  }

  function drawOpsCanvas(ctx, ops, k, ox, oy, srcCanvas) {
    const X = (v) => ox + v * k;
    const Y = (v) => oy + v * k;
    for (const op of ops) {
      if (op.t === 'image') {
        ctx.save();
        ctx.beginPath();
        ctx.rect(X(op.clip.x), Y(op.clip.y), op.clip.w * k, op.clip.h * k);
        ctx.clip();
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(srcCanvas, X(op.x), Y(op.y), op.w * k, op.h * k);
        ctx.restore();
      } else if (op.t === 'line') {
        ctx.save();
        ctx.strokeStyle = rgbCss(op.color);
        ctx.lineWidth = Math.max(0.75, op.w * k);
        ctx.beginPath();
        ctx.moveTo(X(op.x1), Y(op.y1));
        ctx.lineTo(X(op.x2), Y(op.y2));
        ctx.stroke();
        ctx.restore();
      } else if (op.t === 'rect') {
        ctx.save();
        if (op.fill) { ctx.fillStyle = rgbCss(op.fill); ctx.fillRect(X(op.x), Y(op.y), op.w * k, op.h * k); }
        if (op.stroke) {
          ctx.strokeStyle = rgbCss(op.stroke);
          ctx.lineWidth = Math.max(0.75, op.lw * k);
          ctx.strokeRect(X(op.x), Y(op.y), op.w * k, op.h * k);
        }
        ctx.restore();
      } else if (op.t === 'label' || op.t === 'text') {
        ctx.save();
        if (op.t === 'label') {
          const b = labelBox(op);
          ctx.fillStyle = '#fff';
          ctx.fillRect(X(b.x), Y(b.y), b.w * k, b.h * k);
        }
        ctx.fillStyle = rgbCss(op.color || BLACK);
        ctx.font = `${op.bold ? '700 ' : ''}${op.sizeMm * k}px Helvetica, Arial, sans-serif`;
        ctx.textBaseline = 'alphabetic';
        ctx.translate(X(op.x), Y(op.y));
        if (op.rot === 90) ctx.rotate(-Math.PI / 2);
        if (op.maxW) {
          wrapText(op.text, op.maxW, op.sizeMm, (line, i) => ctx.fillText(line, 0, i * op.sizeMm * 1.3 * k));
        } else {
          ctx.fillText(op.text, 0, 0);
        }
        ctx.restore();
      }
    }
  }

  function wrapText(text, maxW, sizeMm, draw) {
    const words = text.split(' ');
    let line = '';
    let i = 0;
    for (const w of words) {
      const test = line ? `${line} ${w}` : w;
      if (line && estimateTextWidth(test, sizeMm) > maxW) { draw(line, i++); line = w; }
      else line = test;
    }
    if (line) draw(line, i);
  }

  function setupCanvas(canvas, cssW, cssH) {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }

  function boxInnerSize(box) {
    const st = getComputedStyle(box);
    const w = box.clientWidth - parseFloat(st.paddingLeft) - parseFloat(st.paddingRight);
    return Math.max(100, w);
  }

  const posterView = { k: 1, ox: 0, oy: 0 };

  function drawPoster() {
    const canvas = $('posterCanvas');
    const g = state.geom;
    const src = state.source;
    const show = !!(src && g && !g.error);
    canvas.hidden = !show;
    $('emptyState').hidden = !!src;
    if (!show) return;

    const maxW = boxInnerSize($('posterBox'));
    const maxH = Math.max(260, Math.min(window.innerHeight * 0.7, 760));
    const k = Math.min(maxW / g.gridW, maxH / g.gridH);
    const W = g.gridW * k;
    const H = g.gridH * k;
    const ctx = setupCanvas(canvas, W, H);
    posterView.k = k;

    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.clip();
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src.preview, g.imgX * k, g.imgY * k, g.posterW * k, g.posterH * k);
    ctx.restore();

    // Overlappsbånd langs de indre skjøtene
    const { o, coreW, coreH } = g;
    ctx.fillStyle = 'rgba(47,111,143,0.32)';
    for (let c = 1; c < g.cols; c++) {
      const x = c * coreW;
      if (o.l + o.r > 0) ctx.fillRect((x - o.l) * k, 0, (o.l + o.r) * k, H);
    }
    for (let r = 1; r < g.rows; r++) {
      const y = r * coreH;
      if (o.t + o.b > 0) ctx.fillRect(0, (y - o.t) * k, W, (o.t + o.b) * k);
    }

    // Skjøtelinjer
    ctx.strokeStyle = 'rgba(20,20,20,0.75)';
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    for (let c = 1; c < g.cols; c++) { const x = Math.round(c * coreW * k) + 0.5; ctx.moveTo(x, 0); ctx.lineTo(x, H); }
    for (let r = 1; r < g.rows; r++) { const y = Math.round(r * coreH * k) + 0.5; ctx.moveTo(0, y); ctx.lineTo(W, y); }
    ctx.stroke();
    ctx.setLineDash([]);

    // Valgt ark
    const sc = state.sheet % g.cols;
    const sr = Math.floor(state.sheet / g.cols);
    const accent = css('--accent') || '#2f6f8f';
    ctx.strokeStyle = accent;
    ctx.lineWidth = 3;
    ctx.strokeRect(sc * coreW * k + 1.5, sr * coreH * k + 1.5, coreW * k - 3, coreH * k - 3);

    // Etiketter
    const fs = clamp(Math.min(coreW, coreH) * k * 0.14, 10, 22);
    ctx.font = `700 ${fs}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let r = 0; r < g.rows; r++) {
      for (let c = 0; c < g.cols; c++) {
        const label = sheetName(c, r);
        const cx = (c + 0.5) * coreW * k;
        const cy = (r + 0.5) * coreH * k;
        const tw = ctx.measureText(label).width;
        const selected = c === sc && r === sr;
        ctx.fillStyle = selected ? accent : 'rgba(255,255,255,0.85)';
        roundRect(ctx, cx - tw / 2 - 6, cy - fs * 0.7, tw + 12, fs * 1.4, 5);
        ctx.fill();
        ctx.fillStyle = selected ? (css('--accent-ink') || '#fff') : '#1f2328';
        ctx.fillText(label, cx, cy + 1);
      }
    }
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, W - 1, H - 1);
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawSheet() {
    const g = state.geom;
    const src = state.source;
    const card = $('sheetCard');
    const show = !!(src && g && !g.error);
    card.hidden = !show;
    if (!show) return;

    const c = state.sheet % g.cols;
    const r = Math.floor(state.sheet / g.cols);
    $('sheetTitle').textContent = `Ark ${sheetName(c, r)} – side ${state.sheet + 1} av ${g.sheets}`;
    $('prevSheet').disabled = state.sheet <= 0;
    $('nextSheet').disabled = state.sheet >= g.sheets - 1;

    const maxW = Math.min(boxInnerSize($('sheetBox')), 560);
    const maxH = Math.max(320, Math.min(window.innerHeight * 0.75, 720));
    const k = Math.min(maxW / g.paper.w, maxH / g.paper.h);
    const W = g.paper.w * k;
    const H = g.paper.h * k;
    const canvas = $('sheetCanvas');
    const ctx = setupCanvas(canvas, W, H);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);

    const { ops, overlays } = sheetLayout(g, c, r, state.settings);
    drawOpsCanvas(ctx, ops, k, 0, 0, src.preview);

    // Overlegg som bare vises i forhåndsvisningen
    ctx.fillStyle = 'rgba(47,111,143,0.35)';
    for (const s of overlays.strips) ctx.fillRect(s.x * k, s.y * k, s.w * k, s.h * k);
    const p = overlays.printable;
    ctx.strokeStyle = '#9aa2ab';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(p.x * k + 0.5, p.y * k + 0.5, p.w * k - 1, p.h * k - 1);
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.strokeRect(0.5, 0.5, W - 1, H - 1);
  }

  // ---------- PDF-eksport ----------

  /** Matrise som tegner et bilde (enhetskvadrat) med EXIF-orientering inn i rektangelet X,Y,W,H (PDF-koordinater). */
  function orientMatrix(orientation, X, Y, W, H) {
    const maps = {
      1: (u, t) => [u, t], 2: (u, t) => [1 - u, t], 3: (u, t) => [1 - u, 1 - t], 4: (u, t) => [u, 1 - t],
      5: (u, t) => [t, u], 6: (u, t) => [1 - t, u], 7: (u, t) => [1 - t, 1 - u], 8: (u, t) => [t, 1 - u],
    };
    const map = maps[orientation] || maps[1];
    const f = (a, b) => { const [dx, dy] = map(a, 1 - b); return [X + dx * W, Y + H - dy * H]; };
    const p0 = f(0, 0);
    const pa = f(1, 0);
    const pb = f(0, 1);
    return [pa[0] - p0[0], pa[1] - p0[1], pb[0] - p0[0], pb[1] - p0[1], p0[0], p0[1]];
  }

  async function embedSource(doc, src, PDFLib) {
    if (src.kind === 'image') {
      const image = src.imgType === 'jpeg' ? await doc.embedJpg(src.exportBytes) : await doc.embedPng(src.exportBytes);
      return { kind: 'image', image, orientation: src.orientation };
    }
    if (src.vector) {
      try {
        const srcDoc = await PDFLib.PDFDocument.load(src.pdfBytes.slice(0), { ignoreEncryption: true, updateMetadata: false });
        const p = srcDoc.getPage(0);
        const cb = p.getCropBox();
        const page = await doc.embedPage(p, { left: cb.x, bottom: cb.y, right: cb.x + cb.width, top: cb.y + cb.height });
        return { kind: 'page', page };
      } catch (_) { /* fall tilbake til rasterisering */ }
    }
    const vp = src.pdfPage.getViewport({ scale: 1 });
    const size = fitCanvasSize(vp.width, vp.height, LIMITS.maxRasterSide, LIMITS.maxCanvasPx);
    const canvas = await renderPdfPage(src.pdfPage, size.w / vp.width);
    const bytes = await canvasToBytes(canvas, 'image/jpeg', 0.92);
    const image = await doc.embedJpg(bytes);
    return { kind: 'image', image, orientation: 1 };
  }

  function drawOpsPdf(page, ops, ctx) {
    const { PDFLib, source, font, bold } = ctx;
    const { rgb, degrees, pushGraphicsState, popGraphicsState, rectangle, clip, endPath,
      concatTransformationMatrix, drawObject } = PDFLib;
    const PH = page.getHeight();
    const P = (v) => v * MM_TO_PT;
    const col = (c) => rgb(c[0], c[1], c[2]);
    for (const op of ops) {
      if (op.t === 'image') {
        page.pushOperators(
          pushGraphicsState(),
          rectangle(P(op.clip.x), PH - P(op.clip.y + op.clip.h), P(op.clip.w), P(op.clip.h)),
          clip(),
          endPath(),
        );
        const X = P(op.x);
        const Y = PH - P(op.y + op.h);
        const W = P(op.w);
        const H = P(op.h);
        if (source.kind === 'page') {
          page.drawPage(source.page, { x: X, y: Y, width: W, height: H });
        } else {
          const name = page.node.newXObject('Image', source.image.ref);
          page.pushOperators(
            pushGraphicsState(),
            concatTransformationMatrix(...orientMatrix(source.orientation, X, Y, W, H)),
            drawObject(name),
            popGraphicsState(),
          );
        }
        page.pushOperators(popGraphicsState());
      } else if (op.t === 'line') {
        page.drawLine({
          start: { x: P(op.x1), y: PH - P(op.y1) }, end: { x: P(op.x2), y: PH - P(op.y2) },
          thickness: P(op.w), color: col(op.color),
        });
      } else if (op.t === 'rect') {
        page.drawRectangle({
          x: P(op.x), y: PH - P(op.y + op.h), width: P(op.w), height: P(op.h),
          color: op.fill ? col(op.fill) : undefined,
          borderColor: op.stroke ? col(op.stroke) : undefined,
          borderWidth: op.stroke ? P(op.lw) : 0,
        });
      } else if (op.t === 'label' || op.t === 'text') {
        if (op.t === 'label') {
          const b = labelBox(op);
          page.drawRectangle({ x: P(b.x), y: PH - P(b.y + b.h), width: P(b.w), height: P(b.h), color: col(WHITE) });
        }
        const f = op.bold ? bold : font;
        const opts = { size: P(op.sizeMm), font: f, color: col(op.color || BLACK) };
        if (op.maxW) {
          wrapText(op.text, op.maxW, op.sizeMm, (line, i) => {
            page.drawText(line, { ...opts, x: P(op.x), y: PH - P(op.y + i * op.sizeMm * 1.3) });
          });
        } else {
          page.drawText(op.text, { ...opts, x: P(op.x), y: PH - P(op.y), rotate: degrees(op.rot || 0) });
        }
      }
    }
  }

  /** Erstatter tegn som standardfonten (WinAnsi) ikke har. */
  function safeText(ops) {
    for (const op of ops) {
      if (op.text) op.text = op.text.replace(/[^\x20-\x7e -ÿ·×–—«»‘’“”…€]/g, '?');
    }
    return ops;
  }

  async function buildPdf(src, g, s, onProgress) {
    const PDFLib = await getPdfLib();
    const doc = await PDFLib.PDFDocument.create();
    const base = src.name.replace(/\.[^.]+$/, '');
    doc.setTitle(`${base} – plakat ${g.cols}×${g.rows}`);
    doc.setCreator('Tileprint');
    doc.setProducer('Tileprint (pdf-lib)');
    onProgress('Bygger inn bildet …');
    const source = await embedSource(doc, src, PDFLib);
    const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
    const bold = await doc.embedFont(PDFLib.StandardFonts.HelveticaBold);
    const ctx = { PDFLib, source, font, bold };
    const size = [g.paper.w * MM_TO_PT, g.paper.h * MM_TO_PT];

    for (let r = 0; r < g.rows; r++) {
      for (let c = 0; c < g.cols; c++) {
        const page = doc.addPage(size);
        drawOpsPdf(page, safeText(sheetLayout(g, c, r, s).ops), ctx);
        const n = r * g.cols + c + 1;
        if (n % 4 === 0) {
          onProgress(`Lager ark ${n} av ${g.sheets} …`);
          await new Promise((res) => setTimeout(res, 0));
        }
      }
    }
    if (s.overview) {
      const page = doc.addPage(size);
      drawOpsPdf(page, safeText(overviewLayout(g, s, src).ops), ctx);
    }
    onProgress('Lagrer PDF …');
    await new Promise((res) => setTimeout(res, 0));
    return doc.save({ useObjectStreams: true });
  }

  async function exportPdf() {
    const src = state.source;
    const g = state.geom;
    if (!src || !g || g.error || state.busy) return;
    state.busy = true;
    refreshExportButton();
    clearDownload();
    showError(null);
    const t0 = performance.now();
    try {
      const bytes = await buildPdf(src, g, state.settings, setStatus);
      const blob = new Blob([bytes], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      state.downloadUrl = url;
      const base = src.name.replace(/\.[^.]+$/, '') || 'plakat';
      const fileName = `${base}-plakat-${g.cols}x${g.rows}.pdf`;
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.textContent = `Last ned ${fileName}`;
      const secs = (performance.now() - t0) / 1000;
      const status = $('status');
      status.textContent = `Ferdig på ${fmt(secs)} s (${fmt(blob.size / 1048576)} MB). `;
      status.appendChild(a);
      a.click();
    } catch (err) {
      setStatus('');
      showError(`Klarte ikke å lage PDF-en: ${err.message || err}`);
    } finally {
      state.busy = false;
      refreshExportButton();
    }
  }

  async function exportTestSheet() {
    if (state.busy) return;
    state.busy = true;
    refreshExportButton();
    showError(null);
    try {
      const PDFLib = await getPdfLib();
      const doc = await PDFLib.PDFDocument.create();
      doc.setTitle('Testark – Tileprint');
      const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
      const bold = await doc.embedFont(PDFLib.StandardFonts.HelveticaBold);
      const paper = paperDims(state.settings, 'portrait');
      const page = doc.addPage([paper.w * MM_TO_PT, paper.h * MM_TO_PT]);
      drawOpsPdf(page, safeText(testSheetLayout(paper, state.settings)), { PDFLib, source: null, font, bold });
      const bytes = await doc.save();
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `testark-${PAPERS[state.settings.paper].name}.pdf`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (err) {
      showError(`Klarte ikke å lage testarket: ${err.message || err}`);
    } finally {
      state.busy = false;
      refreshExportButton();
    }
  }

  function clearDownload() {
    if (state.downloadUrl) {
      URL.revokeObjectURL(state.downloadUrl);
      state.downloadUrl = null;
      setStatus('');
    }
  }

  // ---------- UI ----------

  function setStatus(text) { $('status').textContent = text; }

  function showError(text) {
    const el = $('error');
    el.hidden = !text;
    el.textContent = text || '';
  }

  function refreshExportButton() {
    const g = state.geom;
    $('exportBtn').disabled = state.busy || !state.source || !g || !!g.error;
    $('exportBtn').textContent = g && !g.error ? `Lag PDF (${g.sheets} ${g.sheets === 1 ? 'side' : 'sider'})` : 'Lag PDF';
  }

  function renderFileInfo() {
    const src = state.source;
    const info = $('fileInfo');
    const warn = $('warnings');
    if (!src) { info.hidden = true; warn.hidden = true; return; }
    const mb = src.size / 1048576;
    const dims = src.kind === 'image'
      ? `${src.pxW} × ${src.pxH} px`
      : `${fmt(src.w / MM_TO_PT / 10)} × ${fmt(src.h / MM_TO_PT / 10)} cm, ${src.pageCount} ${src.pageCount === 1 ? 'side' : 'sider'}`;
    info.innerHTML = '';
    const strong = document.createElement('strong');
    strong.textContent = src.name;
    info.append(strong, document.createElement('br'), `${dims} · ${fmt(mb)} MB`);
    info.hidden = false;
    renderWarnings();
  }

  function renderWarnings() {
    const src = state.source;
    const g = state.geom;
    const list = [];
    if (src) {
      if (src.size > LIMITS.warnBytes) list.push(`Filen er stor (${fmt(src.size / 1048576)} MB). Nettleseren kan bli treg, særlig når PDF-en lages.`);
      if (src.pxW && Math.max(src.pxW, src.pxH) > LIMITS.warnPx) list.push(`Bildet er stort (${src.pxW} × ${src.pxH} px). Nettleseren kan bli treg – vent litt når du lager PDF-en.`);
      if (src.kind === 'image' && src.imgType === 'png' && src.pxW * src.pxH > 20e6) list.push('Store PNG-filer tar ekstra tid å bygge inn i PDF-en.');
      if (src.kind === 'pdf' && src.pageCount > 1) list.push(`PDF-en har ${src.pageCount} sider. Bare første side brukes.`);
      if (src.kind === 'pdf' && !src.vector) list.push('PDF-en kan ikke bygges inn som vektor og blir gjort om til et bilde (ca. 16 megapiksler).');
      if (src.note) list.push(src.note);
      if (g && !g.error && g.dpi && g.dpi < LIMITS.lowDpi) list.push(`Lav oppløsning: ca. ${Math.round(g.dpi)} dpi i denne størrelsen. Plakaten kan se uskarp ut på nært hold.`);
    }
    const ul = $('warnings');
    ul.innerHTML = '';
    for (const t of list) { const li = document.createElement('li'); li.textContent = t; ul.appendChild(li); }
    ul.hidden = list.length === 0;
  }

  function renderSummary() {
    const el = $('summary');
    el.innerHTML = '';
    const g = state.geom;
    const src = state.source;
    if (!src || !g || g.error) return;
    const stat = (k, v, s, cls) => {
      const d = document.createElement('div');
      d.className = `stat${cls ? ` ${cls}` : ''}`;
      d.innerHTML = '<div class="k"></div><div class="v"></div><div class="s"></div>';
      d.children[0].textContent = k;
      d.children[1].textContent = v;
      d.children[2].textContent = s;
      el.appendChild(d);
    };
    stat('Plakat', `${fmt(g.posterW / 10)} × ${fmt(g.posterH / 10)} cm`, `rutenett ${fmt(g.gridW / 10)} × ${fmt(g.gridH / 10)} cm`);
    stat('Ark', `${g.cols} × ${g.rows} = ${g.sheets}`, `${PAPERS[state.settings.paper].name} ${g.orient === 'landscape' ? 'liggende' : 'stående'}`);
    if (g.dpi) {
      stat('Oppløsning', `${Math.round(g.dpi)} dpi`, g.dpi < LIMITS.lowDpi ? 'lav – kan bli uskarp' : g.dpi < 150 ? 'grei på avstand' : 'god', g.dpi < LIMITS.lowDpi ? 'low' : '');
    } else {
      stat('Oppløsning', src.vector ? 'Vektor' : 'Rastrert', src.vector ? 'skarp i alle størrelser' : 'ca. 16 megapiksler');
    }
    stat('Bildeflate per ark', `${fmt(g.coreW / 10)} × ${fmt(g.coreH / 10)} cm`, `+ ${fmt(state.settings.overlap)} mm overlapp`);
  }

  function update() {
    const s = state.settings;
    state.geom = computeGeometry(s, state.source);
    const g = state.geom;
    if (g && state.sheet >= (g.sheets || 1)) state.sheet = 0;
    showError(g && g.error ? g.error : null);
    syncDerivedInputs();
    renderSummary();
    renderWarnings();
    drawPoster();
    drawSheet();
    refreshExportButton();
  }

  function syncDerivedInputs() {
    const s = state.settings;
    const g = state.geom;
    const isGrid = s.mode === 'grid';
    $('gridFields').hidden = !isGrid;
    $('fitRows').hidden = !isGrid;
    $('sizeFields').hidden = isGrid;
    $('sizeHint').hidden = isGrid;
    $('margin').disabled = s.borderless;
    $('cropMarks').disabled = s.borderless;
    $('cropMarks').closest('label').classList.toggle('disabled', s.borderless);
    $('borderlessHint').hidden = !s.borderless;
    const active = document.activeElement;
    if (g && !g.error) {
      if (isGrid) {
        if (active !== $('widthCm')) $('widthCm').value = round1(g.posterW / 10);
        if (active !== $('heightCm')) $('heightCm').value = round1(g.posterH / 10);
      } else {
        if (active !== $('cols')) $('cols').value = g.cols;
        if (active !== $('rows')) $('rows').value = g.rows;
        if (s.sizeDim === 'width' && active !== $('heightCm')) $('heightCm').value = round1(g.posterH / 10);
        if (s.sizeDim === 'height' && active !== $('widthCm')) $('widthCm').value = round1(g.posterW / 10);
      }
    }
  }
  const round1 = (v) => Math.round(v * 10) / 10;

  function fitRowsToImage() {
    const s = state.settings;
    const src = state.source;
    if (!src) return;
    // Finn antall rader som gir størst plakat for valgt antall kolonner.
    let bestRows = s.rows;
    let bestArea = -1;
    for (let rows = 1; rows <= LIMITS.maxPerSide; rows++) {
      const g = computeGeometry({ ...s, rows }, src);
      if (!g || g.error) continue;
      // Areal per ark – unngå ekstra rader som bare gir tom plass.
      const area = (g.posterW * g.posterH) / g.sheets;
      if (area > bestArea * 1.0001) { bestArea = area; bestRows = rows; }
    }
    s.rows = bestRows;
    $('rows').value = bestRows;
    saveSettings();
  }

  function writeInputs() {
    const s = state.settings;
    $('paper').value = s.paper;
    $('orient').value = s.orient;
    $('margin').value = s.margin;
    $('borderless').checked = s.borderless;
    document.querySelector(`input[name="mode"][value="${s.mode}"]`).checked = true;
    $('cols').value = s.cols;
    $('rows').value = s.rows;
    if (s.sizeDim === 'height') $('heightCm').value = s.sizeCm; else $('widthCm').value = s.sizeCm;
    $('overlap').value = s.overlap;
    $('edgeTop').checked = s.edges.top;
    $('edgeRight').checked = s.edges.right;
    $('edgeBottom').checked = s.edges.bottom;
    $('edgeLeft').checked = s.edges.left;
    $('cropMarks').checked = s.cropMarks;
    $('labels').checked = s.labels;
    $('overview').checked = s.overview;
  }

  function readNumber(id, lo, hi, integer) {
    const el = $(id);
    const v = parseFloat(String(el.value).replace(',', '.'));
    if (!Number.isFinite(v)) return null;
    const n = clamp(integer ? Math.round(v) : v, lo, hi);
    return n;
  }

  function bindInputs() {
    const s = state.settings;
    const on = (id, ev, fn) => $(id).addEventListener(ev, fn);
    const changed = () => { saveSettings(); clearDownload(); update(); };

    on('paper', 'change', (e) => { s.paper = e.target.value; changed(); });
    on('orient', 'change', (e) => { s.orient = e.target.value; changed(); });
    on('margin', 'input', () => { const v = readNumber('margin', 0, 30); if (v !== null) { s.margin = v; changed(); } });
    document.querySelectorAll('input[name="mode"]').forEach((el) => el.addEventListener('change', (e) => {
      s.mode = e.target.value;
      if (s.mode === 'size' && state.geom && !state.geom.error) {
        // Ta med dagens størrelse over til «mål i cm».
        s.sizeDim = 'width';
        s.sizeCm = round1(state.geom.posterW / 10);
        $('widthCm').value = s.sizeCm;
      } else if (s.mode === 'grid' && state.geom && !state.geom.error) {
        s.cols = clamp(state.geom.cols, 1, LIMITS.maxPerSide);
        s.rows = clamp(state.geom.rows, 1, LIMITS.maxPerSide);
        $('cols').value = s.cols;
        $('rows').value = s.rows;
      }
      changed();
    }));
    on('cols', 'input', () => { const v = readNumber('cols', 1, LIMITS.maxPerSide, true); if (v !== null) { s.cols = v; changed(); } });
    on('rows', 'input', () => { const v = readNumber('rows', 1, LIMITS.maxPerSide, true); if (v !== null) { s.rows = v; state.userSetRows = true; changed(); } });
    on('fitRows', 'click', () => { fitRowsToImage(); changed(); });
    on('widthCm', 'input', () => { const v = readNumber('widthCm', 5, 2000); if (v !== null) { s.sizeDim = 'width'; s.sizeCm = v; changed(); } });
    on('heightCm', 'input', () => { const v = readNumber('heightCm', 5, 2000); if (v !== null) { s.sizeDim = 'height'; s.sizeCm = v; changed(); } });
    on('overlap', 'input', () => { const v = readNumber('overlap', 0, 50); if (v !== null) { s.overlap = v; changed(); } });
    for (const [id, key] of [['edgeTop', 'top'], ['edgeRight', 'right'], ['edgeBottom', 'bottom'], ['edgeLeft', 'left']]) {
      on(id, 'change', (e) => { s.edges[key] = e.target.checked; changed(); });
    }
    on('borderless', 'change', (e) => { s.borderless = e.target.checked; changed(); });
    on('testSheetBtn', 'click', exportTestSheet);
    on('cropMarks', 'change', (e) => { s.cropMarks = e.target.checked; changed(); });
    on('labels', 'change', (e) => { s.labels = e.target.checked; changed(); });
    on('overview', 'change', (e) => { s.overview = e.target.checked; changed(); });

    // Normaliser feltverdiene når man forlater dem
    for (const id of ['margin', 'cols', 'rows', 'overlap', 'widthCm', 'heightCm']) {
      on(id, 'change', () => { writeInputsFromState(id); syncDerivedInputs(); });
    }

    on('resetBtn', 'click', () => {
      const fresh = structuredClone(DEFAULTS);
      Object.keys(s).forEach((k) => delete s[k]);
      Object.assign(s, fresh);
      state.userSetRows = false;
      try { localStorage.removeItem(STORE_KEY); } catch (_) { /* ignorer */ }
      writeInputs();
      if (state.source) fitRowsToImage();
      changed();
    });

    on('file', 'change', (e) => { handleFile(e.target.files[0]); e.target.value = ''; });
    const drop = $('drop');
    ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove('over')));
    drop.addEventListener('drop', (e) => { e.preventDefault(); handleFile(e.dataTransfer.files[0]); });
    // Hindre at nettleseren åpner filen hvis den slippes utenfor feltet
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => { e.preventDefault(); if (e.target !== drop && !drop.contains(e.target)) handleFile(e.dataTransfer.files[0]); });

    on('exportBtn', 'click', exportPdf);
    on('prevSheet', 'click', () => { if (state.sheet > 0) { state.sheet--; drawPoster(); drawSheet(); } });
    on('nextSheet', 'click', () => { if (state.geom && state.sheet < state.geom.sheets - 1) { state.sheet++; drawPoster(); drawSheet(); } });
    on('posterCanvas', 'click', (e) => {
      const g = state.geom;
      if (!g || g.error) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const x = (e.clientX - rect.left) / posterView.k;
      const y = (e.clientY - rect.top) / posterView.k;
      const c = clamp(Math.floor(x / g.coreW), 0, g.cols - 1);
      const r = clamp(Math.floor(y / g.coreH), 0, g.rows - 1);
      state.sheet = r * g.cols + c;
      drawPoster();
      drawSheet();
    });

    let raf = 0;
    window.addEventListener('resize', () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => { drawPoster(); drawSheet(); });
    });
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    if (mq.addEventListener) mq.addEventListener('change', () => drawPoster());
  }

  function writeInputsFromState(id) {
    const s = state.settings;
    const map = { margin: s.margin, cols: s.cols, rows: s.rows, overlap: s.overlap };
    if (id in map) $(id).value = map[id];
    if (id === 'widthCm' && s.sizeDim === 'width' && s.mode === 'size') $(id).value = s.sizeCm;
    if (id === 'heightCm' && s.sizeDim === 'height' && s.mode === 'size') $(id).value = s.sizeCm;
  }

  // Eksponert for testing i nettleserkonsollen.
  window.PlakatSplitter = { testSheetLayout, drawOpsPdf, safeText, getPdfLib, computeGeometry, sheetLayout, overviewLayout, orientMatrix, jpegOrientation, buildPdf, state };

  writeInputs();
  bindInputs();
  update();
})();
