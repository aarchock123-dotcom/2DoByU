import { consumePendingChanges, getState, patchState, restorePendingChanges } from './state.js';

const DB_NAME = '2DoByU_DB';
const DB_VERSION = 1;
const STORE_NAME = 'sync_store';
const PRIMARY_KEY = 'singleton';

const SUPABASE_URL = 'https://pebvtcctjdjyyxrbepby.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_eBavrWNjMUpHt9Kp7lMONA_YDK-EQQ4';

let dbPromise = null;
let supabaseClient = null;

function showOfflineModeToast() {
  let toast = document.getElementById('offline-mode-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'offline-mode-toast';
    toast.textContent = 'Offline Mode - Changes saved locally';
    Object.assign(toast.style, {
      position: 'fixed',
      right: '16px',
      bottom: '16px',
      padding: '10px 12px',
      background: 'rgba(26, 26, 26, 0.9)',
      color: '#fff',
      borderRadius: '8px',
      fontSize: '12px',
      zIndex: '9999',
      opacity: '0',
      transform: 'translateY(8px)',
      transition: 'opacity .2s ease, transform .2s ease',
      pointerEvents: 'none'
    });
    document.body.appendChild(toast);
  }

  clearTimeout(toast._hideTimer);
  toast.style.opacity = '1';
  toast.style.transform = 'translateY(0)';
  toast._hideTimer = setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(8px)';
  }, 2200);
}

function handleSupabaseFailure(error, context) {
  console.warn(`[2DoByU] Supabase request failed (${context}).`, error);
  showOfflineModeToast();
}

function getSupabaseClient() {
  if (supabaseClient) return supabaseClient;

  const maybeFactory = window?.supabase?.createClient;
  if (!maybeFactory) {
    throw new Error('Supabase client not found. Ensure @supabase/supabase-js is loaded.');
  }

  const { settings } = getState();
  const storedUrl = localStorage.getItem('2dobyu_supabase_url') || localStorage.getItem('supabase_url') || '';
  const storedKey = localStorage.getItem('2dobyu_supabase_anon_key') || localStorage.getItem('supabase_anon_key') || '';

  const url = (storedUrl || settings?.supabaseUrl || SUPABASE_URL || '').trim();
  const key = (storedKey || settings?.supabaseAnonKey || SUPABASE_ANON_KEY || '').trim();

  if (!url || !key) {
    throw new Error('Supabase URL/Anon key missing in settings.');
  }

  supabaseClient = maybeFactory(url, key);
  return supabaseClient;
}

export function initDB() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  return dbPromise;
}

function cloneStateForStorage(snapshot) {
  return {
    tasks: snapshot.tasks,
    habits: snapshot.habits,
    notes: snapshot.notes,
    archived: snapshot.archived,
    taskIdCounter: snapshot.taskIdCounter,
    settings: snapshot.settings,
    updatedAt: new Date().toISOString(),
    schemaVersion: 1
  };
}

function normalizeDocShape(doc, fallbackState = getState()) {
  return {
    ...doc,
    tasks: doc?.tasks || fallbackState.tasks,
    habits: Array.isArray(doc?.habits) ? doc.habits : fallbackState.habits,
    notes: Array.isArray(doc?.notes) ? doc.notes : fallbackState.notes,
    archived: doc?.archived || fallbackState.archived,
    taskIdCounter: Number(doc?.taskIdCounter || fallbackState.taskIdCounter || 1),
    settings: doc?.settings || fallbackState.settings,
    updatedAt: doc?.updatedAt || new Date().toISOString()
  };
}

function applyQueuedChanges(baseDoc, changes = []) {
  const merged = normalizeDocShape(baseDoc || {}, getState());

  const removeTaskById = (taskId) => {
    ['todo', 'inprogress', 'done'].forEach((column) => {
      merged.tasks[column] = merged.tasks[column].filter((task) => String(task.id) !== String(taskId));
    });
  };

  changes.forEach((change) => {
    const payload = change?.payload || {};

    if (change?.type === 'full-snapshot') {
      const doc = normalizeDocShape(payload.doc || {}, merged);
      merged.tasks = doc.tasks;
      merged.habits = doc.habits;
      merged.notes = doc.notes;
      merged.archived = doc.archived;
      merged.taskIdCounter = doc.taskIdCounter;
      merged.settings = doc.settings;
      return;
    }

    if (change?.type === 'task-upsert' && payload.task) {
      removeTaskById(payload.task.id);
      const column = payload.column && merged.tasks[payload.column] ? payload.column : 'todo';
      merged.tasks[column].push(payload.task);
      return;
    }

    if (change?.type === 'task-delete') {
      removeTaskById(payload.taskId);
      return;
    }

    if (change?.type === 'habit-upsert') {
      const index = Number(payload.index);
      if (!Number.isInteger(index) || index < 0) return;
      const nextHabits = [...merged.habits];
      nextHabits[index] = payload.habit || null;
      merged.habits = nextHabits.filter((item) => item != null);
      return;
    }

    if (change?.type === 'habit-delete') {
      const index = Number(payload.index);
      if (!Number.isInteger(index) || index < 0) return;
      const nextHabits = [...merged.habits];
      nextHabits.splice(index, 1);
      merged.habits = nextHabits;
      return;
    }

    if (change?.type === 'note-upsert' && payload.note) {
      const next = [...merged.notes];
      const idx = next.findIndex((item) => String(item.id) === String(payload.note.id));
      if (idx === -1) next.push(payload.note);
      else next[idx] = payload.note;
      merged.notes = next;
      return;
    }

    if (change?.type === 'note-delete') {
      merged.notes = merged.notes.filter((item) => String(item.id) !== String(payload.id));
      return;
    }

    if (change?.type === 'settings-merge') {
      merged.settings = {
        ...(merged.settings || {}),
        ...(payload.settings || {})
      };
    }
  });

  merged.updatedAt = new Date().toISOString();
  return merged;
}

async function pushRemoteChanges(changes, localFallbackDoc) {
  const remoteDoc = await fetchRemoteUserData().catch(() => null);
  const baseDoc = remoteDoc || localFallbackDoc;
  const mergedDoc = applyQueuedChanges(baseDoc, changes);
  await pushRemoteUserData(mergedDoc);
  return mergedDoc;
}

function mergeState(localDoc, remoteDoc) {
  const localTs = Date.parse(localDoc?.updatedAt || 0) || 0;
  const remoteTs = Date.parse(remoteDoc?.updatedAt || 0) || 0;

  if (remoteTs >= localTs) {
    return {
      ...localDoc,
      ...remoteDoc,
      tasks: remoteDoc?.tasks || localDoc?.tasks,
      habits: remoteDoc?.habits || localDoc?.habits,
      notes: remoteDoc?.notes || localDoc?.notes,
      archived: remoteDoc?.archived || localDoc?.archived,
      taskIdCounter: remoteDoc?.taskIdCounter || localDoc?.taskIdCounter,
      settings: {
        ...(localDoc?.settings || {}),
        ...(remoteDoc?.settings || {})
      },
      updatedAt: remoteDoc?.updatedAt || localDoc?.updatedAt || new Date().toISOString()
    };
  }

  return {
    ...remoteDoc,
    ...localDoc,
    tasks: localDoc?.tasks || remoteDoc?.tasks,
    habits: localDoc?.habits || remoteDoc?.habits,
    notes: localDoc?.notes || remoteDoc?.notes,
    archived: localDoc?.archived || remoteDoc?.archived,
    taskIdCounter: localDoc?.taskIdCounter || remoteDoc?.taskIdCounter,
    settings: {
      ...(remoteDoc?.settings || {}),
      ...(localDoc?.settings || {})
    },
    updatedAt: localDoc?.updatedAt || remoteDoc?.updatedAt || new Date().toISOString()
  };
}

export async function saveUserData(doc) {
  const db = await initDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put({ id: PRIMARY_KEY, payload: doc });

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function fetchUserData() {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(PRIMARY_KEY);

    req.onsuccess = () => resolve(req.result?.payload || null);
    req.onerror = () => reject(req.error);
  });
}

async function fetchRemoteUserData() {
  const sb = getSupabaseClient();
  const userResp = await sb.auth.getUser();
  if (userResp.error) throw userResp.error;
  const user = userResp.data?.user || null;

  if (!user) return null;

  const { data, error } = await sb
    .from('user_data')
    .select('data,updated_at')
    .eq('user_id', user.id)
    .maybeSingle();

  if (error) throw error;

  if (!data?.data) return null;
  return {
    ...data.data,
    updatedAt: data.data.updatedAt || data.updated_at || new Date().toISOString()
  };
}

async function pushRemoteUserData(doc) {
  const sb = getSupabaseClient();
  const userResp = await sb.auth.getUser();
  if (userResp.error) throw userResp.error;
  const user = userResp.data?.user || null;

  if (!user) return;

  const { error } = await sb
    .from('user_data')
    .upsert(
      {
        user_id: user.id,
        data: doc,
        updated_at: new Date().toISOString()
      },
      { onConflict: 'user_id' }
    );

  if (error) throw error;
}

export async function syncData() {
  await initDB();

  const localDoc = await fetchUserData();
  const buildLocalFallback = () => {
    const normalizedLocal = localDoc ? normalizeDocShape(localDoc) : null;
    if (localDoc) {
      patchState({
        tasks: normalizedLocal.tasks,
        habits: normalizedLocal.habits,
        notes: normalizedLocal.notes,
        archived: normalizedLocal.archived,
        taskIdCounter: normalizedLocal.taskIdCounter,
        settings: normalizedLocal.settings
      });
    }
    return {
      ...(normalizedLocal || {}),
      authRequired: !getState().user
    };
  };

  if (!navigator.onLine) {
    return buildLocalFallback();
  }

  let sb = null;
  try {
    sb = getSupabaseClient();
    const userResp = await sb.auth.getUser();
    if (userResp.error) throw userResp.error;
    const user = userResp.data?.user || null;
    patchState({
      user,
      ui: {
        ...getState().ui,
        authModal: !user
      }
    });

    if (!user) {
      return {
        ...(localDoc || {}),
        authRequired: true
      };
    }
  } catch (err) {
    handleSupabaseFailure(err, 'syncData:getUser');
    return buildLocalFallback();
  }

  let remoteDoc = null;
  try {
    remoteDoc = await fetchRemoteUserData();
  } catch (err) {
    handleSupabaseFailure(err, 'syncData:fetchRemoteUserData');
    return buildLocalFallback();
  }

  const merged = normalizeDocShape(mergeState(localDoc || {}, remoteDoc || {}));

  patchState({
    tasks: merged.tasks,
    habits: merged.habits,
    notes: merged.notes,
    archived: merged.archived,
    taskIdCounter: merged.taskIdCounter,
    settings: merged.settings,
    sync: {
      ...getState().sync,
      lastSyncedAt: merged.updatedAt
    }
  });

  await saveUserData(merged);

  const pendingChanges = consumePendingChanges();
  if (pendingChanges.length > 0) {
    try {
      const pushedDoc = await pushRemoteChanges(pendingChanges, merged);
      await saveUserData(pushedDoc);
      patchState({
        sync: {
          ...getState().sync,
          lastSyncedAt: pushedDoc.updatedAt
        }
      });
    } catch (err) {
      restorePendingChanges(pendingChanges);
      handleSupabaseFailure(err, 'syncData:pushRemoteChanges');
    }
  }

  return {
    ...merged,
    authRequired: false
  };
}

export async function pushUpdate(nextStateLike) {
  const snapshot = nextStateLike || getState();
  const doc = cloneStateForStorage(snapshot);
  const pendingChanges = consumePendingChanges();

  await saveUserData(doc);

  if (!navigator.onLine) {
    console.info('[2DoByU] Offline: update saved locally; sync deferred.');
    restorePendingChanges(pendingChanges);
    return;
  }

  if (pendingChanges.length === 0) return;

  try {
    const pushedDoc = await pushRemoteChanges(pendingChanges, doc);

    patchState({
      sync: {
        ...getState().sync,
        lastSyncedAt: pushedDoc.updatedAt
      }
    });
  } catch (err) {
    restorePendingChanges(pendingChanges);
    handleSupabaseFailure(err, 'pushUpdate:pushRemoteUserData');
    console.warn('[2DoByU] Remote push failed; local IndexedDB data preserved.', err);
  }
}

export async function savePushSubscription(subscription) {
  if (!subscription) return;

  const sb = getSupabaseClient();
  const userResp = await sb.auth.getUser();
  if (userResp.error) throw userResp.error;
  const user = userResp.data?.user || null;
  if (!user) return;

  const json = typeof subscription.toJSON === 'function' ? subscription.toJSON() : subscription;
  const endpoint = String(json?.endpoint || '').trim();
  if (!endpoint) return;

  const { error } = await sb.from('user_subscriptions').upsert(
    {
      user_id: user.id,
      endpoint,
      p256dh: json?.keys?.p256dh || null,
      auth: json?.keys?.auth || null,
      subscription: json,
      updated_at: new Date().toISOString()
    },
    { onConflict: 'endpoint' }
  );

  if (error) throw error;
}

export async function signIn(email, password) {
  const sb = getSupabaseClient();
  const { data, error } = await sb.auth.signInWithPassword({ email, password });

  if (error) {
    handleSupabaseFailure(error, 'signIn');
    throw error;
  }

  patchState({
    user: data?.user || data?.session?.user || null,
    ui: {
      ...getState().ui,
      authModal: false
    }
  });

  return data;
}

export async function signUp(email, password) {
  const sb = getSupabaseClient();
  const { data, error } = await sb.auth.signUp({ email, password });

  if (error) {
    handleSupabaseFailure(error, 'signUp');
    throw error;
  }

  patchState({
    user: data?.user || data?.session?.user || null,
    ui: {
      ...getState().ui,
      authModal: false
    }
  });

  return data;
}

export async function signOut() {
  const sb = getSupabaseClient();
  const { error } = await sb.auth.signOut();

  if (error) {
    handleSupabaseFailure(error, 'signOut');
    throw error;
  }

  patchState({
    user: null,
    ui: {
      ...getState().ui,
      authModal: true
    }
  });
}

export function handleAuthChange() {
  let sb = null;
  try {
    sb = getSupabaseClient();
  } catch (err) {
    console.warn('[2DoByU] Auth listener unavailable; Supabase client not initialized.', err);
    return;
  }

  sb.auth.onAuthStateChange((_event, session) => {
    patchState({
      user: session?.user || null,
      ui: {
        ...getState().ui,
        authModal: !session?.user
      }
    });
  });
}
