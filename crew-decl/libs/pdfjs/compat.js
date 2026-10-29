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
