'use strict';
/* Start-up. Loaded last so every feature file has registered itself. */

// Errors are shown on screen by the early safety net in index.html.

function onDBBlocked() {
  $('#view').innerHTML = '<div class="card empty">StudyHub is upgrading its storage.<br>Close any other StudyHub tabs or windows, then reload.</div>';
}

(async function boot() {
  state.ttDate = ymd();
  applyTheme();
  try {
    if (NATIVE) {
      // Android: refill the database from the app's private copy if Chrome emptied it (vault.js),
      // and move file contents left inside the database by older versions out to the private folder
      const back = await vaultRestoreMissing().catch(() => 0);
      if (back) setTimeout(() => toast(`♻️ Restored ${back} items from StudyHub's saved copy`), 600);
      vaultMigrate().then((n) => { if (n) loadAll().then(render); }).catch(() => {});
    }
    await loadAll();
    if (NATIVE) onDBWrite();   // make sure the private copy is up to date
  } catch (e) {
    $('#view').innerHTML = `<div class="card empty">Could not open storage: ${esc(e.message)}</div>`;
    return;
  }

  // Arrived via Android "Share → StudyHub" (see sw.js)
  const p = new URLSearchParams(location.search);
  if (p.has('shared')) {
    const n = p.get('shared');
    if (n === 'error') toast("Couldn't save what you shared");
    else if (Number(n) > 0) { state.tab = 'notes'; state.notesMode = 'files'; setTimeout(() => toast(`Added ${n} shared file${n === '1' ? '' : 's'}`), 300); }
    else if (p.get('note') === '1') { state.tab = 'notes'; state.notesMode = 'quick'; setTimeout(() => toast('Saved to quick notes'), 300); }
    else setTimeout(() => toast('Already in your library'), 300);
    history.replaceState(null, '', location.pathname);
  }

  render();
  notifStartup();
  // Sync with the laptop hub on start (quietly), if set up, or if this browser is on the hub laptop itself.
  if (syncBase() && (syncCfg.lastOk || onHubLaptop())) syncNow();
  // Ask the browser not to evict our data when the phone is low on space.
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  if (NATIVE) {
    // Android app: files ship inside the app, so no service worker (it could serve stale copies after an update).
    await nativeSetup();
    nearbyStartup();   // "Open in StudyHub" links from a friend's share page
    nativeSyncAlerts();
    document.addEventListener('visibilitychange', () => { if (!document.hidden) nativeSyncAlerts(); });
  } else if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
