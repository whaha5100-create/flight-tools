/*
 * 航班名单转换核心逻辑（纯前端版）
 * 用 JS 完整复刻 convert_manifest.py：
 *   - 国籍解析：以海关模板「国籍地区代码」305 条字典为唯一依据
 *     （ISO 二字码 / 中文名 / 业务别名 / 换位手误）；**认不出来就删整行**
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

  // ── 国籍代码字典 ────────────────────────────────────────────────────
  // 🔥 2026-10-23 重做：以前这里是**手写的 70 条**二字映射（TWO_TO_THREE），
  //    缺 PE（秘鲁）、CO、VE、EC… 一大片国家；而且「长度=3 就原样放行」「兜底也
  //    原样返回」，所以 PE 这种会带着错误代码一路写进导出文件，海关直接退单。
  //    现在改成用**海关模板第二个 sheet「国籍地区代码」的 305 条全表**当唯一依据，
  //    数据由 .workbuddy-ai/tools/gen-nat-dict.py 从模板生成 —— 海关换版重跑即可。
  //    ⚠️ 别在这里手写映射；要加别名去 gen-nat-dict.py 的 NAT_ALIAS。
  function parsePairs(s) {
    var out = {};
    String(s).split(' ').forEach(function (kv) {
      if (!kv) return;
      var i = kv.indexOf('=');
      if (i > 0) out[kv.slice(0, i)] = kv.slice(i + 1);
    });
    return out;
  }

  // >>> NAT-DATA-BEGIN（由 .workbuddy-ai/tools/gen-nat-dict.py 生成，别手改）
  // 海关模板 Sheet2「国籍地区代码」全表，顺序与 names 一一对应。
  var NAT_CODES = (
    'ABW AFG AGO AIA ALA ALB AND ANT ARE ARG ARM ASM ATA ATF ATG AUN ' +
    'AUS AUT AZE BDI BEL BEN BES BFA BGD BGR BHR BHS BIH BLM BLR BLZ ' +
    'BMU BOL BRA BRB BRN BTN BVT BWA CAF CAN CB CCK CE CHE CHL CHN ' +
    'CIV CMR COD COG COK COL COM CPV CQ CRI CSK CT CUB CUW CXR CYM ' +
    'CYP CZE DDR DEU DJI DMA DNK DOM DY DZA ECU EGY ERI ESH ESP EST ' +
    'ETH EUE FIN FJI FLK FRA FRO FSM GAB GBD GBN GBO GBP GBR GBS GEO ' +
    'GGY GHA GHQ GIB GIN GLP GMB GNB GNQ GRC GRD GRL GTM GUF GUM GUY ' +
    'HB HKG HMD HND HRV HTI HUN IDN IMN IND IOT IRL IRN IRQ ISL ISR ' +
    'ITA JAM JEY JI JOR JPN JTN KAZ KEN KGZ KHM KIR KNA KOR KWT LAO ' +
    'LBN LBR LBY LCA LIE LKA LSO LTU LUX LVA MAC MAF MAR MCO MDA MDG ' +
    'MDV ME MEX MHL MID MKD MLB MLI MLT MMR MNE MNG MNP MOZ MRT MSR ' +
    'MTQ MUS MWI MYS MYT NAM NCL NER NFK NGA NIC NIU NLD NN NOR NPL ' +
    'NQ NRU NTZ NZL OMN PAK PAN PCI PCN PER PHL PLW PNG POL PRI PRK ' +
    'PRT PRY PSE PST PUS PYF PZ QAT REU ROM ROU RUS RWA SAU SDN SEN ' +
    'SGP SGS SHN SJM SLB SLE SLV SMR SOM SP SPM SQ SRB SS SSD STP ' +
    'SUN SUR SVK SVN SWE SWZ SX SXM SYC SYR TCA TCD TGO THA TJK TKL ' +
    'TKM TLS TMP TON TTO TUN TUR TUV TWN TX TZA UGA UKA UKR UMI UN ' +
    'UNA UNK UNO URY USA UZB VAT VCT VEN VGB VIR VNM VUT WAK WLF WSM ' +
    'XBA XCC XCE XCO XDC XEC XIM XOM XPO YEM YKS YMD YUG ZAF ZAR ZMB ' +
    'ZWE'
  ).split(' ');
  // 中文名，用 | 分隔，与 NAT_CODES 同序（省掉 305 组引号键值，体积小一半）
  var NAT_NAMES = (
    '阿鲁巴岛|阿富汗|安哥拉|安圭拉|奥兰群岛|阿尔巴尼亚|安道尔|荷属安的列斯|' +
    '阿联酋|阿根廷|亚美尼亚|美属萨摩亚|南极洲|法属南领地|安提瓜和巴布达|联合国|' +
    '澳大利亚|奥地利|阿塞拜疆|布隆迪|比利时|贝宁|博内尔岛、圣尤斯特歇斯岛和萨巴岛|布基纳法索|' +
    '孟加拉国|保加利亚|巴林|巴哈马|波黑|圣巴泰勒米岛|白俄罗斯|伯利兹|' +
    '百慕大|玻利维亚|巴西|巴巴多斯|文莱|不丹|布维岛|博茨瓦纳|' +
    '中非|加拿大|加那利群岛|科科斯（基灵）群岛|塞卜泰（休达）|瑞士|智利|中国|' +
    '科特迪瓦|喀麦隆|刚果（金）|刚果（布）|库克群岛|哥伦比亚|科摩罗|佛得角|' +
    '库腊索岛|哥斯达黎加|捷克斯洛伐克|坎顿和恩德贝里群岛|古巴|库拉索|圣诞岛|开曼群岛|' +
    '塞浦路斯|捷克|民主德国|德国|吉布提|多米尼克|丹麦|多米尼加|' +
    '达荷美|阿尔及利亚|厄瓜多尔|埃及|厄立特里亚|西撒哈拉|西班牙|爱沙尼亚|' +
    '埃塞俄比亚|欧盟|芬兰|斐济|福克兰群岛（马尔维纳斯）|法国|法罗群岛|密克罗尼西亚联邦|' +
    '加蓬|英国（属地公民）|英国（国民（海外））|英国（海外公民）|英国（被保护人）|英国|英国（臣民）|格鲁吉亚|' +
    '根西岛|加纳|加纳|直布罗陀|几内亚|瓜德罗普|冈比亚|几内亚比绍|' +
    '赤道几内亚|希腊|格林纳达|格陵兰|危地马拉|法属圭亚那|关岛|圭亚那|' +
    '豪兰和贝克群岛(大洋洲)|中国香港|赫德岛和麦克唐纳群岛|洪都拉斯|克罗地亚|海地|匈牙利|印度尼西亚|' +
    '马恩岛|印度|英属印度洋领地|爱尔兰|伊朗|伊拉克|冰岛|以色列|' +
    '意大利|牙买加|泽西|贾维斯岛(大洋洲)|约旦|日本|约翰斯顿岛|哈萨克斯坦|' +
    '肯尼亚|吉尔吉斯斯坦|柬埔寨|基里巴斯|圣基茨和尼维斯|韩国|科威特|老挝|' +
    '黎巴嫩|利比里亚|利比亚|圣卢西亚|列支敦士登|斯里兰卡|莱索托|立陶宛|' +
    '卢森堡|拉脱维亚|中国澳门|圣马丁岛（法属）|摩洛哥|摩纳哥|摩尔多瓦|马达加斯加|' +
    '马尔代夫|梅利利亚|墨西哥|马绍尔群岛|中途岛|北马其顿|公海|马里|' +
    '马耳他|缅甸|黑山|蒙古|北马里亚纳群岛|莫桑比克|毛里塔尼亚|蒙特塞拉特|' +
    '马提尼克|毛里求斯|马拉维|马来西亚|马约特|纳米比亚|新喀里多尼亚|尼日尔|' +
    '诺福克岛|尼日利亚|尼加拉瓜|纽埃|荷兰|无国籍|挪威|尼泊尔|' +
    '毛德地|瑙鲁|中立区|新西兰|阿曼|巴基斯坦|巴拿马|太平洋群岛|' +
    '皮特凯恩|秘鲁|菲律宾|帕劳|巴布亚新几内亚|波兰|波多黎各|朝鲜|' +
    '葡萄牙|巴拉圭|巴勒斯坦|巴勒斯坦|美属太平洋群岛|法属波利尼西亚|巴拿马运河带|卡塔尔|' +
    '留尼汪岛|罗马尼亚|罗马尼亚|俄罗斯|卢旺达|沙特|苏丹|塞内加尔|' +
    '新加坡|南乔治亚和南桑威奇群岛|圣赫勒拿岛、阿森松岛和特里斯坦达库尼亚群岛|斯瓦尔巴和扬马延群岛|所罗门群岛|塞拉利昂|萨尔瓦多|圣马力诺|' +
    '索马里|萨巴|圣皮埃尔和密克隆|圣马丁岛|塞尔维亚|塞班|南苏丹|圣多美和普林西比|' +
    '苏联|苏里南|斯洛伐克|斯洛文尼亚|瑞典|斯威士兰|锡金|圣马丁岛（荷属）|' +
    '塞舌尔|叙利亚|特克斯和凯科斯群岛|乍得|多哥|泰国|塔吉克斯坦|托克劳群岛|' +
    '土库曼斯坦|东帝汶|东帝汶|汤加|特立尼达和多巴哥|突尼斯|土耳其|图瓦卢|' +
    '中国台湾|塔希提|坦桑尼亚|乌干达|乌克兰|乌克兰|美国本土外小岛屿|联合国|' +
    '联合国|联合国|联合国|乌拉圭|美国|乌兹别克斯坦|梵蒂冈|圣文森特和格林纳丁斯|' +
    '委内瑞拉|维尔京群岛（英属）|维尔京群岛（美属）|越南|瓦努阿图|威克岛|瓦利斯和富图纳群岛|萨摩亚|' +
    '非洲开发银行(ADB)|加勒比共同体非洲共同市场(CARICOM)|欧洲理事会|东部和南部非洲共同市场(COMESA)|南部非洲发展共同体|西非国家经济共同体(ECOWAS)|非洲进出口银行(AFREXIM)|马耳他最高军教团或其一名使者|' +
    '国际刑事警察组织(INTERPOL)|也门|科索沃|也门民主人民共和国|南斯拉夫|南非|扎伊尔|赞比亚|' +
    '津巴布韦'
  ).split('|');
  // ISO 3166-1 二字母 -> 三字母（只保留字典里存在的）
  var ALPHA2 = parsePairs(
    'AD=AND AE=ARE AF=AFG AG=ATG AI=AIA AL=ALB AM=ARM AO=AGO AQ=ATA AR=ARG ' +
    'AS=ASM AT=AUT AU=AUS AW=ABW AX=ALA AZ=AZE BA=BIH BB=BRB BD=BGD BE=BEL ' +
    'BF=BFA BG=BGR BH=BHR BI=BDI BJ=BEN BL=BLM BM=BMU BN=BRN BO=BOL BQ=BES ' +
    'BR=BRA BS=BHS BT=BTN BV=BVT BW=BWA BY=BLR BZ=BLZ CA=CAN CC=CCK CD=COD ' +
    'CF=CAF CG=COG CH=CHE CI=CIV CK=COK CL=CHL CM=CMR CN=CHN CO=COL CR=CRI ' +
    'CU=CUB CV=CPV CW=CUW CX=CXR CY=CYP CZ=CZE DE=DEU DJ=DJI DK=DNK DM=DMA ' +
    'DO=DOM DZ=DZA EC=ECU EE=EST EG=EGY EH=ESH ER=ERI ES=ESP ET=ETH FI=FIN ' +
    'FJ=FJI FK=FLK FM=FSM FO=FRO FR=FRA GA=GAB GB=GBR GD=GRD GE=GEO GF=GUF ' +
    'GG=GGY GH=GHA GI=GIB GL=GRL GM=GMB GN=GIN GP=GLP GQ=GNQ GR=GRC GS=SGS ' +
    'GT=GTM GU=GUM GW=GNB GY=GUY HK=HKG HM=HMD HN=HND HR=HRV HT=HTI HU=HUN ' +
    'ID=IDN IE=IRL IL=ISR IM=IMN IN=IND IO=IOT IQ=IRQ IR=IRN IS=ISL IT=ITA ' +
    'JE=JEY JM=JAM JO=JOR JP=JPN KE=KEN KG=KGZ KH=KHM KI=KIR KM=COM KN=KNA ' +
    'KP=PRK KR=KOR KW=KWT KY=CYM KZ=KAZ LA=LAO LB=LBN LC=LCA LI=LIE LK=LKA ' +
    'LR=LBR LS=LSO LT=LTU LU=LUX LV=LVA LY=LBY MA=MAR MC=MCO MD=MDA ME=MNE ' +
    'MF=MAF MG=MDG MH=MHL MK=MKD ML=MLI MM=MMR MN=MNG MO=MAC MP=MNP MQ=MTQ ' +
    'MR=MRT MS=MSR MT=MLT MU=MUS MV=MDV MW=MWI MX=MEX MY=MYS MZ=MOZ NA=NAM ' +
    'NC=NCL NE=NER NF=NFK NG=NGA NI=NIC NL=NLD NO=NOR NP=NPL NR=NRU NU=NIU ' +
    'NZ=NZL OM=OMN PA=PAN PE=PER PF=PYF PG=PNG PH=PHL PK=PAK PL=POL PM=SPM ' +
    'PN=PCN PR=PRI PS=PSE PT=PRT PW=PLW PY=PRY QA=QAT RE=REU RO=ROU RS=SRB ' +
    'RU=RUS RW=RWA SA=SAU SB=SLB SC=SYC SD=SDN SE=SWE SG=SGP SH=SHN SI=SVN ' +
    'SJ=SJM SK=SVK SL=SLE SM=SMR SN=SEN SO=SOM SR=SUR SS=SSD ST=STP SV=SLV ' +
    'SX=SXM SY=SYR SZ=SWZ TC=TCA TD=TCD TF=ATF TG=TGO TH=THA TJ=TJK TK=TKL ' +
    'TL=TLS TM=TKM TN=TUN TO=TON TR=TUR TT=TTO TV=TUV TW=TWN TZ=TZA UA=UKR ' +
    'UG=UGA UM=UMI US=USA UY=URY UZ=UZB VA=VAT VC=VCT VE=VEN VG=VGB VI=VIR ' +
    'VN=VNM VU=VUT WF=WLF WS=WSM YE=YEM YT=MYT ZA=ZAF ZM=ZMB ZW=ZWE'
  );
  // 非 ISO 的常见错拼 / 业务约定（见 gen-nat-dict.py 文件头）
  var NAT_ALIAS = parsePairs(
    'CH=CHN DU=DEU EP=ESP FA=FRA IA=ITA RA=FRA RT=PRT SP=ESP ' +
    'TA=ITA UK=GBR'
  );
  // <<< NAT-DATA-END

  // 三字母集合 + 中文名索引（NAT_CODES / NAT_NAMES 同序）
  var NAT_SET = {};
  var NAT_MODERN = {};                 // 现役 ISO 三字母（= ALPHA2 的所有值）
  for (var _k in ALPHA2) {
    if (Object.prototype.hasOwnProperty.call(ALPHA2, _k)) NAT_MODERN[ALPHA2[_k]] = true;
  }
  for (var _n = 0; _n < NAT_CODES.length; _n++) NAT_SET[NAT_CODES[_n]] = true;

  // 🔥 中文名有重名（字典里「罗马尼亚」同时有 ROM 旧码和 ROU 现码、「东帝汶」TMP/TLS、
  //    「加纳」GHQ/GHA…）。分两轮建索引：先放现役 ISO 码，再用历史码补空位。
  var NAT_BY_NAME = {};
  for (var _pass = 0; _pass < 2; _pass++) {
    for (var _m = 0; _m < NAT_CODES.length; _m++) {
      var _c = NAT_CODES[_m], _nm = NAT_NAMES[_m];
      if (!_nm) continue;
      if ((_pass === 0) !== !!NAT_MODERN[_c]) continue;
      if (!NAT_BY_NAME[_nm]) NAT_BY_NAME[_nm] = _c;
    }
  }
  // 「联合国」在字典里有 AUN/UN/UNA/UNK/UNO 五个，按顺序会先命中 AUN，这里指定 UN。
  NAT_BY_NAME['联合国'] = 'UN';

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

  // ── 国籍解析（2026-10-23 重做）─────────────────────────────────────
  // 就三件事，别再往上加：
  //   1. 业务别名 / 非 ISO 错拼（NAT_ALIAS）      CH→CHN、UK→GBR
  //   2. 三字母：**必须在 305 条字典里**           ESP ✓ / XYZ ✗
  //   3. 二字母：ISO 转三字 → 字典二字码          PE→PER、US→USA
  //   4. 中文名（字典自带）                       秘鲁→PER
  // 都对不上 → code 为空 → **调用方删掉整行**（用户 2026-10-23 定）。
  // 不做模糊匹配：猜错国家比少一个人严重得多。
  function resolveNationality(val) {
    var res = { code: '', raw: '', how: '无法识别' };
    if (val === null || val === undefined) { res.how = '空'; return res; }
    var s = strip_junk(String(val).trim());
    var parts = s.split(/[/,]/).map(function (p) { return p.trim(); })
      .filter(function (p) { return p && p !== '-'; });
    if (!parts.length) { res.how = '空'; return res; }
    var tok = parts[0].toUpperCase();
    res.raw = tok;

    if (NAT_ALIAS[tok] && NAT_SET[NAT_ALIAS[tok]]) {
      res.code = NAT_ALIAS[tok]; res.how = '别名'; return res;
    }
    if (/^[A-Z]{3}$/.test(tok)) {
      if (NAT_SET[tok]) { res.code = tok; res.how = '精确'; }
      return res;
    }
    if (/^[A-Z]{2}$/.test(tok)) {
      if (ALPHA2[tok] && NAT_SET[ALPHA2[tok]]) { res.code = ALPHA2[tok]; res.how = '二字'; return res; }
      if (NAT_SET[tok]) { res.code = tok; res.how = '二字'; }
      return res;
    }
    if (NAT_BY_NAME[tok]) { res.code = NAT_BY_NAME[tok]; res.how = '中文名'; return res; }
    // 「德国人 / 德国籍」这种带后缀的：只去掉末尾的人/籍，再补一个「国」
    // ⚠️ 不能写成 replace(/[人国籍]+$/) —— 「国」也是国名的一部分，会把「德国人」削成「德」
    var t1 = tok.replace(/[人籍]+$/, '');
    var tail = /[\u4e00-\u9fa5]$/.test(tok) ? tok + '国' : '';
    var t2 = t1 !== tok && /[\u4e00-\u9fa5]$/.test(t1) ? t1 + '国' : '';
    if (t1 !== tok && NAT_BY_NAME[t1]) { res.code = NAT_BY_NAME[t1]; res.how = '中文名'; return res; }
    if (tail && NAT_BY_NAME[tail]) { res.code = NAT_BY_NAME[tail]; res.how = '中文名'; return res; }
    if (t2 && NAT_BY_NAME[t2]) { res.code = NAT_BY_NAME[t2]; res.how = '中文名'; return res; }
    return res;
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
    var skipped = [];

    data_rows.forEach(function (row) {
      var name = clean_name(cell(row, '名称'));
      var gender = clean_gender(cell(row, '性别'));
      var dob = clean_date(cell(row, '生日'));
      var natRes = resolveNationality(cell(row, '国籍'));
      var nat = natRes.code;
      var doc_id = clean_id(cell(row, '证件号码'));

      var missing = [];
      if (!name) missing.push('姓名');
      if (!doc_id) missing.push('证件号');
      if (!nat && !natRes.raw) missing.push('国籍');   // 压根没填
      if (!gender) missing.push('性别');
      if (!dob) missing.push('生日');

      if (missing.length) {
        skipped.push((name || '（无姓名）') + ': 缺少 ' + missing.join('、'));
        return;
      }

      // 🔥 填了国籍但认不出来 → **整行删掉**（2026-10-23 用户拍板）。
      //    以前是「只警告、行照样导出」，结果 PE（秘鲁）这种原样写进文件、海关退单。
      //    宁可少一个人让用户补录，也不能把错的代码送上去。
      //    ⚠️ 用户 2026-10-23 追加：「国籍自动修正的都不列，我只要删掉的行」
      //       ⇒ 别名 / 中文名 / 二字转三字这些换算一律静默，不再往 warnings 里写。
      if (!nat) {
        skipped.push((name || '（无姓名）') + ': 国籍 ' + natRes.raw + ' 无法识别');
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

  var api = {
    convertManifest: convertManifest,
    resolveNationality: resolveNationality,   // 单测用（nat-check.js）
    COL_WIDTHS: COL_WIDTHS,
    PORT: PORT
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.convertManifest = convertManifest;
    global.MANIFEST_META = api;
  }
})(typeof window !== 'undefined' ? window : this);
