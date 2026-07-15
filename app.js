(function () {
  'use strict';

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const wideScreen = window.matchMedia('(min-width: 761px)').matches;
  const revealNodes = document.querySelectorAll('.reveal');

  if (!reduceMotion && wideScreen && 'IntersectionObserver' in window && revealNodes.length) {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      });
    }, { rootMargin: '0px 0px -8%', threshold: 0.08 });
    document.documentElement.classList.add('reveal-ready');
    revealNodes.forEach((node) => observer.observe(node));
    window.setTimeout(() => {
      revealNodes.forEach((node) => node.classList.add('is-visible'));
      observer.disconnect();
    }, 1800);
  }

  const xhsLinks = document.querySelectorAll('a[data-xhs-keyword][href="https://www.xiaohongshu.com/explore"]');
  const xhsStatus = document.getElementById('xhs-copy-status');
  const restoreDelay = 5000;

  function legacyCopy(keyword) {
    const textarea = document.createElement('textarea');
    textarea.value = keyword;
    textarea.setAttribute('readonly', '');
    textarea.setAttribute('aria-hidden', 'true');
    textarea.style.position = 'fixed';
    textarea.style.left = '0';
    textarea.style.top = '0';
    textarea.style.width = '1px';
    textarea.style.height = '1px';
    textarea.style.opacity = '0';
    textarea.style.pointerEvents = 'none';
    document.body.appendChild(textarea);
    try {
      textarea.focus();
      textarea.select();
      textarea.setSelectionRange(0, keyword.length);
      return document.execCommand('copy');
    } catch (_) {
      return false;
    } finally {
      document.body.removeChild(textarea);
    }
  }

  function restoreLater(link, attempt) {
    if (link._xhsRestoreTimer) window.clearTimeout(link._xhsRestoreTimer);
    const timer = window.setTimeout(() => {
      if (link._xhsAttempt !== attempt || link._xhsRestoreTimer !== timer) return;
      link.textContent = link._xhsOriginalLabel;
      link._xhsRestoreTimer = null;
    }, restoreDelay);
    link._xhsRestoreTimer = timer;
  }

  function showCopied(link, keyword, attempt) {
    if (link._xhsAttempt !== attempt) return;
    link.textContent = '已复制，去小红书粘贴';
    if (xhsStatus) xhsStatus.textContent = `已复制“${keyword}”，请在小红书粘贴搜索。`;
    restoreLater(link, attempt);
  }

  function showCopyFailure(link, keyword, attempt) {
    if (link._xhsAttempt !== attempt) return;
    link.textContent = '去小红书手动搜索';
    if (xhsStatus) xhsStatus.textContent = `请在小红书搜索“${keyword}”。`;
    restoreLater(link, attempt);
  }

  Array.prototype.forEach.call(xhsLinks, (link) => {
    link._xhsOriginalLabel = link.textContent;
    link._xhsAttempt = 0;
    link.addEventListener('click', () => {
      const attempt = link._xhsAttempt + 1;
      link._xhsAttempt = attempt;
      if (link._xhsRestoreTimer) {
        window.clearTimeout(link._xhsRestoreTimer);
        link._xhsRestoreTimer = null;
      }
      const keyword = link.getAttribute('data-xhs-keyword');
      const copied = legacyCopy(keyword);
      let clipboardWrite = null;

      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          clipboardWrite = navigator.clipboard.writeText(keyword);
        }
      } catch (_) {
        clipboardWrite = null;
      }

      if (copied) {
        showCopied(link, keyword, attempt);
        if (clipboardWrite) Promise.resolve(clipboardWrite).catch(() => {});
      } else if (clipboardWrite) {
        link.textContent = '正在复制…';
        if (xhsStatus) xhsStatus.textContent = `正在复制“${keyword}”…`;
        Promise.resolve(clipboardWrite).then(
          () => showCopied(link, keyword, attempt),
          () => showCopyFailure(link, keyword, attempt)
        );
      } else {
        showCopyFailure(link, keyword, attempt);
      }
    });
  });

  if (window.FreasonPoll) {
    try {
      window.FreasonPoll.startPoll();
    } catch (_) {
      const status = document.getElementById('poll-status');
      if (status) status.textContent = '投票功能暂时不可用；照片、页面导航和房源链接不受影响。';
    }
  }
})();
