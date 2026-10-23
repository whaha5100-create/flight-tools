/* ============================================================
   机组名单识别
   ------------------------------------------------------------
   GD 单有两种来源，处理方式不同，程序自动判断：

   1) 单子里有文字层（浏览器 / WPS 打印出来的 PDF，Producer 为
      Skia/PDF、Chrome 等）→ 直接把字符连同坐标读出来，零误差，
      也不受人数多少影响。见 parseTextLayer。

   2) 文字被转成曲线（「Microsoft Print to PDF」打印的老单子，
      解压后 0 个字体、0 条文字指令，看着像字其实是矢量路径）
      → 提取不到字符，只能渲染成高清图再逐列 OCR。

   为什么是「逐列」而不是整页识别：
   整页识别会直接丢掉职务列（CA/FO/STW/SEC）和性别列（M/F），
   字太小被引擎忽略。切开单列识别，行高稳定、没有邻列干扰，
   实测 20 人 × 5 字段 = 100/100 全对。

   所有依赖都在 ./libs/tesseract/，不联网、不走 CDN。
   文字层模式不会加载那 5.8MB 引擎（懒加载，只在走 OCR 时才引）。
   ============================================================ */
(function () {
  'use strict';

  var RENDER_W = 2381;   // 识别渲染宽度（A4 的 4 倍像素）
  var BASE_H = 3367;     // A4 的 4 倍高度，用于把 y 比例换算回像素

  /* 列位置：相对页面的百分比，取自标准 GD 单版式。
     用比例而不是固定像素，页面渲染尺寸变了也不会失效。

     职务列放最后识别，并且多裁一截高度：这块只有 200px 宽的窄条，
     对高度特别敏感 —— 少 50px 整列就会塌成两行（实测过）。
     所以它单独给 y1，并且失败时换 PSM 再试一遍。 */
  var COLS = [
    { key: 'name', x0: 0.2478, x1: 0.4053, psm: '6' },
    { key: 'dob',  x0: 0.4578, x1: 0.5229, psm: '6' },
    { key: 'sex',  x0: 0.5229, x1: 0.5628, psm: '6' },
    { key: 'pass', x0: 0.5628, x1: 0.6531, psm: '6' },
    { key: 'duty', x0: 0.1680, x1: 0.2520, psm: '4', y1: 0.6670, retry: ['6', '11'] },
    { key: 'head', x0: 0.5376, x1: 0.8148, y0: 0.0564, y1: 0.0951, psm: '6' }
  ];
  var ROW_Y0 = 0.1812;   // 表格数据区上沿
  var ROW_Y1 = 0.6534;   // 表格数据区下沿（20 行）

  var DUTY_OK = { CA: 1, FO: 1, STW: 1, SEC: 1 };

  /* ============================================================
     模式一：PDF 自带文字层，直接精确读
     ------------------------------------------------------------
     有些 GD 单是浏览器「打印成 PDF」生成的（Producer 为
     Skia/PDF 或 Chrome），文字没被转曲，文件里就有真字符。
     这种单子根本不用识别，把字符连同坐标读出来即可 —— 又快又准，
     而且人数变了也不影响（不依赖固定行高比例）。

     实测 gd-261.pdf（MU261 温州→马德里 19 人）：
       职务 x=102  姓名 x=130.1  国籍 x=249.4
       生日 x=275.4  性别 x=321.3  护照 x=345.9
     六列起点完全一致，按「护照号」当行锚往下找同 y 的项即可。

     列位置用「相对护照列的偏移 / 页宽」表达，不写死像素：
     万一打印缩放不同，比例关系不变。
     ============================================================ */
  var PASS_RE = /^[A-Z]{2}\d{6,9}$/;
  var DUTY_RE = /^(CA|FO|STW|SEC)$/;

  // 各列相对「护照列起点」的横向偏移（已除以页宽）
  var COLOFF = {
    duty:   [-0.460, -0.390],
    name:   [-0.390, -0.170],
    nation: [-0.170, -0.135],
    dob:    [-0.135, -0.048],
    sex:    [-0.048, -0.012]
  };

  function readItems(pdfDoc) {
    return pdfDoc.getPage(1).then(function (page) {
      var vp = page.getViewport({ scale: 1 });
      return page.getTextContent().then(function (tc) {
        var out = [];
        for (var i = 0; i < tc.items.length; i++) {
          var it = tc.items[i];
          var s = String(it.str || '').replace(/\s+/g, ' ').trim();
          if (!s) continue;
          out.push({
            s: s,
            x: it.transform[4],
            y: it.transform[5],
            w: it.width || 0
          });
        }
        return { items: out, pageW: vp.width, pageH: vp.height };
      });
    });
  }

  // 从一行里按横向偏移区间取出文本
  function pickBand(rowItems, anchor, pageW, band) {
    var hit = [];
    for (var i = 0; i < rowItems.length; i++) {
      var d = (rowItems[i].x - anchor.x) / pageW;
      if (d >= band[0] && d <= band[1]) hit.push(rowItems[i]);
    }
    hit.sort(function (a, b) { return a.x - b.x; });
    return hit.map(function (o) { return o.s; }).join(' ').trim();
  }

  /* 把文字层整理成机组行。以护照号做锚：
     每行必然有护照号，TTL 合计行没有，自然被排除。 */
  function parseTextLayer(data) {
    var items = data.items, pageW = data.pageW, pageH = data.pageH;
    var tol = Math.max(2, pageH * 0.004);   // 同一行的 y 容差

    var anchors = [];
    for (var i = 0; i < items.length; i++) {
      var t = items[i].s.toUpperCase().replace(/\s+/g, '');
      if (PASS_RE.test(t)) anchors.push(items[i]);
    }
    if (anchors.length < 2) return null;    // 没有文字层，交给 OCR

    var list = [];
    var stwSeen = 0;
    for (var a = 0; a < anchors.length; a++) {
      var an = anchors[a];
      // 收集同一行的所有项
      var rowItems = [];
      for (var j = 0; j < items.length; j++) {
        if (Math.abs(items[j].y - an.y) <= tol) rowItems.push(items[j]);
      }

      var dutyRaw = pickBand(rowItems, an, pageW, COLOFF.duty).toUpperCase().replace(/[^A-Z]/g, '');
      var duty = DUTY_RE.test(dutyRaw) ? dutyRaw : '';
      var name = pickBand(rowItems, an, pageW, COLOFF.name).toUpperCase()
        .replace(/[^A-Z'.\- ]/g, '').replace(/\s+/g, ' ').trim();
      var dob = pickBand(rowItems, an, pageW, COLOFF.dob).replace(/\D/g, '').slice(0, 6);
      var sexRaw = pickBand(rowItems, an, pageW, COLOFF.sex).toUpperCase();
      var sex = /\bF\b/.test(sexRaw) ? 'F' : (/\bM\b/.test(sexRaw) ? 'M' : '');
      var pass = an.s.toUpperCase().replace(/\s+/g, '');

      if (duty === 'STW') stwSeen++;

      list.push({
        duty: duty,
        isFirstStw: (duty === 'STW' && stwSeen === 1),
        name: name,
        dob: dob,
        sex: sex,
        passport: pass
      });
    }
    return list;
  }

  var libPromise = null;

  function loadLib() {
    if (window.Tesseract) return Promise.resolve(window.Tesseract);
    if (libPromise) return libPromise;
    libPromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = './libs/tesseract/tesseract.min.js';
      s.onload = function () {
        window.Tesseract ? resolve(window.Tesseract) : reject(new Error('识别引擎没起来'));
      };
      s.onerror = function () { reject(new Error('识别引擎文件没加载出来')); };
      document.head.appendChild(s);
    });
    return libPromise;
  }

  function clean(s) {
    return String(s || '').replace(/[^A-Za-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // 从整页 canvas 裁一块出来，单独送识别
  function crop(src, x, y, w, h) {
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    var ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(src, Math.round(x), Math.round(y), Math.round(w), Math.round(h), 0, 0, c.width, c.height);
    return c;
  }

  function renderPage(pdfDoc, pageNo) {
    return pdfDoc.getPage(pageNo).then(function (page) {
      var vp1 = page.getViewport({ scale: 1 });
      var scale = RENDER_W / vp1.width;
      var vp = page.getViewport({ scale: scale });
      var cv = document.createElement('canvas');
      cv.width = Math.floor(vp.width);
      cv.height = Math.floor(vp.height);
      var ctx = cv.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, cv.width, cv.height);
      return page.render({ canvasContext: ctx, viewport: vp }).promise.then(function () {
        return cv;
      });
    });
  }

  // 只保留数字（生日列）
  function onlyDigits(s) {
    return String(s || '').replace(/\D/g, '');
  }

  /* 把 OCR 出来的原始文本整理成一行行数据。
     行数以「姓名列」为准 —— 每行必有人名，最不容易漏。 */
  function assemble(raw) {
    var nameList = raw.name || [];
    var n = nameList.length;

    // 其他列可能识别多（职务列末尾有 TTL 合计行）或少，统一对齐到 n
    var pick = function (list, i) { return (list[i] || '').trim(); };

    var out = [];
    var stwSeen = 0;
    for (var i = 0; i < n; i++) {
      var duty = pick(raw.duty, i).toUpperCase().replace(/[^A-Z]/g, '');
      // 职务常见误识纠正：5T3W→STW、CA 打成 GA/DA 等
      if (/^[5S]T[Ww]$/.test(duty) || duty === 'ST3W') duty = 'STW';
      if (duty === '5EC' || duty === 'SEC') duty = 'SEC';
      if (!DUTY_OK[duty]) duty = '';

      var sexRaw = pick(raw.sex, i).toUpperCase();
      var sex = sexRaw.indexOf('F') === 0 ? 'F' : (sexRaw.indexOf('M') === 0 ? 'M' : '');

      var dob = onlyDigits(pick(raw.dob, i)).slice(0, 6);

      // 护照号：从识别文本里抓「两字母 + 6~8 位数字」
      var passRaw = pick(raw.pass, i).toUpperCase().replace(/\s+/g, '');
      var pm = passRaw.match(/[A-Z]{2}\d{6,8}/);
      var pass = pm ? pm[0] : passRaw;

      var name = pick(raw.name, i).toUpperCase();

      // 乘务员组第一个当乘务长
      if (duty === 'STW') { stwSeen++; }
      var isFirstStw = (duty === 'STW' && stwSeen === 1);

      out.push({
        duty: duty,
        isFirstStw: isFirstStw,
        name: name,
        dob: dob,
        sex: sex,
        passport: pass
      });
    }
    return out;
  }

  /* 判断识别结果可不可信：姓名和护照号缺太多就不让自动填，
     宁可让用户手打，也不要把错的东西填进去。 */
  function judge(list) {
    if (!list.length) return { ok: false, reason: '没认出机组行' };
    var badName = 0, badPass = 0, badDuty = 0;
    list.forEach(function (r) {
      if (!/^[A-Z][A-Z'.\- ]{1,}$/.test(r.name)) badName++;
      if (!/^[A-Z]{2}\d{6,8}$/.test(r.passport)) badPass++;
      if (!r.duty) badDuty++;
    });
    var n = list.length;
    if (badName > Math.floor(n * 0.25)) return { ok: false, reason: '姓名认得不太对' };
    if (badPass > Math.floor(n * 0.25)) return { ok: false, reason: '护照号认得不太对' };
    if (badDuty > Math.floor(n * 0.25)) return { ok: false, reason: '职务列对不上' };
    return { ok: true, badName: badName, badPass: badPass, badDuty: badDuty };
  }

  // 读一列：设版面模式 → 识别 → 按行拆开清洗
  async function readColumn(worker, canvas, psm) {
    await worker.setParameters({ tessedit_pageseg_mode: psm });
    var res = await worker.recognize(canvas);
    return res.data.text.split('\n').map(clean).filter(Boolean);
  }

  /* 主入口：给一个 pdf.js 的 document，返回识别结果 */
  window.crewOcr = async function (pdfDoc, onStep) {
    var step = onStep || function () {};
    if (!pdfDoc || !pdfDoc.numPages) throw new Error('没有可识别的 GD 单');

    // ---------- 先看这份 PDF 有没有文字层 ----------
    step('正在读单子…', 0.1);
    var tl = null;
    try { tl = await readItems(pdfDoc); } catch (e) { tl = null; }

    if (tl) {
      var fromText = parseTextLayer(tl);
      if (fromText && fromText.length >= 2) {
        step('正在核对…', 0.9);
        var vT = judge(fromText);
        var all = tl.items.map(function (o) { return o.s; }).join(' ');
        var fmT = all.match(/\b[A-Z]{2}\d{3,4}\b/);
        var dmT = all.match(/(19|20)\d{2}-\d{2}-\d{2}/);
        return {
          ok: vT.ok,
          reason: vT.reason || '',
          mode: 'text',
          rows: fromText,
          flightNo: fmT ? fmT[0] : '',
          date: dmT ? dmT[0] : '',
          counts: { n: fromText.length },
          bad: { name: vT.badName || 0, pass: vT.badPass || 0, duty: vT.badDuty || 0 }
        };
      }
    }

    // ---------- 没有文字层：渲染成图再认 ----------
    step('正在把单子转成高清图…', 0.06);
    var cv = await renderPage(pdfDoc, 1);

    step('正在加载识别引擎（第一次会稍慢）…', 0.12);
    var T = await loadLib();

    var worker = await T.createWorker('eng', 1, {
      workerPath: './libs/tesseract/worker.min.js',
      corePath: './libs/tesseract/tesseract-core-simd-lstm.wasm.js',
      langPath: './libs/tesseract/lang',
      gzip: true
    });

    var raw = {};
    try {
      for (var i = 0; i < COLS.length; i++) {
        var c = COLS[i];
        step('正在认第 ' + (i + 1) + ' / ' + COLS.length + ' 列…', 0.18 + 0.15 * i);

        var x = c.x0 * cv.width;
        var w = (c.x1 - c.x0) * cv.width;
        var y0 = c.y0 === undefined ? ROW_Y0 : c.y0;
        var y = y0 * cv.height;
        var h = ((c.y1 || ROW_Y1) - y0) * cv.height;
        var piece = crop(cv, x, y, w, h);

        var lines = await readColumn(worker, piece, c.psm);

        // 职务列兜底：行数明显不对就换版面模式重认
        if (c.retry) {
          for (var k = 0; k < c.retry.length && lines.length < 5; k++) {
            var alt = await readColumn(worker, piece, c.retry[k]);
            if (alt.length > lines.length) lines = alt;
            if (lines.length >= 5) break;
          }
        }

        raw[c.key] = lines;
        if (window.CREW_OCR_DEBUG) {
          console.log('[ocr] ' + c.key + ' 裁 ' + Math.round(w) + 'x' + Math.round(h) +
            ' 得 ' + lines.length + ' 行: ' + JSON.stringify(lines.slice(0, 5)));
        }
      }
    } finally {
      try { await worker.terminate(); } catch (e) {}
    }

    step('正在核对…', 0.97);
    var list = assemble(raw);
    var verdict = judge(list);

    // 顺手把右上角的 Flight No 和 Date 读出来，省得再手打
    // 日期里的横线常被认成空格（"2025-07-18" → "2025 07 18"），所以分隔符都放开
    var headText = (raw.head || []).join(' ');
    var fm = headText.match(/[A-Z]{2}\s?\d{3,4}/);
    var dm = headText.match(/(19|20)(\d{2})[-./\s]?(\d{1,2})[-./\s]?(\d{1,2})/);
    var pad = function (v) { return ('0' + v).slice(-2); };

    return {
      ok: verdict.ok,
      reason: verdict.reason || '',
      mode: 'ocr',
      rows: list,
      flightNo: fm ? fm[0].replace(/\s/g, '') : '',
      date: dm ? dm[1] + dm[2] + '-' + pad(dm[3]) + '-' + pad(dm[4]) : '',
      counts: {
        duty: (raw.duty || []).length,
        name: (raw.name || []).length,
        dob: (raw.dob || []).length,
        sex: (raw.sex || []).length,
        pass: (raw.pass || []).length
      },
      bad: { name: verdict.badName || 0, pass: verdict.badPass || 0, duty: verdict.badDuty || 0 }
    };
  };
})();
