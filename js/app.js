import { getState, patchState } from './state.js';
import { handleAuthChange, initDB, syncData } from './api.js';
import { initUI, openModal } from './ui.js';

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  try {
    await navigator.serviceWorker.register('./sw.js');
  } catch (err) {
    console.warn('[2DoByU] service worker registration failed', err);
  }
}

async function bootstrap() {
  await registerServiceWorker();
  await initDB();
  handleAuthChange();
  patchState({
    ui: {
      ...getState().ui,
      syncPending: true
    }
  });

  let syncResult = null;
  try {
    syncResult = await syncData();
  } finally {
    patchState({
      ui: {
        ...getState().ui,
        syncPending: false
      }
    });
  }

  if (syncResult?.authRequired) {
    openModal('auth-modal');
  }

  patchState({
    ui: {
      ...getState().ui,
      currentView: getState().ui.currentView || getState().ui.currentPage || 'tasks'
    }
  });

  initUI();
}

bootstrap().catch((err) => {
  console.error('[2DoByU] bootstrap failed', err);
});
