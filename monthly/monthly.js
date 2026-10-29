/* ================================================================
   经营月报生成 —— 用东上联数据汇总表，填两份月报（东上航 / 联航）的表格
   ----------------------------------------------------------------
   数据流：xlsx（东上航 / 联航 两个 sheet）
        → 按日期月份汇总 7 个指标
        → 写进 docx 表格的第 (月份 + 2) 列
        → 顺带算「汇总」与「环比」
        → 浏览器里直接改 document.xml 再打包下载（格式一个字节都不动）

   ⚠️ 两条必须守住的约定：
     1. 只改表格里的单元格文字，**不动任何样式节点**（tcPr / pPr / rPr 原样保留）
     2. 改行内单元格用「按位置切片」重建，**不能用字符串 replace**
        —— 空单元格的 XML 是逐字节相同的，replace 会改错格子
   ================================================================ */
(function () {
  'use strict';

  /* ---------- 常量 ---------- */
  var SHEETS = { MU: '东上航', KN: '联航' };
  var NAMES = { MU: '东上航', KN: '联航' };
  var FILE_TAG = { MU: 'MU,FM', KN: 'KN' };

  /* 数据表列号（1 起，两个 sheet 结构相同） */
  var C = {
    date: 1, outPax: 3, outBag: 5, inPax: 8, inBag: 10,
    wheel: 12, unacc: 13, inActD: 14, inActI: 15, outActD: 16, outActI: 17
  };

  /* 真正会用到的 10 个数值列 —— 逐日体检就是数这 10 格里空了几格。
     注意：它和上面的 C 不是一回事，C 里有 date，这里没有。 */
  var KEYCOLS = [C.outPax, C.outBag, C.inPax, C.inBag,
                 C.wheel, C.unacc, C.inActD, C.inActI, C.outActD, C.outActI];

  /* 月报行号（含表头行）→ 指标 */
  var ITEMS = [
    { key: 'inAct', row: 2, name: '进出港架次 · 进港' },
    { key: 'outAct', row: 3, name: '进出港架次 · 出港' },
    { key: 'inPax', row: 4, name: '旅客运输量 · 进港' },
    { key: 'outPax', row: 5, name: '旅客运输量 · 出港' },
    { key: 'inBag', row: 6, name: '行李运输量 · 进港' },
    { key: 'outBag', row: 7, name: '行李运输量 · 出港' },
    { key: 'threeSmall', row: 10, name: '「三小」运输量' }
  ];

  var BLANK_NAMES = '货邮运输重量、不正常航班费用、行李赔偿费、行李破损率、行李类投诉量、民航局投诉量、全渠道投诉量、遣返旅客';

  var LS = { MU: 'flighttools.monthly.tpl.mu', KN: 'flighttools.monthly.tpl.kn' };

  /* ---------- DOM ---------- */
  var $ = function (id) { return document.getElementById(id); };
  var uploadArea = $('uploadArea'), fileInput = $('fileInput'), pickBtn = $('pickBtn');
  var pickRow = $('pickRow'), monthSel = $('monthSel');
  var rangeText = $('rangeText'), rangeSub = $('rangeSub'), fileText = $('fileText');
  var warnTip = $('warnTip'), previewBody = $('mrPreview');
  var dlMu = $('dlMu'), dlKn = $('dlKn'), dlName = $('dlName');

  /* ---------- 状态 ---------- */
  var state = {
    fileName: '',
    year: 0,
    month: 0,
    data: { MU: null, KN: null },   /* { perMonth: {m:{...}}, min:{y,m,d}, max:{y,m,d} } */
    tpl: { MU: null, KN: null }     /* ArrayBuffer 或 null（null = 用内置） */
  };

  /* ================================================================
     1. 读数据表
     ================================================================ */

  /* 把单元格值变成 {y,m,d}；兼容序列号 / 文本日期 / Date */
  function dateParts(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number' && isFinite(v)) {
      /* 1900 日期系统：序列号 → UTC 日期（避开时区偏移导致跨月） */
      var ms = Date.UTC(1899, 11, 30) + Math.round(v) * 86400000;
      var d = new Date(ms);
      return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
    }
    if (v instanceof Date) {
      return { y: v.getFullYear(), m: v.getMonth() + 1, d: v.getDate() };
    }
    var s = String(v).trim();
    var mm = s.match(/^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/);
    if (mm) return { y: +mm[1], m: +mm[2], d: +mm[3] };
    return null;
  }

  /* 这个格子算不算「没填」。注意 0 是填了的（可能是真停场），None 才是没填。 */
  function isBlank(v) {
    if (v === null || v === undefined) return true;
    if (typeof v === 'number') return false;
    if (v instanceof Date) return false;
    var s = String(v).trim();
    return !s || s === '无数据' || s === '/' || s === '-';
  }

  /* 单元格 → 数字。空 / "无数据" / "/" → 0；"0+1" → 1 */
  function num(v) {
    if (isBlank(v)) return 0;
    if (typeof v === 'number') return isFinite(v) ? v : 0;
    var s = String(v).trim();
    if (s.indexOf('+') >= 0) {
      return s.split('+').reduce(function (a, x) { return a + num(x); }, 0);
    }
    var f = parseFloat(s.replace(/,/g, ''));
    return isFinite(f) ? f : 0;
  }

  function readSheet(wb, name) {
    var ws = wb.Sheets[name];
    if (!ws) return null;
    var rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: true });

    /* 第一遍：找主年份（行数最多），以及日期范围 —— 只认这一年，
       否则「2026 年表里混进一条 2025 年的记录」会把月份合并错 */
    var years = {}, min = null, max = null;
    for (var i = 1; i < rows.length; i++) {
      var dp = dateParts((rows[i] || [])[C.date - 1]);
      if (!dp) continue;
      years[dp.y] = (years[dp.y] || 0) + 1;
      if (!min || cmp(dp, min) < 0) min = dp;
      if (!max || cmp(dp, max) > 0) max = dp;
    }
    var year = 0, best = -1;
    for (var y in years) { if (years[y] > best) { best = years[y]; year = +y; } }
    if (!year) return { perMonth: {}, min: null, max: null, year: 0 };

    /* 第二遍：只累计主年份 */
    var perMonth = {}, rmin = null, rmax = null;
    for (var k = 1; k < rows.length; k++) {
      var row = rows[k] || [];
      var d = dateParts(row[C.date - 1]);
      if (!d || d.y !== year) continue;
      var m = d.m;
      var a = perMonth[m] || (perMonth[m] = {
        inAct: 0, outAct: 0, inPax: 0, outPax: 0, inBag: 0, outBag: 0, threeSmall: 0,
        days: 0, day: {}
      });
      a.inAct += num(row[C.inActD - 1]) + num(row[C.inActI - 1]);
      a.outAct += num(row[C.outActD - 1]) + num(row[C.outActI - 1]);
      a.inPax += num(row[C.inPax - 1]);
      a.outPax += num(row[C.outPax - 1]);
      a.inBag += num(row[C.inBag - 1]);
      a.outBag += num(row[C.outBag - 1]);
      a.threeSmall += num(row[C.wheel - 1]) + num(row[C.unacc - 1]);
      a.days += 1;

      /* 逐日体检用的两个数：空了几格 / 是不是全 0（真停场，不是漏填） */
      var blanks = 0, absSum = 0;
      for (var q = 0; q < KEYCOLS.length; q++) {
        var raw = row[KEYCOLS[q] - 1];
        if (isBlank(raw)) blanks++;
        else absSum += Math.abs(num(raw));
      }
      a.day[d.d] = { none: blanks, zero: blanks === 0 && absSum === 0 };

      /* 「数据覆盖」只算**真有数**的日子。整张表 365 行日期都铺着，
         若按行算会得出 1/1 ~ 12/31 这种没意义的范围（用户 2026-10-26 发现）。 */
      if (blanks < KEYCOLS.length) {
        if (!rmin || cmp(d, rmin) < 0) rmin = d;
        if (!rmax || cmp(d, rmax) > 0) rmax = d;
      }
    }
    return { perMonth: perMonth, min: rmin, max: rmax, year: year };
  }

  function cmp(a, b) {
    return (a.y - b.y) || (a.m - b.m) || (a.d - b.d);
  }

  function loadWorkbook(buf, fileName) {
    var wb;
    try {
      wb = XLSX.read(new Uint8Array(buf), { type: 'array', cellDates: false });
    } catch (e) {
      return warn('这个文件读不开，确认是 Excel（.xls / .xlsx）而不是别的格式。');
    }
    var mu = readSheet(wb, SHEETS.MU), kn = readSheet(wb, SHEETS.KN);
    if (!mu && !kn) {
      var names = wb.SheetNames.join(' / ');
      return warn('表里没找到「东上航」或「联航」这两个 sheet。当前有：' + names);
    }
    state.data.MU = mu;
    state.data.KN = kn;
    state.fileName = fileName;
    state.year = (mu && mu.year) || (kn && kn.year) || new Date().getFullYear();

    /* 默认月份 = 数据里最新的那个「真有数」的月 */
    var latest = 0;
    for (var m = 1; m <= 12; m++) if (hasMonth(m)) latest = m;
    state.month = latest || 1;

    buildMonthOptions();
    renderAll();
  }

  function buildMonthOptions() {
    var html = '';
    for (var m = 1; m <= 12; m++) {
      var has = hasMonth(m);
      html += '<option value="' + m + '">' + m + ' 月' + (has ? '' : '（暂无数据）') + '</option>';
    }
    monthSel.innerHTML = html;
    monthSel.value = String(state.month);
    pickRow.style.display = '';
    fileText.textContent = state.fileName;
  }

  function fmtDate(d) { return d.y + '-' + pad(d.m) + '-' + pad(d.d); }
  function pad(n) { return n < 10 ? '0' + n : String(n); }

  /* 「数据覆盖」那一格 —— 随所选月份变（以前只在导入时算一次，切月份不更新） */
  function renderRange() {
    var min = null, max = null;
    ['MU', 'KN'].forEach(function (t) {
      var d = state.data[t];
      if (!d || !d.min) return;
      if (!min || cmp(d.min, min) < 0) min = d.min;
      if (!max || cmp(d.max, max) > 0) max = d.max;
    });
    if (!min || !max) {
      rangeText.textContent = '—';
      rangeSub.textContent = '没读到日期列';
      return;
    }
    rangeText.textContent = fmtDate(min) + ' ~ ' + fmtDate(max);
    /* 两家天数可能不一样（一家缺几天）→ 写成区间，不能只报多的那家 */
    var lo = 0, hi = 0, total = 0;
    ['MU', 'KN'].forEach(function (k) {
      var x = audit(k, state.month);
      if (!x.has || x.filled <= 0) return;
      if (!lo || x.filled < lo) lo = x.filled;
      if (x.filled > hi) hi = x.filled;
      total = x.total;
    });
    rangeSub.textContent = state.year + ' 年 ' + state.month + ' 月 · ' +
      (hi ? ((lo === hi ? String(hi) : lo + '～' + hi) + ' / ' + total + ' 天有数') : '这个月还没有数');
  }

  /* ================================================================
     1.5 逐日体检 —— 这个月到底缺了哪几天
     ----------------------------------------------------------------
     四种情况含义不同，必须分开报（用户 2026-10-26 明确要求）：
       缺整行  → 那一天在表里根本没有（如联航 8/14）
       未填    → 行在、日期在，10 个数值格全是空的（如 10/26–10/31）
       半填    → 10 个格子里有的填了有的空着
       全天为 0 → 10 格都填了、全是数字 0 —— 多半是真停场（台风），只提示不拦
     ================================================================ */
  function daysInMonth(year, m) { return new Date(year, m, 0).getDate(); }

  function audit(tag, m) {
    var d = state.data[tag];
    var out = { total: 0, filled: 0, missRow: [], empty: [], partial: [], zeroDay: [], has: false };
    if (!d || !d.perMonth[m]) return out;
    var a = d.perMonth[m];
    out.has = true;
    out.total = daysInMonth(d.year || state.year, m);
    for (var day = 1; day <= out.total; day++) {
      var r = a.day[day];
      if (!r) { out.missRow.push(day); continue; }
      if (r.none >= KEYCOLS.length) out.empty.push(day);
      else if (r.none > 0) out.partial.push(day);
      else if (r.zero) out.zeroDay.push(day);
    }
    out.filled = out.total - out.missRow.length - out.empty.length;
    return out;
  }

  /* 这个月有数的天数（半填也算有数） */
  function filledDays(tag, m) {
    var a = audit(tag, m);
    return a.has ? a.filled : 0;
  }

  /* 1 月到第 m 月累计有数的天数 —— 汇总列含多少天，用它 */
  function cumFilledDays(tag, m) {
    var n = 0;
    for (var i = 1; i <= m; i++) n += filledDays(tag, i);
    return n;
  }

  /* [26,27,28,29,30,31] → "10/26–10/31"；零散的写 "8/9、8/14" */
  function dlist(days, m) {
    var out = [], i = 0;
    while (i < days.length) {
      var j = i;
      while (j + 1 < days.length && days[j + 1] === days[j] + 1) j++;
      if (j - i >= 2) out.push(m + '/' + days[i] + '–' + m + '/' + days[j]);
      else for (var k = i; k <= j; k++) out.push(m + '/' + days[k]);
      i = j + 1;
    }
    var s = out.join('、');
    return s.length > 46 ? s.slice(0, 45) + '…' : s;
  }

  function renderAudit() {
    var box = $('audit'), list = $('auditList');
    if (!box || !list) return;
    if (!state.fileName || !state.month || !hasMonth(state.month)) {
      box.style.display = 'none';
      list.innerHTML = '';
      return;
    }
    var html = '';
    ['MU', 'KN'].forEach(function (tag) {
      if (!state.data[tag]) return;
      var a = audit(tag, state.month);
      var cls = 'ok', notes = [];
      if (a.missRow.length) { cls = 'bad'; notes.push('缺整行 ' + dlist(a.missRow, state.month)); }
      if (a.empty.length) { cls = 'bad'; notes.push('没填 ' + dlist(a.empty, state.month)); }
      if (a.partial.length) { if (cls === 'ok') cls = 'warn'; notes.push('只填了一部分 ' + dlist(a.partial, state.month)); }
      if (a.zeroDay.length) notes.push('全天为 0 ' + dlist(a.zeroDay, state.month));
      if (!notes.length) notes.push('完整');
      html += '<li class="' + cls + '"><b>' + NAMES[tag] + '</b>' +
        '<span class="ad">' + a.filled + ' / ' + a.total + ' 天</span>' +
        '<span class="ai">' + notes.join('<i>·</i>') + '</span></li>';
    });
    list.innerHTML = html;
    box.style.display = html ? '' : 'none';
  }

  function hasMonth(m) {
    /* 「有数据」= 这个月有行，且进出港架次 / 人数不全为 0。
       数据表是全年 365 行铺满的，11–12 月只有日期没有数，不能算「有数据」。 */
    return ['MU', 'KN'].some(function (t) {
      var d = state.data[t];
      var a = d && d.perMonth[m];
      if (!a || !a.days) return false;
      return (a.inAct + a.outAct + a.inPax + a.outPax) > 0;
    });
  }

  /* ================================================================
     2. 预览
     ================================================================ */
  function renderAll() {
    renderRange();
    renderAudit();
    renderPreview();
    updateDownloadState();
  }

  function statOf(tag, m, key) {
    var d = state.data[tag];
    if (!d || !d.perMonth[m]) return null;
    return d.perMonth[m][key];
  }

  function totalOf(tag, upto, key) {
    var s = 0;
    for (var m = 1; m <= upto; m++) {
      var v = statOf(tag, m, key);
      if (v !== null) s += v;
    }
    return s;
  }

  function fmtPct(cur, prev) {
    if (!prev) return '';
    var d = (cur - prev) / prev * 100;
    return (d >= 0 ? '+' : '') + d.toFixed(1) + '%';
  }

  function renderPreview() {
    var m = state.month;
    if (!m || !hasMonth(m)) {
      previewBody.innerHTML = '<div class="empty-tip">' +
        (state.fileName
          ? '这个月在数据表里<b>还没有数</b>（行和日期都在，运量格子空着）。等表更新后重新导入就能选。'
          : '还没导入数据表 —— 先把上面那个 Excel 拖进来。') +
        '</div>';
      return;
    }
    var html = '';
    ['MU', 'KN'].forEach(function (tag) {
      if (!state.data[tag]) return;
      var a = audit(tag, m);
      var cum = cumFilledDays(tag, m);

      /* 天数不对等 → 环比打星号并在表下说明。
         两种都要管：本月没填全、上月没填全。只判上月是不够的 ——
         10 月只有 25 天去比 9 月的 30 天，同样会看出假暴跌。 */
      var pa = m > 1 ? audit(tag, m - 1) : null;
      var curBad = a.filled < a.total;
      var prevBad = !!(pa && pa.has && pa.filled < pa.total);
      var momBad = curBad || prevBad;

      html += '<div class="tbl-title">' + NAMES[tag] + '月报<span>写进第 ' + (m + 2) + ' 列</span></div>';
      html += '<div class="tbl-wrap"><table class="mt">' +
        '<colgroup><col class="c-lab"><col class="c-num"><col class="c-num"><col class="c-mom"></colgroup>' +
        '<thead><tr>' +
        '<th class="h-lab">月报里的行</th>' +
        '<th>' + m + ' 月<span class="th-sub">' + a.filled + '/' + a.total + ' 天</span></th>' +
        '<th>汇总（1–' + m + ' 月）<span class="th-sub">共 ' + cum + ' 天</span></th>' +
        '<th>环比</th>' +
        '</tr></thead><tbody>';
      ITEMS.forEach(function (it) {
        var cur = statOf(tag, m, it.key);
        var prev = m > 1 ? statOf(tag, m - 1, it.key) : null;
        var pct = prev ? fmtPct(cur, prev) : '';
        if (pct && momBad) pct += '<sup>*</sup>';
        html += '<tr>' +
          '<td class="lab">' + it.name + '</td>' +
          '<td class="v">' + (cur === null ? '—' : Math.round(cur).toLocaleString('en-US')) + '</td>' +
          '<td>' + Math.round(totalOf(tag, m, it.key)).toLocaleString('en-US') + '</td>' +
          '<td class="muted">' + (pct || '—') + '</td>' +
          '</tr>';
      });
      html += '<tr class="blank"><td class="lab">' + BLANK_NAMES + '</td>' +
        '<td colspan="3">数据表里没有这几项，Word 里留空，自己填</td></tr>';
      html += '</tbody></table>';
      if (curBad) {
        html += '<p class="tbl-note">* 本月只有 <b>' + a.filled + '</b> 天有数（应 ' + a.total +
          ' 天），月报里的数就少这 ' + (a.total - a.filled) + ' 天；环比也不是同等天数相比，仅供参考。</p>';
      } else if (prevBad) {
        html += '<p class="tbl-note">* 上月（' + (m - 1) + ' 月）只有 <b>' + pa.filled + '</b> 天有数（应 ' +
          pa.total + ' 天），环比不是同等天数相比，仅供参考。</p>';
      }
      html += '</div>';
    });
    previewBody.innerHTML = html;
  }

  function updateDownloadState() {
    var ok = state.month > 0 && hasMonth(state.month) && !!state.data.MU;
    dlMu.disabled = !ok || !state.data.MU;
    dlKn.disabled = !ok || !state.data.KN;
    if (state.month) {
      dlName.innerHTML = '文件名：<b>浙江分公司地面服务部生产经营月报(' + FILE_TAG.MU + ')-' +
        state.year + '年' + state.month + '月.docx</b>　（联航同理）';
    }
  }

  function warn(msg) {
    if (!msg) { warnTip.style.display = 'none'; warnTip.textContent = ''; return; }
    warnTip.style.display = '';
    warnTip.textContent = msg;
  }

  /* ================================================================
     3. 改 docx
     ================================================================ */

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* 单元格换文字：只替换第一个 <w:p>，tcPr / pPr / rPr 全部原样保留 */
  function setCellText(tc, text) {
    var m = tc.match(/<w:p\b[\s\S]*?<\/w:p>/);
    if (!m) return tc;
    var para = m[0];
    var pPrM = para.match(/<w:pPr>[\s\S]*?<\/w:pPr>/);
    var pPr = pPrM ? pPrM[0] : '';
    var rPrM = para.match(/<w:rPr>[\s\S]*?<\/w:rPr>/);
    var rPr = rPrM ? rPrM[0] : '';
    if (!rPr && pPr) {
      var r2 = pPr.match(/<w:rPr>[\s\S]*?<\/w:rPr>/);
      if (r2) rPr = r2[0];
    }
    var run = '<w:r>' + rPr + '<w:t xml:space="preserve">' + esc(text) + '</w:t></w:r>';
    var newPara = '<w:p>' + pPr + run + '</w:p>';
    return tc.slice(0, m.index) + newPara + tc.slice(m.index + para.length);
  }

  function spanOf(tc) {
    var s = tc.match(/<w:gridSpan w:val="(\d+)"/);
    return s ? parseInt(s[1], 10) : 1;
  }

  /* 把一行里的 <w:tc> 按位置切片重建 —— 绝不能用 replace（空单元格 XML 逐字节相同） */
  function rebuildRow(tr, newCells) {
    var re = /<w:tc\b[^>]*>[\s\S]*?<\/w:tc>/g, m, out = '', last = 0, idx = 0;
    while ((m = re.exec(tr))) {
      out += tr.slice(last, m.index) + (newCells[idx] !== undefined ? newCells[idx] : m[0]);
      last = m.index + m[0].length;
      idx++;
    }
    return out + tr.slice(last);
  }

  function fillXml(xml, year, month, perMonth) {
    var i = xml.indexOf('<w:tbl>');
    var j = xml.indexOf('</w:tbl>', i);
    if (i < 0 || j < 0) return xml;                    /* 没有表格就原样返回 */
    j += '</w:tbl>'.length;
    var head = xml.slice(0, i), tbl = xml.slice(i, j), tail = xml.slice(j);

    /* 标题里的年月：只改表格之前的第一处「YYYY年M月」 */
    head = head.replace(/\d{4}\s*年\s*\d{1,2}\s*月/, year + '年' + month + '月');

    var rowRe = /<w:tr\b[\s\S]*?<\/w:tr>/g, rowM;
    var rows = [], last = 0, rowOut = '';
    while ((rowM = rowRe.exec(tbl))) {
      rows.push({ text: rowM[0], start: rowM.index, end: rowM.index + rowM[0].length });
      last = rowM.index + rowM[0].length;
    }
    if (!rows.length) return xml;

    var mcol = month + 2;
    rows.forEach(function (r, ri) {
      var rowNo = ri + 1;
      var cellRe = /<w:tc\b[^>]*>[\s\S]*?<\/w:tc>/g, cm;
      var cells = [], col = 1;
      while ((cm = cellRe.exec(r.text))) {
        cells.push({ text: cm[0], col: col });
        col += spanOf(cm[0]);
      }
      var newCells = cells.map(function (c) { return c.text; });
      ITEMS.forEach(function (it) {
        if (it.row !== rowNo) return;
        var cur = perMonth[month] ? perMonth[month][it.key] : null;
        if (cur === null) return;
        var total = 0;
        for (var m = 1; m <= month; m++) if (perMonth[m]) total += perMonth[m][it.key];
        var prev = month > 1 && perMonth[month - 1] ? perMonth[month - 1][it.key] : null;

        cells.forEach(function (c, ci) {
          if (c.col === mcol) newCells[ci] = setCellText(c.text, String(Math.round(cur)));
          else if (c.col === 15) newCells[ci] = setCellText(c.text, String(Math.round(total)));
          else if (c.col === 17 && prev) newCells[ci] = setCellText(c.text, fmtPct(cur, prev));
        });
      });
      r.newText = rebuildRow(r.text, newCells);
    });

    /* 按位置拼接表格 */
    var outTbl = '';
    last = 0;
    rows.forEach(function (r) {
      outTbl += tbl.slice(last, r.start) + r.newText;
      last = r.end;
    });
    outTbl += tbl.slice(last);

    return head + outTbl + tail;
  }

  /* ---------- 模板：内置 或 用户自己传的（存 localStorage） ---------- */
  function b64ToBuf(b64) {
    var bin = atob(b64), len = bin.length, u8 = new Uint8Array(len);
    for (var i = 0; i < len; i++) u8[i] = bin.charCodeAt(i);
    return u8.buffer;
  }
  function bufToB64(buf) {
    var u8 = new Uint8Array(buf), s = '', CH = 0x8000;
    for (var i = 0; i < u8.length; i += CH) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    }
    return btoa(s);
  }

  async function getTemplate(tag) {
    if (state.tpl[tag]) return state.tpl[tag];
    var saved = null;
    try { saved = localStorage.getItem(LS[tag]); } catch (e) { saved = null; }
    if (saved) {
      var buf = b64ToBuf(saved);
      state.tpl[tag] = buf;
      return buf;
    }
    var res = await fetch('template/' + tag + '.docx');
    if (!res.ok) throw new Error('模板读取失败：' + res.status);
    return await res.arrayBuffer();
  }

  async function buildBlob(tag) {
    var tplBuf = await getTemplate(tag);
    var zip = await JSZip.loadAsync(tplBuf);
    var f = zip.file('word/document.xml');
    if (!f) throw new Error('这个 .docx 里没有 word/document.xml，可能不是 Word 文件');
    var xml = await f.async('string');
    var out = fillXml(xml, state.year, state.month, state.data[tag].perMonth);
    zip.file('word/document.xml', out);
    return await zip.generateAsync({
      type: 'blob',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      compression: 'DEFLATE'
    });
  }

  /* 缺数据时下载前拦一下 —— 不禁止（月中先出一版草稿是正常需求），但要人确认过 */
  function confirmMsg(tag, m) {
    var a = audit(tag, m), parts = [];
    if (a.missRow.length) parts.push('· 缺整行：' + dlist(a.missRow, m));
    if (a.empty.length) parts.push('· 没填：' + dlist(a.empty, m));
    if (a.partial.length) parts.push('· 只填了一部分：' + dlist(a.partial, m));
    if (!parts.length) return '';
    var miss = a.total - a.filled;
    return NAMES[tag] + ' ' + m + ' 月的数据缺 ' + miss + ' 天：\n\n' + parts.join('\n') +
      '\n\n生成的月报会少这几天的数据，汇总和环比都会跟着偏小。仍要下载吗？';
  }

  async function download(tag, btn) {
    var msg = confirmMsg(tag, state.month);
    if (msg && !window.confirm(msg)) return;

    var oldHtml = btn.innerHTML;          /* ⚠️ 存 innerHTML：按钮里有 SVG，textContent 会把图标抹掉 */
    btn.disabled = true;
    btn.textContent = '生成中…';
    try {
      var blob = await buildBlob(tag);
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = '浙江分公司地面服务部生产经营月报(' + FILE_TAG[tag] + ')-' +
        state.year + '年' + state.month + '月.docx';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
    } catch (e) {
      warn('生成失败：' + (e && e.message ? e.message : e));
    } finally {
      btn.innerHTML = oldHtml;
      updateDownloadState();
    }
  }

  /* ================================================================
     4. 事件
     ================================================================ */
  pickBtn.addEventListener('click', function (e) { e.stopPropagation(); fileInput.click(); });
  uploadArea.addEventListener('click', function () { fileInput.click(); });
  fileInput.addEventListener('change', function () {
    var f = fileInput.files && fileInput.files[0];
    if (!f) return;
    var rd = new FileReader();
    rd.onload = function (ev) { loadWorkbook(ev.target.result, f.name); };
    rd.readAsArrayBuffer(f);
    fileInput.value = '';
  });

  /* 拖拽 */
  ['dragenter', 'dragover'].forEach(function (t) {
    uploadArea.addEventListener(t, function (e) { e.preventDefault(); uploadArea.classList.add('dragover'); });
  });
  ['dragleave', 'drop'].forEach(function (t) {
    uploadArea.addEventListener(t, function (e) { e.preventDefault(); uploadArea.classList.remove('dragover'); });
  });
  uploadArea.addEventListener('drop', function (e) {
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    var rd = new FileReader();
    rd.onload = function (ev) { loadWorkbook(ev.target.result, f.name); };
    rd.readAsArrayBuffer(f);
  });

  monthSel.addEventListener('change', function () {
    state.month = +monthSel.value;
    renderAll();
  });

  dlMu.addEventListener('click', function () { download('MU', dlMu); });
  dlKn.addEventListener('click', function () { download('KN', dlKn); });

  /* ---------- 自定义模板 ---------- */
  function tplPick(tag) { $(tag === 'MU' ? 'tplMuFile' : 'tplKnFile').click(); }
  $('tplMuPick').addEventListener('click', function () { tplPick('MU'); });
  $('tplKnPick').addEventListener('click', function () { tplPick('KN'); });

  ['MU', 'KN'].forEach(function (tag) {
    $(tag === 'MU' ? 'tplMuFile' : 'tplKnFile').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      if (!f) return;
      var rd = new FileReader();
      rd.onload = function (ev) {
        var buf = ev.target.result;
        state.tpl[tag] = buf;
        try { localStorage.setItem(LS[tag], bufToB64(buf)); } catch (err) {
          warn('模板已用于本次，但浏览器存不下（空间不足），下次要重新选。');
        }
        $(tag === 'MU' ? 'tplMuState' : 'tplKnState').className = 'state';
        $(tag === 'MU' ? 'tplMuState' : 'tplKnState').textContent = '已用你选的：' + f.name;
      };
      rd.readAsArrayBuffer(f);
      e.target.value = '';
    });
  });

  $('tplReset').addEventListener('click', function () {
    ['MU', 'KN'].forEach(function (tag) {
      state.tpl[tag] = null;
      try { localStorage.removeItem(LS[tag]); } catch (e) {}
      var el = $(tag === 'MU' ? 'tplMuState' : 'tplKnState');
      el.className = 'state builtin';
      el.textContent = '内置空白模板';
    });
  });

  /* 启动：把上次存过的模板名字显示出来 */
  ['MU', 'KN'].forEach(function (tag) {
    var saved = null;
    try { saved = localStorage.getItem(LS[tag]); } catch (e) {}
    if (saved) {
      var el = $(tag === 'MU' ? 'tplMuState' : 'tplKnState');
      el.className = 'state';
      el.textContent = '已用上次选的模板（存在本机浏览器里）';
    }
  });

  /* 规则面板开合（与其它工具页一致：切 .open 类） */
  var rulesPanel = $('rulesPanel'), rulesHeader = $('rulesHeader');
  if (rulesPanel && rulesHeader) {
    rulesHeader.addEventListener('click', function () { rulesPanel.classList.toggle('open'); });
  }
})();
