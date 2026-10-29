这里放的是机组名单「自动识别」用的运行时，全部本地加载，不走任何 CDN。

文件来源与许可
--------------------------------------------------
tesseract.min.js / worker.min.js
    来自 tesseract.js 5.x（https://github.com/naptha/tesseract.js）
    许可：Apache License 2.0

tesseract-core-simd-lstm.wasm.js
    来自 tesseract.js-core 5.x（同上仓库）
    许可：Apache License 2.0

lang/eng.traineddata.gz
    英文识别模型，来自 tesseract-ocr/tessdata_fast（https://github.com/tesseract-ocr/tessdata_fast）
    选择 fast 版而不是 best 版：体积 2.4MB vs 10.9MB，而这批 GD 单文字清晰，
    实测 fast 版在这张单子上 100 个字段全对，没必要让公司电脑下载 10MB。

为什么不用 CDN
--------------------------------------------------
国内访问 jsdelivr 经常被重置（实测 ECONNRESET），
所以把三个文件连同语言包一起放在网站目录里，页面用相对路径加载。

识别逻辑见 ../../ocr.js，其中说明了 GD 单为什么必须靠 OCR：
那份 PDF 是矢量转曲的，文字被转成了轮廓曲线，文件里 0 个字体、0 条文字指令。
