'use strict';
document.querySelectorAll('[data-copy]').forEach((button) => {
  button.addEventListener('click', async () => {
    const target = document.querySelector(button.dataset.copy);
    if (!target) return;
    const text = target.textContent || '';
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = 'Көшірілді ✓';
      window.setTimeout(() => { button.textContent = 'Көшіру'; }, 1600);
    } catch {
      button.textContent = 'Қолмен белгіле';
      const range = document.createRange(); range.selectNodeContents(target);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    }
  });
});
