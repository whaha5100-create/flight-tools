/*!
 * docx-lite.js —— 极简 .docx（WordprocessingML / OOXML）生成器
 * ---------------------------------------------------------------------------
 * 为什么要自己写：
 *   本项目要求「每个工具目录自包含」，且日报要**1:1 复刻官方版式**——页眉（logo+标题+部门）、
 *   页脚（第 X 页 / 联系方式）、真表格（框线/底纹/合并单元格）、红色高亮句子。
 *   现成的 docx 库要么体积大（600KB+），要么对「复刻固定版式」不够直接；
 *   而 OOXML 本身只是几个 XML 文件，打包交给 JSZip（本机已有 3.10.2）即可，零额外依赖。
 *
 * 设计要点：
 *   1) parts(model) 是**纯函数**——只吐 { 路径: 字符串|{base64} }，不碰 JSZip。
 *      这样 Node 里可以直接把 XML 落盘、用 python-docx / lxml 做结构断言（见 validate.py）。
 *   2) zip(model, JSZip) 才做打包，浏览器里 generateAsync({type:'blob'}) 即可下载。
 *   3) 所有 XML 子元素**严格按 OOXML schema 的顺序**输出（顺序错了 Word 会报「内容有问题」）。
 *      顺序见每处 buildXxx 里的注释。
 *
 * 单位：twips(1/20 pt) 用于版面；half-point 用于字号；EMU 用于图片。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DocxLite = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ───────────────────────── 单位换算 ─────────────────────────
  var TWIP_PER_CM = 566.9291338582677;
  var EMU_PER_PX = 9525; // 96dpi：1px = 9525 EMU
  function cm(v) { return Math.round(v * TWIP_PER_CM); }
  function hp(pt) { return Math.round(pt * 2); }        // 磅 → half-point
  function tw(pt) { return Math.round(pt * 20); }       // 磅 → twips（段间距/字距）
  function emu(px) { return Math.round(px * EMU_PER_PX); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ───────────────────────── 命名空间 ─────────────────────────
  var NS_DOC =
    'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" ' +
    'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" ' +
    'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" ' +
    'xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml" ' +
    'mc:Ignorable="w14 w15"';

  var XMLDECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';

  // ───────────────────────── 行内 run ─────────────────────────
  // rPr 子元素顺序（CT_RPr）：rStyle rFonts b bCs i iCs caps smallCaps strike dstrike
  //   outline shadow emboss imprint noProof snapToGrid vanish webHidden color spacing w kern
  //   position sz szCs highlight u effect bdr shd fitText vertAlign rtl cs em lang
  //   eastAsianLayout specVanish oMath
  function buildRPr(o) {
    o = o || {};
    var s = '';
    if (o.font) {
      // eastAsia 必须给，否则中文会掉回默认字体
      s += '<w:rFonts w:ascii="' + esc(o.font) + '" w:hAnsi="' + esc(o.font) +
           '" w:eastAsia="' + esc(o.font) + '" w:cs="' + esc(o.font) + '"/>';
    }
    if (o.b) s += '<w:b/><w:bCs/>';
    if (o.i) s += '<w:i/><w:iCs/>';
    if (o.color) s += '<w:color w:val="' + esc(o.color) + '"/>';
    if (o.spacing != null) s += '<w:spacing w:val="' + Math.round(o.spacing) + '"/>'; // 字距 twips
    if (o.sz) s += '<w:sz w:val="' + hp(o.sz) + '"/><w:szCs w:val="' + hp(o.sz) + '"/>';
    if (o.u) s += '<w:u w:val="' + esc(o.u) + '"/>';
    if (o.vertAlign) s += '<w:vertAlign w:val="' + esc(o.vertAlign) + '"/>';
    return s ? '<w:rPr>' + s + '</w:rPr>' : '';
  }

  // 一个 run。text 里的 \n 拆成 <w:br/>；o.img = {ref,w,h} 时输出内联图片
  function buildRun(o, ctx) {
    if (typeof o === 'string') o = { text: o };
    if (o.img) return buildImage(ctx.imgRef(o.img.ref), o.img.w, o.img.h, ctx.nextId());
    var rpr = buildRPr(o);
    var body = '';
    if (o.br) body += '<w:br/>';
    if (o.tab) body += '<w:tab/>';
    var txt = o.text == null ? '' : String(o.text);
    if (txt) {
      var segs = txt.split('\n');
      for (var i = 0; i < segs.length; i++) {
        if (i) body += '<w:br/>';
        if (segs[i] !== '') body += '<w:t xml:space="preserve">' + esc(segs[i]) + '</w:t>';
      }
    }
    if (!body) body = '<w:t xml:space="preserve"></w:t>';
    return '<w:r>' + rpr + body + '</w:r>';
  }

  // PAGE 域（页脚页码）：begin → instrText → separate → 占位 → end
  function buildField(instr, placeholder) {
    return '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
           '<w:r><w:instrText xml:space="preserve"> ' + esc(instr) + ' </w:instrText></w:r>' +
           '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
           '<w:r><w:t>' + esc(placeholder == null ? '1' : placeholder) + '</w:t></w:r>' +
           '<w:r><w:fldChar w:fldCharType="end"/></w:r>';
  }

  function runsToXml(runs, ctx) {
    if (runs == null) return '';
    if (!Array.isArray(runs)) runs = [runs];
    var out = '';
    for (var i = 0; i < runs.length; i++) {
      var r = runs[i];
      if (r && r.field) out += buildField(r.field, r.text);
      else out += buildRun(r, ctx);
    }
    return out;
  }

  // ───────────────────────── 边框 / 底纹 ─────────────────────────
  function borderXml(tag, spec) {
    if (!spec || spec.val === 'none' || spec.val === 'nil') {
      return '<w:' + tag + ' w:val="none" w:sz="0" w:space="0" w:color="auto"/>';
    }
    return '<w:' + tag + ' w:val="' + (spec.val || 'single') + '"' +
      ' w:sz="' + (spec.sz == null ? 4 : spec.sz) + '"' +
      ' w:space="' + (spec.space == null ? 0 : spec.space) + '"' +
      ' w:color="' + (spec.color || 'auto') + '"/>';
  }
  // CT_TblBorders 顺序：top left bottom right insideH insideV
  function tblBordersXml(b) {
    if (!b) return '';
    return '<w:tblBorders>' +
      borderXml('top', b.top) + borderXml('left', b.left) +
      borderXml('bottom', b.bottom) + borderXml('right', b.right) +
      borderXml('insideH', b.insideH) + borderXml('insideV', b.insideV) +
      '</w:tblBorders>';
  }
  // CT_TcBorders 顺序：top left bottom right insideH insideV tl2br tr2bl
  function tcBordersXml(b) {
    if (!b) return '';
    return '<w:tcBorders>' +
      borderXml('top', b.top) + borderXml('left', b.left) +
      borderXml('bottom', b.bottom) + borderXml('right', b.right) +
      '</w:tcBorders>';
  }
  function shdXml(fill) {
    if (!fill) return '';
    return '<w:shd w:val="clear" w:color="auto" w:fill="' + esc(fill) + '"/>';
  }

  // ───────────────────────── 段落 ─────────────────────────
  // pPr 子元素顺序（CT_PPrBase）：pStyle keepNext keepLines pageBreakBefore framePr
  //   widowControl numPr suppressLineNumbers pBdr shd tabs ... spacing ind ...
  //   jc textDirection textAlignment ... rPr sectPr
  function buildP(o, ctx) {
    o = o || {};
    var p = '';
    if (o.keepNext) p += '<w:keepNext/>';
    if (o.keepLines) p += '<w:keepLines/>';
    if (o.pageBreakBefore) p += '<w:pageBreakBefore/>';
    if (o.pBdr) p += '<w:pBdr>' + borderXml('top', o.pBdr.top) + borderXml('bottom', o.pBdr.bottom) + '</w:pBdr>';
    if (o.shd) p += shdXml(o.shd);
    if (o.tabs && o.tabs.length) {
      p += '<w:tabs>' + o.tabs.map(function (t) {
        return '<w:tab w:val="' + (t.val || 'left') + '" w:pos="' + Math.round(t.pos) + '"/>';
      }).join('') + '</w:tabs>';
    }
    var sp = '';
    if (o.before != null) sp += ' w:before="' + tw(o.before) + '"';
    if (o.after != null) sp += ' w:after="' + tw(o.after) + '"';
    if (o.line != null) sp += ' w:line="' + Math.round(o.line * 240) + '" w:lineRule="auto"';
    if (sp) p += '<w:spacing' + sp + '/>';
    if (o.indentFirst != null) {
      // 首行缩进按「字符」给（w:firstLineChars 单位是 1/100 字符），Word 里最稳
      p += '<w:ind w:firstLineChars="' + Math.round(o.indentFirst * 100) + '"' +
           (o.indentLeft != null ? ' w:left="' + Math.round(o.indentLeft) + '"' : '') + '/>';
    } else if (o.indentLeft != null) {
      p += '<w:ind w:left="' + Math.round(o.indentLeft) + '"/>';
    }
    if (o.align) p += '<w:jc w:val="' + esc(o.align) + '"/>';
    var ppr = p ? '<w:pPr>' + p + '</w:pPr>' : '';
    return '<w:p>' + ppr + runsToXml(o.runs, ctx) + '</w:p>';
  }

  // ───────────────────────── 图片（inline drawing） ─────────────────────────
  function buildImage(ref, wpx, hpx, id) {
    var cx = emu(wpx), cy = emu(hpx);
    return '<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">' +
      '<wp:extent cx="' + cx + '" cy="' + cy + '"/>' +
      '<wp:effectExtent l="0" t="0" r="0" b="0"/>' +
      '<wp:docPr id="' + id + '" name="img' + id + '"/>' +
      '<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>' +
      '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
      '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
      '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
      '<pic:nvPicPr><pic:cNvPr id="' + id + '" name="img' + id + '"/><pic:cNvPicPr/></pic:nvPicPr>' +
      '<pic:blipFill><a:blip r:embed="' + esc(ref) + '"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>' +
      '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm>' +
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>' +
      '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>';
  }

  // ───────────────────────── 表格 ─────────────────────────
  // CT_TblPrBase 顺序：tblStyle tblpPr tblOverlap bidiVisual tblStyleRowBandSize
  //   tblStyleColBandSize tblW jc tblCellSpacing tblInd tblBorders shd tblLayout
  //   tblCellMar tblLook
  function buildTable(t, ctx) {
    var cols = t.cols || [];
    // 支持「相对权重」：给了 width 就用绝对值，否则按权重把可用宽度分掉
    var total = cols.reduce(function (a, c) { return a + (c.weight || 1); }, 0);
    var avail = t.width || ctx.contentWidth;
    var widths = cols.map(function (c) {
      return c.width != null ? Math.round(c.width) : Math.round(avail * (c.weight || 1) / total);
    });
    // 抹平取整误差，保证 tblGrid 之和 == 可用宽度
    var sum = widths.reduce(function (a, b) { return a + b; }, 0);
    if (widths.length && sum !== avail) widths[widths.length - 1] += avail - sum;

    var b = t.borders || {};
    var pr = '';
    pr += '<w:tblW w:w="' + avail + '" w:type="dxa"/>';
    if (t.align) pr += '<w:jc w:val="' + esc(t.align) + '"/>';
    pr += '<w:tblInd w:w="0" w:type="dxa"/>';
    pr += tblBordersXml(b);
    pr += '<w:tblLayout w:type="' + (t.layout || 'fixed') + '"/>';
    var m = t.cellMar || {};
    pr += '<w:tblCellMar>' +
      '<w:top w:w="' + (m.top == null ? 30 : m.top) + '" w:type="dxa"/>' +
      '<w:left w:w="' + (m.left == null ? 60 : m.left) + '" w:type="dxa"/>' +
      '<w:bottom w:w="' + (m.bottom == null ? 30 : m.bottom) + '" w:type="dxa"/>' +
      '<w:right w:w="' + (m.right == null ? 60 : m.right) + '" w:type="dxa"/>' +
      '</w:tblCellMar>';
    pr += '<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/>';

    var grid = '<w:tblGrid>' + widths.map(function (w) { return '<w:gridCol w:w="' + w + '"/>'; }).join('') + '</w:tblGrid>';

    var rowsXml = '';
    (t.rows || []).forEach(function (row) {
      var cells = row.cells || row;
      var trPr = '';
      if (row.height != null) trPr += '<w:trHeight w:val="' + Math.round(row.height) + '" w:hRule="atLeast"/>';
      if (row.header) trPr += '<w:tblHeader/>';
      if (row.cantSplit !== false) trPr += '<w:cantSplit/>';
      trPr += '<w:jc w:val="' + esc(t.align || 'center') + '"/>';
      var tcs = '';
      var colIdx = 0;
      cells.forEach(function (c) {
        if (c == null) c = {};
        var span = c.span || 1;
        var w = 0;
        for (var k = 0; k < span && colIdx + k < widths.length; k++) w += widths[colIdx + k];
        // CT_TcPrBase 顺序：cnfStyle tcW gridSpan hMerge vMerge tcBorders shd noWrap tcMar textDirection tcFitText vAlign
        var cp = '<w:tcW w:w="' + w + '" w:type="dxa"/>';
        if (span > 1) cp += '<w:gridSpan w:val="' + span + '"/>';
        if (c.vMerge) cp += '<w:vMerge w:val="' + esc(c.vMerge) + '"/>';
        if (c.borders) cp += tcBordersXml(c.borders);
        if (c.fill) cp += shdXml(c.fill);
        cp += '<w:vAlign w:val="' + (c.valign || 'center') + '"/>';

        var paraOpts = {
          runs: c.runs != null ? c.runs : (c.text != null ? [{ text: c.text, b: c.b, sz: c.sz, font: c.font, color: c.color }] : []),
          align: c.align || 'center',
          before: c.before == null ? 0.5 : c.before,
          after: c.after == null ? 0.5 : c.after,
          line: c.line,
          keepNext: c.keepNext
        };
        // 单元格内允许多段（c.paras）
        var inner = (c.paras && c.paras.length)
          ? c.paras.map(function (pp) { return buildP(pp, ctx); }).join('')
          : buildP(paraOpts, ctx);
        tcs += '<w:tc><w:tcPr>' + cp + '</w:tcPr>' + inner + '</w:tc>';
        colIdx += span;
      });
      rowsXml += '<w:tr>' + (trPr ? '<w:trPr>' + trPr + '</w:trPr>' : '') + tcs + '</w:tr>';
    });

    return '<w:tbl><w:tblPr>' + pr + '</w:tblPr>' + grid + rowsXml + '</w:tbl>';
  }

  // ───────────────────────── 正文块分发 ─────────────────────────
  function buildBlocks(blocks, ctx) {
    var out = '';
    (blocks || []).forEach(function (blk) {
      if (!blk) return;
      switch (blk.t) {
        case 'p':
          out += buildP(blk, ctx);
          break;
        case 'h':
          out += buildP({
            runs: blk.runs || [{ text: blk.text, b: blk.b !== false, sz: blk.sz || 13, font: blk.font || ctx.headFont }],
            before: blk.before == null ? 8 : blk.before,
            after: blk.after == null ? 3 : blk.after,
            align: blk.align,
            keepNext: true
          }, ctx);
          break;
        case 'img':
          // 图片必须包在 <w:p> 里；直接拼段落，别拿 buildP 去 replace（容易改坏）
          out += '<w:p><w:pPr>' +
            '<w:spacing w:before="' + tw(blk.before == null ? 2 : blk.before) +
            '" w:after="' + tw(blk.after == null ? 2 : blk.after) + '"/>' +
            '<w:jc w:val="' + (blk.align || 'center') + '"/>' +
            '</w:pPr>' +
            buildImage(ctx.imgRef(blk.ref), blk.w, blk.h, ctx.nextId()) +
            '</w:p>';
          break;
        case 'tbl':
          out += buildTable(blk, ctx);
          out += buildP({ after: 0, line: 0.6, runs: [{ sz: 1 }] }); // 表后垫一个极窄段落，避免相邻表粘连
          break;
        case 'pagebreak':
          out += buildP({ runs: [{ br: true }], pageBreakBefore: true });
          break;
        default:
          break;
      }
    });
    return out;
  }

  // ───────────────────────── 固定样板 XML ─────────────────────────
  function contentTypes(hasHeader, hasFooter, hasImage) {
    var s = XMLDECL +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>';
    if (hasImage) s += '<Default Extension="png" ContentType="image/png"/>';
    s += '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
      '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>';
    if (hasHeader) s += '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>';
    if (hasFooter) s += '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>';
    return s + '</Types>';
  }

  function relsXml(items) {
    return XMLDECL +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      items.map(function (it) {
        return '<Relationship Id="' + it.id + '" Type="' + it.type + '" Target="' + it.target + '"' +
          (it.mode ? ' TargetMode="' + it.mode + '"' : '') + '/>';
      }).join('') + '</Relationships>';
  }

  var RT = {
    officeDocument: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
    core: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties',
    app: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties',
    styles: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles',
    header: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/header',
    footer: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer',
    image: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image'
  };

  function stylesXml(model) {
    var f = model.defaultFont || '宋体';
    var sz = hp(model.defaultSize || 10.5);
    return XMLDECL +
      '<w:styles ' + NS_DOC + '>' +
      '<w:docDefaults><w:rPrDefault><w:rPr>' +
      '<w:rFonts w:ascii="' + esc(f) + '" w:hAnsi="' + esc(f) + '" w:eastAsia="' + esc(f) + '" w:cs="' + esc(f) + '"/>' +
      '<w:sz w:val="' + sz + '"/><w:szCs w:val="' + sz + '"/>' +
      '<w:lang w:val="en-US" w:eastAsia="zh-CN" w:bidi="ar-SA"/>' +
      '</w:rPr></w:rPrDefault>' +
      '<w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/><w:jc w:val="both"/></w:pPr></w:pPrDefault>' +
      '</w:docDefaults>' +
      '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
      '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/>' +
      '<w:tblPr><w:tblCellMar>' +
      '<w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/>' +
      '<w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/>' +
      '</w:tblCellMar></w:tblPr></w:style>' +
      '</w:styles>';
  }

  function coreXml(model) {
    var now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    return XMLDECL +
      '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
      'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
      'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
      '<dc:title>' + esc(model.title || '生产情况汇总') + '</dc:title>' +
      '<dc:creator>' + esc(model.creator || '航班工作工具集') + '</dc:creator>' +
      '<cp:lastModifiedBy>' + esc(model.creator || '航班工作工具集') + '</cp:lastModifiedBy>' +
      '<dcterms:created xsi:type="dcterms:W3CDTF">' + now + '</dcterms:created>' +
      '<dcterms:modified xsi:type="dcterms:W3CDTF">' + now + '</dcterms:modified>' +
      '</cp:coreProperties>';
  }

  function appXml(model) {
    return XMLDECL +
      '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ' +
      'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
      '<Application>航班工作工具集 · docx-lite</Application>' +
      '<Company>' + esc(model.company || '中国联合航空 浙江分公司') + '</Company>' +
      '</Properties>';
  }

  // ───────────────────────── 主入口 ─────────────────────────
  /**
   * model = {
   *   page: {w,h,margins:{top,right,bottom,left,header,footer}},   // twips
   *   defaultFont, defaultSize, headFont,
   *   title, creator, company,
   *   images: { 名字: {base64:'...'} 或 {data:Uint8Array} },
   *   header: {blocks:[...]},   footer: {blocks:[...]},   body: [ ... ]
   * }
   * → { 'word/document.xml': '...', ..., 'word/media/xxx.png': {base64:'...'} }
   */
  function parts(model) {
    model = model || {};
    var page = model.page || {};
    var margins = page.margins || {};
    var pgW = page.w || 11906, pgH = page.h || 16838;           // A4
    var mTop = margins.top == null ? cm(2.0) : margins.top;
    var mRight = margins.right == null ? cm(1.5) : margins.right;
    var mBottom = margins.bottom == null ? cm(1.6) : margins.bottom;
    var mLeft = margins.left == null ? cm(1.5) : margins.left;
    var mHead = margins.header == null ? cm(1.0) : margins.header;
    var mFoot = margins.footer == null ? cm(1.0) : margins.footer;
    var contentWidth = pgW - mLeft - mRight;

    var files = {};
    var idSeq = 1;

    // 每个 part 单独收集它用到的图片 → 生成该 part 的 rels
    function makeCtx(imageRelMap) {
      return {
        contentWidth: contentWidth,
        headFont: model.headFont || model.defaultFont || '宋体',
        imgRef: function (name) {
          var rel = imageRelMap[name];
          if (!rel) throw new Error('未注册的图片：' + name);
          return rel;
        },
        nextId: function () { return idSeq++; }
      };
    }

    // ---- 图片登记：收集各 part 引用到的图片，分配 rId ----
    var mediaParts = {};      // name -> part path
    var imgCounter = 0;
    function registerImages(usedNames) {
      var map = {};
      usedNames.forEach(function (n) {
        if (map[n]) return;
        if (!model.images || !model.images[n]) return;
        if (!mediaParts[n]) {
          imgCounter++;
          mediaParts[n] = 'word/media/image' + imgCounter + '.png';
        }
        map[n] = 'rId' + (Object.keys(map).length + 1);
      });
      return map;
    }
    function collectRuns(runs, acc) {
      if (!Array.isArray(runs)) runs = [runs];
      runs.forEach(function (r) { if (r && r.img && r.img.ref) acc.push(r.img.ref); });
    }
    // 图片可能藏在表格单元格里（页眉的 logo 就是这样），必须深度遍历
    function collectImgRefs(blocks, acc) {
      (blocks || []).forEach(function (b) {
        if (!b) return;
        if (b.t === 'img' && b.ref) acc.push(b.ref);
        if (b.runs) collectRuns(b.runs, acc);
        if (b.paras) b.paras.forEach(function (p) { if (p && p.runs) collectRuns(p.runs, acc); });
        if (b.t === 'tbl') {
          (b.rows || []).forEach(function (row) {
            var cells = (row && row.cells) || row || [];
            cells.forEach(function (c) {
              if (!c) return;
              if (c.runs) collectRuns(c.runs, acc);
              if (c.paras) c.paras.forEach(function (p) { if (p && p.runs) collectRuns(p.runs, acc); });
            });
          });
        }
      });
      return acc;
    }

    // ---- header ----
    var headerUsed = collectImgRefs(model.header && model.header.blocks, []);
    var headerImgMap = registerImages(headerUsed);
    var hasHeader = !!(model.header && model.header.blocks && model.header.blocks.length);
    if (hasHeader) {
      var hctx = makeCtx(headerImgMap);
      var hbody = buildBlocks(model.header.blocks, hctx);
      // hdr 必须以一个段落收尾（不能以表格结束）
      hbody += buildP({ after: 0, line: 0.6, runs: [{ sz: 1 }] });
      files['word/header1.xml'] = XMLDECL + '<w:hdr ' + NS_DOC + '>' + hbody + '</w:hdr>';
    }

    // ---- footer ----
    var footerUsed = collectImgRefs(model.footer && model.footer.blocks, []);
    var footerImgMap = registerImages(footerUsed);
    var hasFooter = !!(model.footer && model.footer.blocks && model.footer.blocks.length);
    if (hasFooter) {
      var fctx = makeCtx(footerImgMap);
      var fbody = buildBlocks(model.footer.blocks, fctx);
      fbody += buildP({ after: 0, line: 0.6, runs: [{ sz: 1 }] });
      files['word/footer1.xml'] = XMLDECL + '<w:ftr ' + NS_DOC + '>' + fbody + '</w:ftr>';
    }

    // ---- document ----
    var docUsed = collectImgRefs(model.body, []);
    var docImgMap = registerImages(docUsed);
    var dctx = makeCtx(docImgMap);
    var bodyXml = buildBlocks(model.body, dctx);

    var sectPr = '<w:sectPr>' +
      (hasHeader ? '<w:headerReference w:type="default" r:id="' + headerImgMap.__headerRel + '"/>' : '') +
      (hasFooter ? '<w:footerReference w:type="default" r:id="' + footerImgMap.__footerRel + '"/>' : '') +
      '<w:pgSz w:w="' + pgW + '" w:h="' + pgH + '"/>' +
      '<w:pgMar w:top="' + mTop + '" w:right="' + mRight + '" w:bottom="' + mBottom +
      '" w:left="' + mLeft + '" w:header="' + mHead + '" w:footer="' + mFoot + '" w:gutter="0"/>' +
      '<w:cols w:space="720"/>' +
      '<w:docGrid w:type="lines" w:linePitch="312"/>' +
      '</w:sectPr>';

    files['word/document.xml'] = XMLDECL + '<w:document ' + NS_DOC + '><w:body>' + bodyXml + sectPr + '</w:body></w:document>';

    // ---- rels ----
    var docRels = [{ id: 'rId1', type: RT.styles, target: 'styles.xml' }];
    var nextRel = 2;
    if (hasHeader) { docRels.push({ id: 'rId' + (nextRel++), type: RT.header, target: 'header1.xml' }); }
    if (hasFooter) { docRels.push({ id: 'rId' + (nextRel++), type: RT.footer, target: 'footer1.xml' }); }
    Object.keys(docImgMap).forEach(function (n) {
      docRels.push({ id: docImgMap[n], type: RT.image, target: mediaParts[n].replace(/^word\//, '') });
    });
    files['word/_rels/document.xml.rels'] = relsXml(docRels);

    // 上面 sectPr 里引用的 header/footer rId 必须和 docRels 里的一致 —— 回填
    // （先算 rels 再回填 sectPr，避免两处各算一次导致错位）
    var headerRelId = null, footerRelId = null;
    docRels.forEach(function (r) {
      if (r.type === RT.header) headerRelId = r.id;
      if (r.type === RT.footer) footerRelId = r.id;
    });
    if (headerRelId || footerRelId) {
      var fixed = '<w:sectPr>' +
        (headerRelId ? '<w:headerReference w:type="default" r:id="' + headerRelId + '"/>' : '') +
        (footerRelId ? '<w:footerReference w:type="default" r:id="' + footerRelId + '"/>' : '') +
        '<w:pgSz w:w="' + pgW + '" w:h="' + pgH + '"/>' +
        '<w:pgMar w:top="' + mTop + '" w:right="' + mRight + '" w:bottom="' + mBottom +
        '" w:left="' + mLeft + '" w:header="' + mHead + '" w:footer="' + mFoot + '" w:gutter="0"/>' +
        '<w:cols w:space="720"/>' +
        '<w:docGrid w:type="lines" w:linePitch="312"/>' +
        '</w:sectPr>';
      files['word/document.xml'] = XMLDECL + '<w:document ' + NS_DOC + '><w:body>' + bodyXml + fixed + '</w:body></w:document>';
    }

    if (hasHeader) {
      var hrels = Object.keys(headerImgMap).filter(function (k) { return k.indexOf('__') !== 0; })
        .map(function (n) { return { id: headerImgMap[n], type: RT.image, target: mediaParts[n].replace(/^word\//, '') }; });
      if (hrels.length) files['word/_rels/header1.xml.rels'] = relsXml(hrels);
    }
    if (hasFooter) {
      var frels = Object.keys(footerImgMap).filter(function (k) { return k.indexOf('__') !== 0; })
        .map(function (n) { return { id: footerImgMap[n], type: RT.image, target: mediaParts[n].replace(/^word\//, '') }; });
      if (frels.length) files['word/_rels/footer1.xml.rels'] = relsXml(frels);
    }

    files['_rels/.rels'] = relsXml([
      { id: 'rId1', type: RT.officeDocument, target: 'word/document.xml' },
      { id: 'rId2', type: RT.core, target: 'docProps/core.xml' },
      { id: 'rId3', type: RT.app, target: 'docProps/app.xml' }
    ]);
    files['docProps/core.xml'] = coreXml(model);
    files['docProps/app.xml'] = appXml(model);
    files['word/styles.xml'] = stylesXml(model);
    files['[Content_Types].xml'] = contentTypes(hasHeader, hasFooter, imgCounter > 0);

    // ---- 图片二进制 ----
    Object.keys(mediaParts).forEach(function (n) {
      var img = model.images[n];
      files[mediaParts[n]] = img.data ? { bytes: img.data } : { base64: img.base64 };
    });

    return files;
  }

  /** 打包成 JSZip 实例（浏览器 / Node 通用，JSZip 由调用方传入，避免本模块耦合打包器） */
  function zip(model, JSZip) {
    var files = parts(model);
    var z = new JSZip();
    Object.keys(files).forEach(function (p) {
      var v = files[p];
      if (v && v.base64) z.file(p, v.base64, { base64: true });
      else if (v && v.bytes) z.file(p, v.bytes);
      else z.file(p, v);
    });
    return z;
  }

  return {
    parts: parts,
    zip: zip,
    cm: cm, hp: hp, tw: tw, emu: emu, esc: esc,
    buildP: buildP, buildRun: buildRun, buildField: buildField, buildTable: buildTable
  };
});
