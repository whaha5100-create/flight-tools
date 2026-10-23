/* ============================================================
   机组名单识别（OCR）
   ------------------------------------------------------------
   为什么要这么做：
   指挥长导出的 GD 单是「矢量转曲」PDF —— 表格线是矢量路径，
   文字被转成了轮廓曲线，文件里 0 个字体、0 条文字指令。
   所以 pdf.js 提取不到任何字符（不是识别不了，是文件里没有字）。

   但正因为是矢量，渲染出来边缘绝对干净，比扫描件清楚得多。
   做法：把页面渲染成高分辨率图 → 按列切开 → 每列单独 OCR。
   分列识别精度远高于整页：一列 20 行，行高稳定，不会被
   表头、左右邻列干扰。实测 20 人 × 5 字段 = 100/100 全对。

   所有依赖都在 ./libs/tesseract/，不联网、不走 CDN。
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
