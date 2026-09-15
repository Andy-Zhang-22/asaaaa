/*
 * pdf-table.js — 從「試算表列印成 PDF」的檔案中還原表格。
 *
 * 純文字擷取（pdf.js getTextContent 直接串接）會把多行儲存格的內容交錯在一起，
 * 完全無法還原欄位。這裡改用兩段式：
 *   1. 把每一頁畫到 canvas，用像素掃描找出表格的水平／垂直格線 → 得到真正的儲存格網格。
 *   2. 把文字項目依「裝置座標中心點」丟進對應的儲存格。
 * 若該頁沒有格線（例如無框線列印），退回以 x 座標分群的推測模式。
 */
(function (global) {
  'use strict';

  const DARK = 200;          // 灰階低於此值視為有墨水
  const LINE_RATIO = 0.55;   // 一條掃描線的墨水比例超過最長線的多少才算格線
  const RENDER_SCALE = 1.5;  // 偵測格線用的算圖倍率
  // 一行的開頭長這樣，代表它是新的一則內容，不是上一行被折下來的
  const NEW_ITEM = /^(?:\d{2,4}\/\d{1,2}|\d{6,8}(?!\d)|[（(]?\d+[.、]|0\d{8,9}(?!\d)|0\d{1,2}[-\s]\d{3,4}|[（(]?0\d[)）]|104登記|公司登記|登記[:：]|實際[地:：])/;

  /** 把連續的索引合併成一條線，回傳每段的中心點。 */
  function mergeRuns(indexes, maxGap) {
    const lines = [];
    let start = null;
    let prev = null;
    for (const i of indexes) {
      if (start === null) { start = prev = i; continue; }
      if (i - prev <= maxGap) { prev = i; continue; }
      lines.push((start + prev) / 2);
      start = prev = i;
    }
    if (start !== null) lines.push((start + prev) / 2);
    return lines;
  }

  /** 從 canvas 像素找出水平與垂直格線的位置（裝置座標）。 */
  function detectGrid(imageData) {
    const { data, width, height } = imageData;
    const rowInk = new Int32Array(height);
    const colInk = new Int32Array(width);

    for (let y = 0; y < height; y++) {
      const base = y * width * 4;
      for (let x = 0; x < width; x++) {
        const p = base + x * 4;
        // 先看透明度，再算亮度；列印出來的格線是淺灰也算數
        if (data[p + 3] < 16) continue;
        const lum = (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000;
        if (lum < DARK) { rowInk[y]++; colInk[x]++; }
      }
    }

    // 一條線要有多長才算格線，是相對於「這一頁實際有內容的範圍」來看的。
    // 最後一頁可能只印了一列，垂直線自然很短，不能拿整頁高度當基準。
    const extentOf = (ink) => {
      let first = -1;
      let last = -1;
      for (let i = 0; i < ink.length; i++) {
        if (ink[i] > 0) { if (first < 0) first = i; last = i; }
      }
      return first < 0 ? 0 : last - first + 1;
    };
    const xExtent = extentOf(colInk);
    const yExtent = extentOf(rowInk);

    const pick = (ink, span) => {
      let max = 0;
      for (let i = 0; i < ink.length; i++) if (ink[i] > max) max = ink[i];
      // 最長的那條線必須橫跨大半個表格，否則這頁根本沒有框線
      if (max < 20 || max < span * 0.45) return [];
      const threshold = max * LINE_RATIO;
      const hits = [];
      for (let i = 0; i < ink.length; i++) if (ink[i] >= threshold) hits.push(i);
      return mergeRuns(hits, 3);
    };

    return {
      rows: pick(rowInk, xExtent),   // 水平格線的 y
      cols: pick(colInk, yExtent),   // 垂直格線的 x
    };
  }

  /** 二分搜尋：value 落在 lines 的第幾個區間，落在範圍外回傳 -1。 */
  function bandOf(lines, value) {
    if (value < lines[0] || value > lines[lines.length - 1]) return -1;
    let lo = 0, hi = lines.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (value < lines[mid]) hi = mid; else lo = mid;
    }
    return lo;
  }

  /**
   * 把同一格內的文字片段併回字串。
   *
   * 關鍵在於分辨「儲存格寬度不夠而自動折行」與「使用者自己按的換行」：
   * 前者的那一行會一路寫到儲存格右緣，後者會提早結束。自動折行要直接接起來，
   * 中文才不會變成「律果科技股份有／限公司」這種被切斷的字串。
   */
  function joinPieces(pieces, rightEdge) {
    if (!pieces.length) return '';
    const sorted = pieces.slice().sort((a, b) => a.y - b.y || a.x - b.x);

    const lines = [];
    for (const piece of sorted) {
      const line = lines[lines.length - 1];
      if (line && Math.abs(piece.y - line.y) <= piece.size * 0.6) {
        line.pieces.push(piece);
        line.size = Math.max(line.size, piece.size);
      } else {
        lines.push({ y: piece.y, size: piece.size, pieces: [piece] });
      }
    }

    const rendered = lines.map((line) => {
      line.pieces.sort((a, b) => a.x - b.x);
      let text = '';
      let prev = null;
      for (const piece of line.pieces) {
        if (prev && piece.x - (prev.x + prev.width) > prev.size * 0.45) text += ' ';
        text += piece.text;
        prev = piece;
      }
      const last = line.pieces[line.pieces.length - 1];
      return { text: text.trim(), endX: last.x + last.width, size: line.size };
    }).filter((l) => l.text !== '');

    let out = '';
    rendered.forEach((line, i) => {
      if (i === 0) { out = line.text; return; }
      const prev = rendered[i - 1];
      const slack = rightEdge === undefined ? Infinity : rightEdge - prev.endX;
      // 塞滿到右緣 = 自動折行。留下一兩個字空白的也多半是折行（中文斷行點不固定），
      // 但下一行如果是新的一則紀錄（日期、編號、「登記：」開頭），就當成真的換行。
      const filled = slack <= prev.size * 1.35 + 2;
      const nearlyFilled = slack <= prev.size * 2.6 + 2 && !NEW_ITEM.test(line.text);
      out += (filled || nearlyFilled) ? '' : '\n';
      out += line.text;
    });
    return out.trim();
  }

  /** 沒有格線時的備援：用 x 起點分群當欄，用 y 分群當列。 */
  function fallbackRows(pieces) {
    const xs = pieces.map((p) => p.x).sort((a, b) => a - b);
    const colStarts = [];
    for (const x of xs) {
      if (!colStarts.length || x - colStarts[colStarts.length - 1] > 12) colStarts.push(x);
    }
    const byLine = new Map();
    for (const piece of pieces) {
      const key = Math.round(piece.y / Math.max(piece.size * 0.8, 4));
      if (!byLine.has(key)) byLine.set(key, []);
      byLine.get(key).push(piece);
    }
    const rows = [];
    for (const key of [...byLine.keys()].sort((a, b) => a - b)) {
      const cells = new Array(colStarts.length).fill(null).map(() => []);
      for (const piece of byLine.get(key)) {
        let idx = 0;
        for (let i = 0; i < colStarts.length; i++) if (piece.x >= colStarts[i] - 2) idx = i;
        cells[idx].push(piece);
      }
      rows.push(cells.map((cellPieces, i) => joinPieces(
        cellPieces,
        i + 1 < colStarts.length ? colStarts[i + 1] : undefined
      )));
    }
    return rows;
  }

  /** 解析單一頁面，回傳 { rows: string[][], mode }。 */
  async function parsePage(page) {
    const viewport = page.getViewport({ scale: RENDER_SCALE });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    const grid = detectGrid(ctx.getImageData(0, 0, canvas.width, canvas.height));

    const content = await page.getTextContent();
    const util = global.pdfjsLib.Util;
    const pieces = [];
    for (const item of content.items) {
      if (!item.str || !item.str.trim()) continue;
      const tx = util.transform(viewport.transform, item.transform);
      const size = Math.hypot(tx[2], tx[3]) || 10;
      const width = (item.width || 0) * RENDER_SCALE;
      pieces.push({
        text: item.str,
        x: tx[4],
        width,
        y: tx[5] - size * 0.35, // 由基線推回字身中心
        size,
      });
    }
    const pageHeight = canvas.height;
    // 釋放畫布記憶體（Safari 對大量 canvas 特別敏感）
    canvas.width = canvas.height = 0;

    if (!pieces.length) return { rows: [], mode: 'empty' };

    // 欄的垂直線最可靠；橫線在「整頁只放得下一列」的時候可能只剩一兩條，
    // 這時用頁面上下緣補齊，不要因此退回逐行模式（那會把一筆資料拆成十幾列）。
    if (grid.cols.length < 3 || grid.rows.length < 1) {
      return { rows: fallbackRows(pieces), mode: 'heuristic' };
    }
    const rowLines = grid.rows.slice();
    const topMost = Math.min(...pieces.map((p) => p.y));
    const bottomMost = Math.max(...pieces.map((p) => p.y));
    if (topMost < rowLines[0] - 1) rowLines.unshift(Math.max(0, topMost - 2));
    if (bottomMost > rowLines[rowLines.length - 1] + 1) rowLines.push(Math.min(pageHeight, bottomMost + 2));
    if (rowLines.length < 2) return { rows: fallbackRows(pieces), mode: 'heuristic' };

    const rowCount = rowLines.length - 1;
    const colCount = grid.cols.length - 1;
    const table = Array.from({ length: rowCount }, () => Array.from({ length: colCount }, () => []));
    for (const piece of pieces) {
      const r = bandOf(rowLines, piece.y);
      const c = bandOf(grid.cols, piece.x + piece.width / 2);
      if (r < 0 || c < 0) continue;
      table[r][c].push(piece);
    }
    const rows = table
      .map((cells) => cells.map((cellPieces, c) => joinPieces(cellPieces, grid.cols[c + 1])))
      .filter((cells) => cells.some((c) => c !== ''));
    return { rows, mode: 'grid', gridSize: `${grid.rows.length}x${grid.cols.length}` };
  }

  /**
   * 解析整份 PDF。
   * @param {ArrayBuffer} buffer
   * @param {(done:number,total:number)=>void} [onProgress]
   * @returns {Promise<{rows:string[][], pages:number, pageStarts:number[], mode:string}>}
   */
  async function parsePdf(buffer, onProgress) {
    const pdfjsLib = global.pdfjsLib;
    const doc = await pdfjsLib.getDocument({
      data: buffer,
      isEvalSupported: false,
      useSystemFonts: true,
    }).promise;

    const rows = [];
    const pageStarts = [];
    const modes = new Set();
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const parsed = await parsePage(page);
      modes.add(parsed.mode);
      pageStarts.push(rows.length);
      rows.push(...parsed.rows);
      page.cleanup();
      if (onProgress) onProgress(i, doc.numPages);
    }
    const pages = doc.numPages;
    await doc.destroy();
    return { rows, pages, pageStarts, mode: modes.has('grid') ? 'grid' : [...modes][0] || 'empty' };
  }

  global.PdfTable = { parsePdf, detectGrid, joinPieces };
})(window);
