import { getState, patchState } from './state.js';

const DB_NAME = '2DoByU_DB';
const DB_VERSION = 1;
const STORE_NAME = 'sync_store';
const PRIMARY_KEY = 'singleton';

const SUPABASE_URL = 'https://pebvtcctjdjyyxrbepby.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_eBavrWNjMUpHt9Kp7lMONA_YDK-EQQ4';

let dbPromise = null;
let supabaseClient = null;

function getSupabaseClient() {
  if (supabaseClient) return supabaseClient;

  const maybeFactory = window?.supabase?.createClient;
  if (!maybeFactory) {
    throw new Error('Supabase client not found. Ensure @supabase/supabase-js is loaded.');
  }

  const { settings } = getState();
  const url = (settings?.supabaseUrl || SUPABASE_URL || '').trim();
  const key = (settings?.supabaseAnonKey || SUPABASE_ANON_KEY || '').trim();

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
  const {
    data: { user }
  } = await sb.auth.getUser();

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
  const {
    data: { user }
  } = await sb.auth.getUser();

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

  if (!navigator.onLine) {
    if (localDoc) {
      patchState({
        tasks: localDoc.tasks,
        habits: localDoc.habits,
        notes: localDoc.notes,
        archived: localDoc.archived,
        taskIdCounter: localDoc.taskIdCounter,
        settings: localDoc.settings
      });
    }
    return localDoc;
  }

  const remoteDoc = await fetchRemoteUserData();
  const merged = mergeState(localDoc || {}, remoteDoc || {});

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
  return merged;
}

export async function pushUpdate(nextStateLike) {
  const snapshot = nextStateLike || getState();
  const doc = cloneStateForStorage(snapshot);

  await saveUserData(doc);

  if (!navigator.onLine) {
    console.info('[2DoByU] Offline: update saved locally; sync deferred.');
    return;
  }

  try {
    await pushRemoteUserData(doc);
    patchState({
      sync: {
        ...getState().sync,
        lastSyncedAt: doc.updatedAt
      }
    });
  } catch (err) {
    console.warn('[2DoByU] Remote push failed; local IndexedDB data preserved.', err);
  }
}

export async function signIn(email, password) {
  const sb = getSupabaseClient();
  const { data, error } = await sb.auth.signInWithPassword({ email, password });

  if (error) throw error;

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

  if (error) throw error;

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

  if (error) throw error;

  patchState({
    user: null,
    ui: {
      ...getState().ui,
      authModal: true
    }
  });
}

export function handleAuthChange() {
  const sb = getSupabaseClient();

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
