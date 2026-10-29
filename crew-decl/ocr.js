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
    // 上限压在姓名列之前（姓名列起点 0.2478），留 ~1mm 余量。
    // 原来裁到 0.2520 会把姓名首字母一起带进来，"CA" 变 "CA Z"，职务全判无效。
    { key: 'duty', x0: 0.1680, x1: 0.2380, psm: '4', y1: 0.6670, retry: ['6', '11'] },
    { key: 'head', x0: 0.5376, x1: 0.8148, y0: 0.0564, y1: 0.0951, psm: '6' }
  ];
  var ROW_Y0 = 0.1812;   // 表格数据区上沿
  // 20 行时的表格下沿 = ROW_Y0 + 20 × ROW_H = 0.6534，实测吻合
  var ROW_H  = 0.02361;  // 单行高度（占页高比例）—— GD 单行高是固定的，
                         // 人数越多表格越长。固定按 20 行裁，人一多就漏行。
  var ROW_PAD = 0.004;   // 底边多留一点，免得最后一行字的下缘被切掉

  /* 职务白名单。CA 机长 / FO 副驾驶 / FE 飞行机械员 / STW 客舱 / SEC 安全员。
     🔥 FE 是 2026-10-24 补的：有两张单子上真有飞行机械员，
        不在表里 → 那行不是锚点 → 整行丢 → 人数对不上 → 整张单子判失败。
     🔥 别改成「职务列任意 2–3 位大写字母」：同一列里 `TTL` 也是 3 位大写，
        那样会凭空多出一行。必须白名单。 */
  var DUTY_OK = { CA: 1, FO: 1, FE: 1, STW: 1, SEC: 1 };

  /* ============================================================
     模式一：PDF 自带文字层，直接精确读
     ------------------------------------------------------------
     有些 GD 单是浏览器「打印成 PDF」生成的（Producer 为
     Skia/PDF 或 Chrome），文字没被转曲，文件里就有真字符。
     这种单子根本不用识别，把字符连同坐标读出来即可 —— 又快又准，
     而且人数变了也不影响（不依赖固定行高比例）。

     实测某国际航班（19 人）：
       职务 x=102  姓名 x=130.1  国籍 x=249.4
       生日 x=275.4  性别 x=321.3  护照 x=345.9
     六列起点完全一致。

     行锚用「职务」而不是护照号：职务只有 CA/FO/SEC/STW 四个枚举值，
     文字层里一定是独立一项，最可靠。护照号不能当锚 —— 外籍护照格式
     五花八门（X12345678、AB1234567、纯数字…），一旦某行护照号认不出，
     整行就丢，而且后面的行会往上错位顶替，看着还很像一份正常的表。
     实测踩过：3 人单里有 1 个外籍，结果只填 2 人且全部错位。

     列位置用「相对职务列的偏移 / 页宽」表达，不写死像素：
     万一打印缩放不同，比例关系不变。
     ============================================================ */
  var PASS_LOOSE = /^(?=.*\d)[A-Z][A-Z0-9]{5,11}$/;  // 放宽：字母开头、含数字、6~12 位

  /* 文字层里的职务常带尾部标点（实测 9 份单子里有 21 处 `STW.`），
     直接拿正则匹配会漏掉这些行。先去标点、再查白名单。
     ⚠️ 白名单不能放宽成「任意 2–3 位大写」：同一列里 `TTL` 也是 3 位大写。 */
  function normDutyText(s) {
    var d = String(s || '').toUpperCase().replace(/[^A-Z]/g, '');
    return DUTY_OK[d] ? d : '';
  }

  // 各列相对「职务列起点」的横向偏移（已除以页宽）
  // 上限压在国籍列之前，免得姓名尾巴把 CN 一起吃进来
  var COLOFF = {
    name:   [0.020, 0.225],
    nation: [0.225, 0.275],
    dob:    [0.275, 0.340],
    sex:    [0.340, 0.395],
    pass:   [0.395, 0.490]
  };

  function readItems(pdfDoc, pageNo) {
    return pdfDoc.getPage(pageNo || 1).then(function (page) {
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
        return { items: out, pageW: vp.width, pageH: vp.height, page: pageNo || 1 };
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

  /* 把一页的文字层整理成机组行。以职务（CA/FO/SEC/STW）做行锚：
     TTL 合计行、表头、底部签字区都没有这四个词，天然被排除。
     返回 null 表示这页没有可用的文字层。 */
  function parseTextLayer(data) {
    var items = data.items, pageW = data.pageW, pageH = data.pageH;
    var tol = Math.max(2, pageH * 0.004);   // 同一行的 y 容差

    var anchors = [];
    for (var i = 0; i < items.length; i++) {
      if (normDutyText(items[i].s)) anchors.push(items[i]);
    }
    if (!anchors.length) return null;

    // PDF 的 y 轴朝上，按 y 从大到小 = 从上到下的阅读顺序
    anchors.sort(function (a, b) { return b.y - a.y; });

    var list = [];
    for (var a = 0; a < anchors.length; a++) {
      var an = anchors[a];
      var rowItems = [];
      for (var j = 0; j < items.length; j++) {
        if (Math.abs(items[j].y - an.y) <= tol) rowItems.push(items[j]);
      }

      var duty = normDutyText(an.s);

      // 姓名：只留字母、撇号、点、横线、空格
      var name = pickBand(rowItems, an, pageW, COLOFF.name).toUpperCase()
        .replace(/[^A-Z'.\- ]/g, '').replace(/\s+/g, ' ').trim();

      var dob = pickBand(rowItems, an, pageW, COLOFF.dob).replace(/\D/g, '').slice(0, 6);

      var sexRaw = pickBand(rowItems, an, pageW, COLOFF.sex).toUpperCase();
      var sex = /\bF\b/.test(sexRaw) ? 'F' : (/\bM\b/.test(sexRaw) ? 'M' : '');

      // 护照号：各页格式不统一，宽松取，取不到就留原始文本让校验去报
      var passRaw = pickBand(rowItems, an, pageW, COLOFF.pass)
        .toUpperCase().replace(/[^A-Z0-9]/g, '');
      var pass = passRaw;
      if (!PASS_LOOSE.test(passRaw)) {
        // 常见是首字母被认成数字或丢了，尝试从原文里捞一段形似护照的
        var m = passRaw.match(/[A-Z][A-Z0-9]{5,11}/);
        if (m) pass = m[0];
      }

      list.push({
        duty: duty,
        isFirstStw: false,     // 跨页合并后再统一算乘务长
        name: name,
        dob: dob,
        sex: sex,
        passport: pass
      });
    }
    return list;
  }

  /* 从单子上读 TTL（Total）那个合计人数 —— 用来交叉核对：
     认出来的人数和单子自己写的人数对不上，就一定有问题。 */
  function readTtl(data) {
    var items = data.items;
    for (var i = 0; i < items.length; i++) {
      var s = items[i].s.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (s === 'TTL' || s === 'TOTAL') {
        // TTL 右边紧邻的那一项就是人数
        var best = null, bestDx = 1e9;
        for (var j = 0; j < items.length; j++) {
          if (Math.abs(items[j].y - items[i].y) > 6) continue;
          var dx = items[j].x - items[i].x;
          if (dx > 0 && dx < bestDx) { bestDx = dx; best = items[j]; }
        }
        if (best) {
          var n = String(best.s).replace(/\D/g, '');
          if (n && n.length <= 3) return Number(n);
        }
      }
    }
    return 0;
  }

  /* 单子上到底有没有印 TTL 这一项。
     用来区分「合计 0 人」和「压根没读到 TTL」——readTtl 两种都返回 0，
     但含义完全不同：前者是空单子，后者只是没读出来。 */
  function hasTtl(data) {
    var items = data.items;
    for (var i = 0; i < items.length; i++) {
      var s = items[i].s.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (s === 'TTL' || s === 'TOTAL') return true;
    }
    return false;
  }

  // 合并多页结果，重新算「第一个 STW 当乘务长」
  function finalize(list) {
    var stw = 0;
    for (var i = 0; i < list.length; i++) {
      if (list[i].duty === 'STW') {
        stw++;
        list[i].isFirstStw = (stw === 1);
      }
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

  /* 职务归一化：把常见误识纠正过来，不是四种合法职务就返回空 */
  function normalizeDuty(s) {
    var d = String(s || '').toUpperCase().replace(/[^A-Z]/g, '');
    if (/^[5S]T3?W$/.test(d)) d = 'STW';        // 5T3W / ST3W / 5TW → STW
    if (d === '5EC' || d === 'SEC') d = 'SEC';
    return DUTY_OK[d] ? d : '';
  }

  /* 把 OCR 出来的原始文本整理成一行行数据。
     行数以「姓名列」为准 —— 每行必有人名，最不容易漏。
     表格下面还印着 TTL 合计行、签字栏，裁高一点就会混进姓名列里，
     所以末尾那种「既没职务、护照号也不成形」的尾巴整段丢掉。 */
  function assemble(raw) {
    var nameList = raw.name || [];
    var n = nameList.length;

    // 其他列可能识别多（职务列末尾有 TTL 合计行）或少，统一对齐到 n
    var pick = function (list, i) { return (list[i] || '').trim(); };

    var out = [];
    var stwSeen = 0;
    for (var i = 0; i < n; i++) {
      var duty = normalizeDuty(pick(raw.duty, i));

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

    // 掐掉末尾的噪音行（TTL 合计、签字、说明文字）
    while (out.length) {
      var last = out[out.length - 1];
      if (last.duty || PASS_LOOSE.test(last.passport)) break;
      out.pop();
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
      // 护照号用宽松规则：外籍机组不一定是 SE+7 位数字
      if (!PASS_LOOSE.test(r.passport)) badPass++;
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

    var totalPages = pdfDoc.numPages;

    // ---------- 先看这份 PDF 有没有文字层 ----------
    // 逐页看：人手多的时候单子会跨页，只读第 1 页会漏人
    step(totalPages > 1 ? '正在读单子（共 ' + totalPages + ' 页）…' : '正在读单子…', 0.08);
    var pages = [];
    try {
      for (var p = 1; p <= totalPages; p++) pages.push(await readItems(pdfDoc, p));
    } catch (e) { pages = []; }

    var fromText = [], ttl = 0, headTextAll = '', ttlSeen = false;
    for (var pi = 0; pi < pages.length; pi++) {
      var part = parseTextLayer(pages[pi]);
      if (part && part.length) fromText = fromText.concat(part);
      var t = readTtl(pages[pi]);
      if (t) ttl = t;
      if (hasTtl(pages[pi])) ttlSeen = true;
      headTextAll += ' ' + pages[pi].items.map(function (o) { return o.s; }).join(' ');
    }

    if (fromText.length >= 1) {
      step('正在核对…', 0.9);
      fromText = finalize(fromText);
      var vT = judge(fromText);
      // 单子上自己写着 TTL 人数，对不上就一定有问题 —— 宁可退回手录
      if (vT.ok && ttl && ttl !== fromText.length) {
        vT = { ok: false, reason: '单子写 ' + ttl + ' 人，只认出 ' + fromText.length + ' 人' };
      }
      var fmT = headTextAll.match(/\b[A-Z]{2}\d{3,4}\b/);
      var dmT = headTextAll.match(/(19|20)\d{2}-\d{2}-\d{2}/);
      return {
        ok: vT.ok,
        reason: vT.reason || '',
        mode: 'text',
        rows: vT.ok ? fromText : [],
        found: fromText.length,
        ttl: ttl,
        pages: totalPages,
        flightNo: fmT ? fmT[0] : '',
        date: dmT ? dmT[0] : '',
        counts: { n: fromText.length },
        bad: { name: vT.badName || 0, pass: vT.badPass || 0, duty: vT.badDuty || 0 }
      };
    }

    /* 有文字层、却连一个机组行都没有，而且单子上明明白白印着合计 0 人
       —— 这是空单子（调机、无机组），不是认不出来。
       以前这种会掉进下面的 OCR 分支，白等一次 5.8MB 识别引擎加载，
       最后才说「没认出机组行」，让人以为是程序不行。直接给准确说法。
       ⚠️ 只在「确实读到 TTL = 0」时才短路：如果 TTL 读不到（ttlSeen=false），
          或者 TTL 有数但没有锚点（职务写法不认识），仍要走 OCR 再试一次。 */
    if (ttlSeen && !ttl) {
      var fmE = headTextAll.match(/\b[A-Z]{2}\d{3,4}\b/);
      var dmE = headTextAll.match(/(19|20)\d{2}-\d{2}-\d{2}/);
      return {
        ok: false,
        reason: '这张单子上没有机组行（合计 0 人）',
        mode: 'text',
        rows: [],
        found: 0,
        ttl: 0,
        pages: totalPages,
        flightNo: fmE ? fmE[0] : '',
        date: dmE ? dmE[0] : '',
        counts: { n: 0 },
        bad: { name: 0, pass: 0, duty: 0 }
      };
    }

    // ---------- 没有文字层：渲染成图再认 ----------
    // 同样逐页处理：第 1 页按标准版式裁，第 2 页起没有表头，从页面顶部整页裁
    step('正在加载识别引擎（第一次会稍慢）…', 0.1);
    var T = await loadLib();

    var worker = await T.createWorker('eng', 1, {
      workerPath: './libs/tesseract/worker.min.js',
      corePath: './libs/tesseract/tesseract-core-simd-lstm.wasm.js',
      langPath: './libs/tesseract/lang',
      gzip: true
    });

    var list = [], rawHead = null;

    /* 先单独读一下单子上的 TTL 合计人数 —— 它决定表格有多长。
       GD 单行高固定，人数多表格就往下长；固定按 20 行裁，
       21 人以上会被截断，多出来的行整行丢失。
       读不到 TTL 就按 20 人算（最常见的规模）。 */
    var ttlNum = 0;
    try {
      step('正在读单子上的合计人数…', 0.13);
      var tcv = await renderPage(pdfDoc, totalPages);
      var tpiece = crop(tcv,
        0.168 * tcv.width, 0.15 * tcv.height,
        (0.41 - 0.168) * tcv.width, 0.84 * tcv.height);
      var tlines = await readColumn(worker, tpiece, '6');
      var tm = tlines.join(' ').match(/TTL[^0-9]{0,6}(\d{1,3})/);
      if (tm) ttlNum = Number(tm[1]);
      if (window.CREW_OCR_DEBUG) console.log('[ocr] TTL 读到: ' + ttlNum + ' | ' + JSON.stringify(tlines.slice(-4)));
    } catch (e) { ttlNum = 0; }

    // 按人数算表格底边；一页放不下就整页裁，再逐页往下接
    var perPageCap = Math.max(1, Math.floor((0.96 - ROW_Y0) / ROW_H));
    var multiPage = ttlNum > perPageCap;
    // 人数没读到时不要只按 20 行裁 —— 21 人单会悄悄少掉最后一行，
    // 而且看起来还挺像一张正常的表。多放几行，末尾的噪音由 assemble 掐掉。
    var y1Fixed = Math.min(0.96, ROW_Y0 + Math.max(ttlNum || 0, 24) * ROW_H + ROW_PAD);

    try {
      for (var pg = 1; pg <= totalPages; pg++) {
        step('正在把第 ' + pg + ' 页转成高清图…', 0.16 + 0.1 * (pg - 1));
        var cv = await renderPage(pdfDoc, pg);
        var isFirst = (pg === 1);
        var pageRaw = {};

        for (var i = 0; i < COLS.length; i++) {
          var c = COLS[i];
          // 航班号日期只取第 1 页的固定位置
          if (c.key === 'head' && !isFirst) continue;
          step('第 ' + pg + ' 页：正在认第 ' + (i + 1) + ' / ' + COLS.length + ' 列…',
            0.22 + 0.55 * ((pg - 1) * COLS.length + i) / (totalPages * COLS.length));

          var x = c.x0 * cv.width;
          var w = (c.x1 - c.x0) * cv.width;
          // 表头那种固定位置（有 y0 的）不动；数据列按人数算出来的底边
          var isFixed = (c.y0 !== undefined);
          var y0 = isFixed ? c.y0 : (isFirst ? ROW_Y0 : 0.02);
          var y1;
          if (isFixed) y1 = c.y1;
          else if (!isFirst) y1 = 0.98;
          else if (multiPage) y1 = 0.96;
          else y1 = Math.max(c.y1 || 0, y1Fixed);
          var y = y0 * cv.height;
          var h = (y1 - y0) * cv.height;
          var piece = crop(cv, x, y, w, h);

          var lines = await readColumn(worker, piece, c.psm);

          // 职务列兜底：这块是 200px 宽的窄条，最容易整列认废。
          // 拿姓名列的行数当基准 —— 有效职务不到八成就换版面模式重认，取最好的那次。
          if (c.retry) {
            var need = Math.max(1, (pageRaw.name || []).length);
            var countOk = function (ls) {
              var v = 0;
              for (var q = 0; q < ls.length; q++) if (normalizeDuty(ls[q])) v++;
              return v;
            };
            var best = countOk(lines);
            for (var k = 0; k < c.retry.length && best < need * 0.8; k++) {
              var alt = await readColumn(worker, piece, c.retry[k]);
              var sc = countOk(alt);
              if (sc > best) { best = sc; lines = alt; }
            }
          }

          pageRaw[c.key] = lines;
          if (window.CREW_OCR_DEBUG) {
            console.log('[ocr] 第' + pg + '页 ' + c.key + ' 裁 ' + Math.round(w) + 'x' + Math.round(h) +
              ' 得 ' + lines.length + ' 行: ' + JSON.stringify(lines.slice(0, 5)));
          }
        }

        if (isFirst) { rawHead = pageRaw.head || []; }

        var part2 = assemble(pageRaw);
        // 第 2 页起没有表头，整页裁会带进签字、说明之类，靠护照/职务过滤掉噪音
        if (!isFirst) {
          part2 = part2.filter(function (r) {
            return (r.passport && PASS_LOOSE.test(r.passport)) || r.duty;
          });
        }
        list = list.concat(part2);
      }
    } finally {
      try { await worker.terminate(); } catch (e) {}
    }

    step('正在核对…', 0.97);
    list = finalize(list);
    var verdict = judge(list);
    var ttlOcr = ttlNum;   // 前面专门读过一次，比从头里猜准
    if (verdict.ok && ttlOcr && ttlOcr !== list.length) {
      verdict = { ok: false, reason: '单子写 ' + ttlOcr + ' 人，只认出 ' + list.length + ' 人' };
    }

    // 顺手把右上角的 Flight No 和 Date 读出来，省得再手打
    // 日期里的横线常被认成空格（"2025-07-18" → "2025 07 18"），所以分隔符都放开
    var headText = (rawHead || []).join(' ');
    var fm = headText.match(/[A-Z]{2}\s?\d{3,4}/);
    var dm = headText.match(/(19|20)(\d{2})[-./\s]?(\d{1,2})[-./\s]?(\d{1,2})/);
    var pad = function (v) { return ('0' + v).slice(-2); };

    return {
      ok: verdict.ok,
      reason: verdict.reason || '',
      mode: 'ocr',
      rows: verdict.ok ? list : [],
      found: list.length,
      ttl: ttlOcr,
      pages: totalPages,
      flightNo: fm ? fm[0].replace(/\s/g, '') : '',
      date: dm ? dm[1] + dm[2] + '-' + pad(dm[3]) + '-' + pad(dm[4]) : '',
      counts: { n: list.length },
      bad: { name: verdict.badName || 0, pass: verdict.badPass || 0, duty: verdict.badDuty || 0 }
    };
  };
})();
