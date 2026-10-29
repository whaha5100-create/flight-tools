/* 全站页眉滚动效果（首页 + 8 个工具页共用）
   —— 页眉浮在暗色主视觉上时是「透明 + 白字」，滚动离开主视觉之后
      变成「白色半透明 + 毛玻璃 + 一条细线」。

   样式在 assets/site.css（.nav / .nav.scrolled），这里只负责切类名。

   ⚠️ 为什么单独抽一个文件：这段逻辑首页也要用。抄 9 份的话，
      以后改阈值（现在是 8px）就会漏掉几页。
   ⚠️ 纯增强：脚本不执行时页眉就是「透明浮在图上」，不影响任何功能，
      也不影响首屏渲染（首屏 scrollY=0，本来就不加 .scrolled）。 */
(function () {
  'use strict';
  var nav = document.getElementById('nav');
  if (!nav) return;
  var onScroll = function () {
    nav.classList.toggle('scrolled', window.scrollY > 8);
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
})();
