(function() {
  const copyBtn = document.getElementById('copyReferralBtn');
  const linkInput = document.getElementById('referralLink');
  const label = document.getElementById('copyBtnLabel');
  if (!copyBtn || !linkInput) return;

  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(linkInput.value);
      label.textContent = 'Copied!';
      copyBtn.classList.add('copied');
      setTimeout(() => {
        label.textContent = 'Copy';
        copyBtn.classList.remove('copied');
      }, 2000);
    } catch (err) {
      // Fallback: select + execCommand
      linkInput.select();
      try { document.execCommand('copy'); label.textContent = 'Copied!'; } catch (e) {}
      setTimeout(() => { label.textContent = 'Copy'; }, 2000);
    }
  });

  // Also copy on input click for convenience
  linkInput.addEventListener('click', () => { linkInput.select(); });
})();
