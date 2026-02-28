const DEFAULT_TASKS = {
  todo: [],
  inprogress: [],
  done: []
};

const DEFAULT_ARCHIVED = {
  tasks: [],
  habits: [],
  notes: []
};

const DEFAULT_SETTINGS = {
  theme: 'light',
  accent: '#d4a373',
  accentDark: '#c49363',
  compact: false,
  autolock: true,
  firstday: 'mon',
  fireworks: true,
  supabaseUrl: '',
  supabaseAnonKey: '',
  googleAuthEnabled: false,
  pushPublicKey: '',
  customTaskViews: []
};

const PAGE_TITLES = {
  tasks: 'Task Board',
  habits: 'Habits',
  analytics: 'Analytics',
  insights: 'Insights',
  calendar: 'Calendar',
  notes: 'Notes',
  settings: 'Settings'
};

let state = {
  tasks: structuredClone(DEFAULT_TASKS),
  habits: [],
  notes: [],
  archived: structuredClone(DEFAULT_ARCHIVED),
  taskIdCounter: 1,
  activityLog: [],
  undoStack: [],
  ui: {
    currentPage: 'tasks',
    pageTitles: PAGE_TITLES,
    taskView: 'status',
    habitView: 'grid',
    calView: 'month',
    syncPending: false,
    gateMode: 'signin',
    gateStep: 'choice',
    appUnlocked: false,
    snackbar: null
  },
  sync: {
    cloudUser: null,
    cloudSyncInFlight: false,
    cloudOfflineQueue: [],
    pendingChanges: []
  },
  settings: structuredClone(DEFAULT_SETTINGS)
};

let pendingUndo = null;
let undoNonce = 0;
let suppressUndoTracking = false;

let dirtyState = {
  full: false,
  tasks: {},
  habits: {},
  notes: false,
  settings: false
};

const listeners = new Set();

export function getState() {
  return state;
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify() {
  for (const listener of listeners) listener(state);
}

function clearSnackbarOnly() {
  state = {
    ...state,
    ui: {
      ...state.ui,
      snackbar: null
    }
  };
}

function commitPendingUndoSnapshot() {
  if (!pendingUndo) return;

  const snapshot = pendingUndo.snapshot;
  clearTimeout(pendingUndo.timer);
  pendingUndo = null;

  state = {
    ...state,
    undoStack: [snapshot, ...(state.undoStack || [])].slice(0, 50)
  };
  clearSnackbarOnly();
}

function queueUndoSnapshot(previousState, label = 'Change') {
  commitPendingUndoSnapshot();

  undoNonce += 1;
  const id = undoNonce;
  const timer = setTimeout(() => {
    commitPendingUndoSnapshot();
    notify();
  }, 5000);

  pendingUndo = {
    id,
    label,
    snapshot: structuredClone(previousState),
    timer
  };

  return {
    id,
    label,
    expiresAt: Date.now() + 5000
  };
}

function shouldTrackUndo(previousState, nextState) {
  return (
    previousState.tasks !== nextState.tasks ||
    previousState.habits !== nextState.habits ||
    previousState.notes !== nextState.notes ||
    previousState.archived !== nextState.archived
  );
}

export function setState(updater) {
  const previousState = state;
  const next = typeof updater === 'function' ? updater(state) : updater;
  if (next && typeof next === 'object') {
    let snackbar = next.ui?.snackbar || null;

    if (!suppressUndoTracking && shouldTrackUndo(previousState, next)) {
      snackbar = queueUndoSnapshot(previousState, 'Changes saved');
    }

    state = {
      ...next,
      ui: {
        ...next.ui,
        snackbar
      }
    };
    notify();
  }
}

export function patchState(partial) {
  state = {
    ...state,
    ...partial,
    ui: {
      ...state.ui,
      ...(partial.ui || {})
    },
    sync: {
      ...state.sync,
      ...(partial.sync || {})
    },
    settings: {
      ...state.settings,
      ...(partial.settings || {})
    }
  };
  notify();
}

export function undoLastChange() {
  if (pendingUndo) {
    const snapshot = pendingUndo.snapshot;
    clearTimeout(pendingUndo.timer);
    pendingUndo = null;

    suppressUndoTracking = true;
    state = structuredClone(snapshot);
    suppressUndoTracking = false;
    clearSnackbarOnly();

    markDirty('full');
    notify();
    return true;
  }

  const stack = state.undoStack || [];
  if (stack.length === 0) return false;

  const [snapshot, ...rest] = stack;
  suppressUndoTracking = true;
  state = {
    ...structuredClone(snapshot),
    undoStack: rest,
    ui: {
      ...structuredClone(snapshot).ui,
      snackbar: null
    }
  };
  suppressUndoTracking = false;

  markDirty('full');
  notify();
  return true;
}

export function markDirty(scope, key = null) {
  if (scope === 'full') {
    dirtyState = {
      full: true,
      tasks: {},
      habits: {},
      notes: true,
      settings: true
    };
    return;
  }

  if (dirtyState.full) return;

  if (scope === 'tasks' && key != null) {
    dirtyState.tasks[String(key)] = true;
    return;
  }

  if (scope === 'habits' && key != null) {
    dirtyState.habits[String(key)] = true;
    return;
  }

  if (scope === 'notes') {
    dirtyState.notes = true;
    return;
  }

  if (scope === 'settings') {
    dirtyState.settings = true;
  }
}

export function consumeDirtyState() {
  const snapshot = {
    full: dirtyState.full,
    tasks: { ...dirtyState.tasks },
    habits: { ...dirtyState.habits },
    notes: dirtyState.notes,
    settings: dirtyState.settings
  };

  dirtyState = {
    full: false,
    tasks: {},
    habits: {},
    notes: false,
    settings: false
  };

  return snapshot;
}

export function restoreDirtyState(previousDirty) {
  if (!previousDirty) return;
  dirtyState = {
    full: Boolean(previousDirty.full || dirtyState.full),
    tasks: {
      ...dirtyState.tasks,
      ...(previousDirty.tasks || {})
    },
    habits: {
      ...dirtyState.habits,
      ...(previousDirty.habits || {})
    },
    notes: Boolean(previousDirty.notes || dirtyState.notes),
    settings: Boolean(previousDirty.settings || dirtyState.settings)
  };
}

export function enqueuePendingChange(change) {
  if (!change || typeof change !== 'object') return;

  const nextChange = {
    id: change.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    type: String(change.type || 'unknown'),
    payload: change.payload ?? null,
    ts: change.ts || new Date().toISOString()
  };

  state = {
    ...state,
    sync: {
      ...state.sync,
      pendingChanges: [...(state.sync?.pendingChanges || []), nextChange]
    }
  };
}

export function consumePendingChanges() {
  const snapshot = [...(state.sync?.pendingChanges || [])];
  state = {
    ...state,
    sync: {
      ...state.sync,
      pendingChanges: []
    }
  };
  return snapshot;
}

export function restorePendingChanges(changes = []) {
  if (!Array.isArray(changes) || changes.length === 0) return;

  state = {
    ...state,
    sync: {
      ...state.sync,
      pendingChanges: [...(changes || []), ...(state.sync?.pendingChanges || [])]
    }
  };
}

function getThisWeekDate(dIdx) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dow = today.getDay();
  const daysSinceMon = dow === 0 ? 6 : dow - 1;
  const mon = new Date(today);
  mon.setDate(today.getDate() - daysSinceMon);
  const day = new Date(mon);
  day.setDate(mon.getDate() + dIdx);
  return day;
}

function getHabitDateKey(dIdx) {
  return getThisWeekDate(dIdx).toISOString().slice(0, 10);
}

function normalizeHistoryValue(value) {
  if (value === true) return true;
  if (value === false) return false;
  if (value === 'skipped' || value === 'skip' || value === 'snoozed') return 'skipped';
  if (value && typeof value === 'object') {
    if (value.status === 'done') return true;
    if (value.status === 'skipped' || value.status === 'skip' || value.status === 'snoozed') return 'skipped';
  }
  return false;
}

export function migrateHabitModel(habit) {
  const next = { ...habit };

  if (!next.history || typeof next.history !== 'object') next.history = {};
  next.history = Object.fromEntries(
    Object.entries(next.history).map(([k, v]) => [k, normalizeHistoryValue(v)])
  );

  if (Array.isArray(next.days)) {
    next.days.forEach((checked, dIdx) => {
      const key = getHabitDateKey(dIdx);
      if (next.history[key] === undefined) {
        next.history[key] = checked === true;
      }
    });
    delete next.days;
  }

  if (!next.reflections || typeof next.reflections !== 'object') {
    next.reflections = {};
  }

  return next;
}

export function migrateLegacyState(raw) {
  const tasks = raw?.tasks || structuredClone(DEFAULT_TASKS);
  const habits = Array.isArray(raw?.habits) ? raw.habits.map(migrateHabitModel) : [];
  const notes = Array.isArray(raw?.notes) ? raw.notes : [];
  const archived = raw?.archived || structuredClone(DEFAULT_ARCHIVED);

  return {
    ...state,
    tasks,
    habits,
    notes,
    archived,
    taskIdCounter: Number(raw?.taskIdCounter || state.taskIdCounter || 1)
  };
}

export function resetState() {
  state = {
    tasks: structuredClone(DEFAULT_TASKS),
    habits: [],
    notes: [],
    archived: structuredClone(DEFAULT_ARCHIVED),
    taskIdCounter: 1,
    activityLog: [],
    undoStack: [],
    ui: {
      currentPage: 'tasks',
      pageTitles: PAGE_TITLES,
      taskView: 'status',
      habitView: 'grid',
      calView: 'month',
      syncPending: false,
      gateMode: 'signin',
      gateStep: 'choice',
      appUnlocked: false,
      snackbar: null
    },
    sync: {
      cloudUser: null,
      cloudSyncInFlight: false,
      cloudOfflineQueue: [],
      pendingChanges: []
    },
    settings: structuredClone(DEFAULT_SETTINGS)
  };
  notify();
}

export { PAGE_TITLES, DEFAULT_SETTINGS };
