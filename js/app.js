import { getState, patchState } from './state.js';
import { handleAuthChange, initDB, savePushSubscription, syncData } from './api.js';
import { initUI, openModal } from './ui.js';

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  try {
    await navigator.serviceWorker.register('./sw.js');
  } catch (err) {
    console.warn('[2DoByU] service worker registration failed', err);
  }
}

function base64UrlToUint8Array(base64Url) {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4);
  const normalized = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(normalized);
  return Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
}

async function requestNotificationPermissionFlow() {
  if (!('Notification' in window) || !('serviceWorker' in navigator)) return;
  if (Notification.permission !== 'default') return;
  if (localStorage.getItem('2dobyu_push_prompted') === '1') return;

  localStorage.setItem('2dobyu_push_prompted', '1');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return;

  const registration = await navigator.serviceWorker.ready;
  if (!registration?.pushManager) return;

  const state = getState();
  const vapidPublicKey = String(state.settings?.pushPublicKey || '').trim();
  if (!vapidPublicKey) {
    console.info('[2DoByU] Push enabled permission granted, but pushPublicKey is not configured in settings.');
    return;
  }

  const existingSub = await registration.pushManager.getSubscription();
  const subscription =
    existingSub ||
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToUint8Array(vapidPublicKey)
    }));

  await savePushSubscription(subscription);
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

  requestNotificationPermissionFlow().catch((err) => {
    console.warn('[2DoByU] notification flow failed', err);
  });

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
