/**
 * 一键生成干净 PDF（无浏览器自带页眉页脚，保留可选中文字）
 * 运行方式：
 *   cd "日报生成器" 目录
 *   NODE_PATH=/Users/pangtouhema/.workbuddy/binaries/node/workspace/node_modules \
 *   /Users/pangtouhema/.workbuddy/binaries/node/versions/22.22.2/bin/node generate-pdf.js
 *
 * 脚本会启动本机 Chrome，等待页面 JS 渲染完成，然后导出 A4 PDF。
 * 不再包含浏览器自动加的日期、标题、URL、页码，只保留你定义的页眉页脚。
 */
const fs = require('fs');
const path = require('path');

// 优先使用隔离工作区里的 puppeteer-core
const ws = '/Users/pangtouhema/.workbuddy/binaries/node/workspace/node_modules';
if (fs.existsSync(ws) && !module.paths.includes(ws)) {
  module.paths.unshift(ws);
}
const puppeteer = require('puppeteer-core');

const root = __dirname;
const htmlFile = path.join(root, '日报生成器.html');

if (!fs.existsSync(htmlFile)) {
  console.error('未找到 日报生成器.html，请确认脚本与该文件在同一目录。');
  process.exit(1);
}

// 从 HTML 里提取 LOGO base64，避免重复大图
const htmlSrc = fs.readFileSync(htmlFile, 'utf8');
const logoMatch = htmlSrc.match(/const LOGO = "([^"]+)"/);
const LOGO = logoMatch ? logoMatch[1] : '';
if (!LOGO) {
  console.error('未能在 HTML 中找到 LOGO 常量。');
  process.exit(1);
}

// 日期格式化 YYYYMMDD
const today = new Date();
const dateStr = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
const outFile = path.join(root, `生产情况汇总${dateStr}.pdf`);

// 查找可用的 Chrome/Chromium/Edge
const candidates = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/opt/google/chrome/google-chrome',
];

const executablePath = candidates.find(p => fs.existsSync(p));
if (!executablePath) {
  console.error('未找到 Chrome/Chromium/Edge，请先安装 Chrome 后再运行本脚本。');
  process.exit(1);
}

// Puppeteer 页眉页脚模板（每页重复，不依赖 CSS fixed / counter）
const headerTemplate = `
<div style="width:100%; padding:0 15mm 5px; border-bottom:2px solid #c8102e; box-sizing:border-box; color:#000;">
  <img src="${LOGO}" style="height:38px; float:left; display:block; margin-top:2px;">
  <div style="float:right; text-align:right; font-size:11pt; font-family:'KaiTi','STKaiti','Kaiti SC','楷体',serif; line-height:1.35; margin-top:2px;"><b>浙江分公司</b><br>地面服务部（运行指挥中心）</div>
  <div style="text-align:center; font-size:26pt; font-weight:700; font-family:'KaiTi','STKaiti','Kaiti SC','楷体',serif; letter-spacing:3px; color:#000;">生产情况汇总</div>
  <div style="clear:both;"></div>
</div>`;

const footerTemplate = `
<div style="width:100%; padding:5px 15mm 0; border-top:1px solid #999; box-sizing:border-box; font-size:8pt; color:#666; font-family:'SimSun','宋体',serif;">
  <span style="display:inline-block; width:33%;"></span>
  <span style="display:inline-block; width:34%; text-align:center; white-space:nowrap;">第 <span class="pageNumber"></span> 页 / 共 <span class="totalPages"></span> 页</span>
  <span style="display:inline-block; width:33%; text-align:right; white-space:nowrap;">联系方式：0577-86898022</span>
</div>`;

(async () => {
  console.log('使用浏览器：', executablePath);
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath,
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
    });
    const page = await browser.newPage();
    await page.goto(`file://${htmlFile}`, { waitUntil: 'networkidle0', timeout: 60000 });

    // 等待 render() 完成
    await page.waitForFunction(() => {
      const host = document.getElementById('paperHost');
      return host && host.innerHTML.includes('生产情况汇总');
    }, { timeout: 30000 });

    // 隐藏 HTML 自带的页眉页脚，改用 Puppeteer 模板
    await page.addStyleTag({ content: '.ph, .docfooter { display: none !important; }' });

    await new Promise(r => setTimeout(r, 300));

    await page.pdf({
      path: outFile,
      format: 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate,
      footerTemplate,
      margin: { top: '30mm', right: '15mm', bottom: '15mm', left: '15mm' },
    });

    await browser.close();
    console.log('\nPDF 已生成：', outFile);
  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    console.error('\n生成 PDF 失败：', e.message);
    process.exit(1);
  }
})();
