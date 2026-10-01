(() => {
  let installPrompt;

  const updateInstallButton = () => {
    const button = document.getElementById('installApp');
    if (button) button.hidden = !installPrompt;
  };

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPrompt = event;
    updateInstallButton();
  });

  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    updateInstallButton();
  });

  document.addEventListener('show', (event) => {
    if (event.target.matches('#loginPage')) updateInstallButton();
  });

  document.addEventListener('click', async (event) => {
    if (!event.target.closest('#installApp') || !installPrompt) return;
    await installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    updateInstallButton();
  });

  if ('serviceWorker' in navigator && /^https?:$/.test(window.location.protocol)) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./service-worker.js').catch(() => {});
    });
  }
})();