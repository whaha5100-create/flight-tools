/*
 * 航班名单转换核心逻辑（纯前端版）
 * 用 JS 完整复刻 convert_manifest.py：
 *   - 国籍二字码 -> 三字码（含常见错别字修正）
 *   - 性别 1/2 -> M/F
 *   - 证件号 / 日期清洗
 *   - 依据航班号查「航线表 ROUTES」同时得出 入境/出境 与 往来机场 **IATA 三字码**
 *     （MU261/262→MAD、MU751/752→FCO、FM883/884→BKK；单号出境、双号入境），
 *     未命中航班回退温州判定
 *   - 生成海关上传模板 15 列表
 * 该函数为纯函数，浏览器与 Node 共用，保证校验与线上逻辑一致。
 */
(function (global) {
  'use strict';

  // ── 二字转三字国籍代码 ──────────────────────────────────────────────
  var TWO_TO_THREE = {
    CN: 'CHN', CH: 'CHN',
    ES: 'ESP', IT: 'ITA', DE: 'DEU', GE: 'DEU', FR: 'FRA',
    GB: 'GBR', UK: 'GBR', PT: 'PRT', NL: 'NLD', BE: 'BEL',
    AT: 'AUT', SE: 'SWE', NO: 'NOR', DK: 'DNK', FI: 'FIN',
    PL: 'POL', CZ: 'CZE', HU: 'HUN', RO: 'ROU', GR: 'GRC',
    TR: 'TUR', UA: 'UKR', RU: 'RUS', HR: 'HRV', RS: 'SRB',
    SK: 'SVK', SI: 'SVN', BG: 'BGR', LT: 'LTU', LV: 'LVA',
    EE: 'EST', IE: 'IRL', IL: 'ISR', JP: 'JPN', KR: 'KOR',
    HK: 'HKG', TW: 'TWN', MO: 'MAC', SG: 'SGP', MY: 'MYS',
    TH: 'THA', ID: 'IDN', PH: 'PHL', VN: 'VNM', IN: 'IND',
    PK: 'PAK', BD: 'BGD', LK: 'LKA', MM: 'MMR', KH: 'KHM',
    LA: 'LAO', MN: 'MNG', NP: 'NPL', KZ: 'KAZ', UZ: 'UZB',
    IR: 'IRN', SA: 'SAU', AE: 'ARE', US: 'USA', CA: 'CAN',
    MX: 'MEX', BR: 'BRA', AR: 'ARG', CL: 'CHL', AU: 'AUS',
    NZ: 'NZL', ZA: 'ZAF', EG: 'EGY', NG: 'NGA'
  };

  // 常见错别字修正（优先于二字映射）
  var TYPO_FIX = {
    CH: 'CHN', CN: 'CHN', HN: 'CHN',
    IT: 'ITA', IA: 'ITA', TA: 'ITA',
    ES: 'ESP', EP: 'ESP', SP: 'ESP',
    DE: 'DEU', GE: 'DEU', EU: 'DEU', DU: 'DEU',
    FR: 'FRA', FA: 'FRA', RA: 'FRA',
    GB: 'GBR', UK: 'GBR', GR: 'GBR', BR: 'GBR',
    PT: 'PRT', PR: 'PRT', RT: 'PRT',
    IL: 'ISR', IS: 'ISR', SR: 'ISR',
    RU: 'RUS', RS: 'RUS',
    US: 'USA'
  };

  var PORT = '050-温州机场';
  var WNZ = { WNZ: true, '温州': true };

  function strip_junk(s) {
    s = String(s).trim();
    s = s.replace(/^[-/,]+/, '').trim();
    return s;
  }

  function clean_str(val) {
    if (val === null || val === undefined) return '';
    var s = String(val).trim();
    s = strip_junk(s);
    s = s.replace(/^\d+/, '').trim();
    return s;
  }

  function clean_id(val) {
    if (val === null || val === undefined) return '';
    var s = String(val).trim();
    s = s.replace(/^[-/,\s]+/, '');
    var parts = s.split('/');
    var result = parts[0].trim();
    result = result.replace(/^[-,\s]+/, '').trim();
    return result;
  }

  function clean_nationality(val) {
    if (val === null || val === undefined) return '';
    var s = String(val).trim();
    s = strip_junk(s);
    var parts = String(s).split(/[/,]/).map(function (p) {
      return p.trim();
    }).filter(function (p) {
      return p && p !== '-';
    });
    if (!parts.length) return '';
    var code = parts[0].toUpperCase();
    if (TYPO_FIX[code]) return TYPO_FIX[code];
    if (code.length === 2 && TWO_TO_THREE[code]) return TWO_TO_THREE[code];
    if (code.length === 3) return code;
    return code;
  }

  function clean_gender(val) {
    if (val === null || val === undefined) return '';
    var s = String(val).trim();
    s = strip_junk(s);
    var parts = String(s).split(/[/,]/).map(function (p) {
      return p.trim();
    }).filter(function (p) {
      return p && p !== '-';
    });
    if (!parts.length) return '';
    var g = parts[0].toUpperCase();
    if (g === '1') g = 'M';
    else if (g === '2') g = 'F';
    return (g === 'M' || g === 'F') ? g : '';
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function clean_date(val) {
    if (val === null || val === undefined) return '';
    if (val instanceof Date && !isNaN(val.getTime())) {
      return val.getFullYear() + '-' + pad2(val.getMonth() + 1) + '-' + pad2(val.getDate());
    }
    var s = String(val).trim();
    s = strip_junk(s);
    var commaParts = s.split(',').map(function (p) { return p.trim(); })
      .filter(function (p) { return p && p !== '-'; });
    s = commaParts[0] || s;
    s = s.replace(/^[-/]+/, '').trim();

    var m;
    // %Y-%m-%d
    if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/)) &&
        +m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1 && +m[3] <= 31) {
      return m[1] + '-' + m[2] + '-' + m[3];
    }
    // %Y/%m/%d
    if ((m = s.match(/^(\d{4})\/(\d{2})\/(\d{2})$/)) &&
        +m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1 && +m[3] <= 31) {
      return m[1] + '-' + m[2] + '-' + m[3];
    }
    // %d/%m/%Y  (day/month/year)
    if ((m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/)) &&
        +m[1] >= 1 && +m[1] <= 31 && +m[2] >= 1 && +m[2] <= 12) {
      return m[3] + '-' + m[2] + '-' + m[1];
    }
    // %m/%d/%Y  (month/day/year)
    if ((m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/)) &&
        +m[1] >= 1 && +m[1] <= 12 && +m[2] >= 1 && +m[2] <= 31) {
      return m[3] + '-' + m[1] + '-' + m[2];
    }
    // %d-%m-%Y
    if ((m = s.match(/^(\d{2})-(\d{2})-(\d{4})$/)) &&
        +m[1] >= 1 && +m[1] <= 31 && +m[2] >= 1 && +m[2] <= 12) {
      return m[3] + '-' + m[2] + '-' + m[1];
    }
    return s;
  }

  function clean_name(val) { return clean_str(val); }

  function get_counterpart_airport(dep, dest) {
    var depUp = String(dep).toUpperCase().trim();
    var destUp = String(dest).toUpperCase().trim();
    if (WNZ[destUp]) return dep;   // 入境，对方是起飞地
    return dest;                   // 出境，对方是目的地
  }

  // ── 航线表（用户规则）──────────────────────────────────────────────
  // 一个航班号同时决定「出入境方向」和「往来机场代码」，所以合成一张表，新增航线只加一行。
  // 🔥 往来机场必须输出 **IATA 三字码（英文）**，不能是中文城市名 ——
  //    海关模板第 11 列叫「*往来机场代码」。2026-10-08 用户报错：
  //    「往来机场要的是英文，MAD 或者 FCO、BKK」（原实现输出「马德里 / 罗马」）。
  // 🔥 新增航线时**方向也要一起给**：源文件没有「起飞地/目的地」列（见下），
  //    回退判定拿不到东西 → 回程航班会被一律判成「出境」。
  // 约定：单号 = 出境（温州→外站），双号 = 入境（外站→温州）。
  var ROUTES = [
    { carrier: 'MU', out: '261', inb: '262', code: 'MAD' },  // 温州 ⇄ 马德里
    { carrier: 'MU', out: '751', inb: '752', code: 'FCO' },  // 温州 ⇄ 罗马
    { carrier: 'FM', out: '883', inb: '884', code: 'BKK' }   // 温州 ⇄ 曼谷
  ];

  // 命中返回 { code, direction }，未命中返回 null（交给调用方回退温州判定）
  function matchRoute(carrier, flightNum) {
    var full = (carrier + ' ' + flightNum).toUpperCase().replace(/\s+/g, '');
    var num = (full.match(/(\d+)/) || [])[1] || '';
    var car = String(carrier === null || carrier === undefined ? '' : carrier)
      .toUpperCase().replace(/[^A-Z]/g, '');
    for (var i = 0; i < ROUTES.length; i++) {
      var r = ROUTES[i];
      // 源文件给了承运人就必须对得上（避免别的航司的同号航班被误判）；
      // 承运人缺失/是中文时退回「只按航班号」—— 与老行为一致。
      if (car && car.indexOf(r.carrier) < 0) continue;
      var isOut = (num === r.out) || full.indexOf(r.carrier + r.out) >= 0;
      var isIn = (num === r.inb) || full.indexOf(r.carrier + r.inb) >= 0;
      if (isOut || isIn) {
        return { code: r.code, direction: isOut ? '出境' : '入境' };
      }
    }
    return null;
  }

  function getDirectionByFlight(carrier, flightNum) {
    var hit = matchRoute(carrier, flightNum);
    return hit ? hit.direction : null;
  }

  function getCounterpartByFlight(carrier, flightNum) {
    var hit = matchRoute(carrier, flightNum);
    return hit ? hit.code : null;
  }

  // 海关模板 15 列表头（与 convert_manifest.py 完全一致）
  var TITLE_HEADERS = [
    '*序号', '*上报口岸\n（例：009-杭州）', '*航班号',
    '*航班日期\n(例：2023-01-01)', '*出入类型\n(例：入境/出境)',
    '*姓名\n(英文字母大写)', '*性别代码\n1-男、2-女\nM-男、F-女',
    '*出生日期\n(例：1991-01-01)', '*国籍代码\n(例：CHN)',
    '*出入境证件号码', '*往来机场代码',
    '手机号', '初始/最终抵离地机场\n（例：YOW-渥太华机场）',
    '订票号', '特殊旅客标记\n(如婴儿、无国籍人士等)'
  ];

  var COL_WIDTHS = [6, 18, 10, 14, 10, 24, 10, 14, 10, 16, 12, 12, 24, 12, 20];

  function convertManifest(rawRows) {
    if (!rawRows || !rawRows.length) {
      return { ok: false, error: '文件为空' };
    }

    var header = rawRows[0];
    var col = {};
    header.forEach(function (h, i) {
      if (h !== null && h !== undefined && String(h).trim() !== '') {
        col[String(h).trim()] = i;
      }
    });

    var idx = {
      '航班日期': col['航班日期'],
      '实际承运人': col['实际承运人'],
      '实际航班号': col['实际航班号'],
      '起飞地': col['起飞地'],
      '目的地': col['目的地'],
      '名称': col['名称'],
      '性别': col['性别'],
      '生日': col['生日'],
      '国籍': col['国籍'],
      '证件号码': col['证件号码'],
      'pnr号': col['pnr号']
    };

    function cell(r, key) {
      var i = idx[key];
      if (i === null || i === undefined) return null;
      return (i < r.length) ? r[i] : null;
    }

    var data_rows = rawRows.slice(1).filter(function (r) {
      return r[0] !== null && r[0] !== undefined && String(r[0]).trim() !== '';
    });

    if (!data_rows.length) {
      return { ok: false, error: '没有数据行' };
    }

    var first = data_rows[0];
    var carrier = idx['实际承运人'] != null ? String(first[idx['实际承运人']]).trim() : '';
    var flight_num = idx['实际航班号'] != null ? String(first[idx['实际航班号']]).trim() : '';
    var flight_code = carrier + flight_num;
    var flight_date = idx['航班日期'] != null ? clean_date(first[idx['航班日期']]) : '';
    var dest = idx['目的地'] != null ? String(first[idx['目的地']]).trim() : '';
    var dep = idx['起飞地'] != null ? String(first[idx['起飞地']]).trim() : '';
    var direction = getDirectionByFlight(carrier, flight_num);
    if (!direction) { direction = WNZ[String(dest).toUpperCase().trim()] ? '入境' : '出境'; }
    var counterpart = getCounterpartByFlight(carrier, flight_num);
    if (!counterpart) { counterpart = get_counterpart_airport(dep, dest); }

    var outRows = [];
    outRows.push(['航班订票数据上传模板'].concat(new Array(14).fill(null)));
    outRows.push(TITLE_HEADERS.slice());

    var seq = 1;
    var warnings = [];
    var skipped = [];

    data_rows.forEach(function (row) {
      var name = clean_name(cell(row, '名称'));
      var gender = clean_gender(cell(row, '性别'));
      var dob = clean_date(cell(row, '生日'));
      var nat = clean_nationality(cell(row, '国籍'));
      var doc_id = clean_id(cell(row, '证件号码'));

      if (nat && nat.length !== 3) {
        warnings.push('第' + seq + '行 ' + (name || '（无姓名）') + ': 国籍代码异常 [' + nat + ']，请手动核查');
      }

      var missing = [];
      if (!name) missing.push('姓名');
      if (!doc_id) missing.push('证件号');
      if (!nat) missing.push('国籍');
      if (!gender) missing.push('性别');
      if (!dob) missing.push('生日');

      if (missing.length) {
        skipped.push((name || '（无姓名）') + ': 缺少 ' + missing.join('、'));
        return;
      }

      outRows.push([
        seq, PORT, flight_code, flight_date, direction,
        name, gender, dob, nat, doc_id, counterpart,
        null, null, null, null
      ]);
      seq++;
    });

    return {
      ok: true,
      outRows: outRows,
      warnings: warnings,
      skipped: skipped,
      meta: {
        flight_code: flight_code,
        flight_date: flight_date,
        dep: dep,
        dest: dest,
        direction: direction,
        counterpart: counterpart,
        passengers: seq - 1
      }
    };
  }

  var api = { convertManifest: convertManifest, COL_WIDTHS: COL_WIDTHS, PORT: PORT };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.convertManifest = convertManifest;
    global.MANIFEST_META = api;
  }
})(typeof window !== 'undefined' ? window : this);
