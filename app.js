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

  if (window.FreasonPoll) {
    try {
      window.FreasonPoll.startPoll();
    } catch (_) {
      const status = document.getElementById('poll-status');
      if (status) status.textContent = '投票功能暂时不可用；照片、页面导航和房源链接不受影响。';
    }
  }
})();
