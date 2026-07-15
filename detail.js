'use strict';

(function () {
  const button = document.querySelector('[data-copy-checklist]');
  const source = document.getElementById('merchant-checklist-copy');
  if (!button || !source) return;

  const originalLabel = button.textContent;
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(source.textContent.trim());
      button.textContent = '已复制，可发给商家';
    } catch (_error) {
      source.setAttribute('tabindex', '-1');
      source.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(source);
      selection.removeAllRanges();
      selection.addRange(range);
      button.textContent = '已选中，请长按复制';
    }
    window.setTimeout(() => { button.textContent = originalLabel; }, 3200);
  });
}());
