/* ============================================================
   pdf.js 老浏览器兼容补丁（2026-10-29）
   ------------------------------------------------------------
   症状：公司 Win7 电脑（Chrome 最高只能装到 109）上传 GD 单，报
        「这份 PDF 打不开：Promise.withResolvers is not a function」
        同一份单子在新电脑上一切正常。

   原因：本目录的 pdf.js 是 4.5+（2024 年版），内部直接调用
        Promise.withResolvers()。这个 API 2024 年才进浏览器，
        只有 Chrome 119+ / Edge 119+ / Safari 17.4+ / Firefox 121+ 才有。
        引擎里其它新 API（Promise.try、Uint8Array#toBase64）都自带兜底，
        唯独 withResolvers 没有 —— 所以新版浏览器正常、老版必挂。

   做法：补一份语义完全等价的实现。现代浏览器上这段直接 return，
        不改变任何行为。

   ⚠️ 维护提醒
   - 升级 pdf.js 后先 grep 一下 `withResolvers`：还在用就必须保留本补丁。
   - libs/pdfjs/pdf.worker.min.mjs 文件头部有一份**同样的**补丁，
     不能删 —— worker 是独立的 JS 环境，本文件里的补丁管不到它。
   - 本文件必须用普通 <script> 加载（不能是 module），且排在
     pdf.min.mjs 之前，见 index.html 第 20 行附近。

   ------------------------------------------------------------
   补丁二：URL.parse（2026-10-31）
   ------------------------------------------------------------
   症状：同一个 Win7 / Chrome 109 电脑，上传 GD 单报
        「Setting up fake worker failed: Failed to fetch dynamically
         imported module: .../libs/pdfjs/libs/pdfjs/pdf.worker.min.mjs」
        注意地址里 libs/pdfjs 出现了两遍。

   原因（两层）：
   1) pdf.js 决定「要不要开后台 worker」时会先调 URL.parse()，
      这个静态方法是 Chrome 126+ 才有的。109 上没有 → 抛异常 →
      引擎判定「worker 不可用」，退化成在主线程里 import 一份 worker 脚本。
   2) 退化路径里的 import() 写在 pdf.min.mjs 内部，相对地址按
      pdf.min.mjs 所在目录（libs/pdfjs/）解析，于是把
      './libs/pdfjs/pdf.worker.min.mjs' 拼成了 libs/pdfjs/libs/pdfjs/... → 404。

   做法：
   - 这里补一个 URL.parse 的等价实现（解析失败返回 null，与规范一致），
     让 109 也能开真正的后台 worker，不再走退化路径；
   - index.html 里 workerSrc 同时改成**绝对地址**兜底，万一还是退化，
     地址也不会再拼错。
   现代浏览器上这段直接 return，不改变任何行为。
   ============================================================ */
(function () {
  if (typeof Promise.withResolvers === 'function') return;
  Object.defineProperty(Promise, 'withResolvers', {
    value: function () {
      var resolve, reject;
      var promise = new Promise(function (res, rej) { resolve = res; reject = rej; });
      return { promise: promise, resolve: resolve, reject: reject };
    },
    writable: true,
    enumerable: false,
    configurable: true
  });
})();

/* 补丁二：URL.parse（Chrome 126+ 才有；109 上缺了会让 pdf.js 放弃后台 worker） */
(function () {
  if (typeof URL.parse === 'function') return;
  Object.defineProperty(URL, 'parse', {
    value: function (url, base) {
      try {
        return new URL(url, base);
      } catch (e) {
        return null;
      }
    },
    writable: true,
    enumerable: false,
    configurable: true
  });
})();
