(function () {
  'use strict';

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const revealNodes = document.querySelectorAll('.reveal');

  if (reduceMotion || !('IntersectionObserver' in window)) {
    revealNodes.forEach((node) => node.classList.add('is-visible'));
  } else {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      });
    }, { rootMargin: '0px 0px -8%', threshold: 0.08 });
    revealNodes.forEach((node) => observer.observe(node));
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
