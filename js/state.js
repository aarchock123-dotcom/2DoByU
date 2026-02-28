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
  googleAuthEnabled: false
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
    gateMode: 'signin',
    gateStep: 'choice',
    appUnlocked: false
  },
  sync: {
    cloudUser: null,
    cloudSyncInFlight: false,
    cloudOfflineQueue: []
  },
  settings: structuredClone(DEFAULT_SETTINGS)
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

export function setState(updater) {
  const next = typeof updater === 'function' ? updater(state) : updater;
  if (next && typeof next === 'object') {
    state = next;
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
      gateMode: 'signin',
      gateStep: 'choice',
      appUnlocked: false
    },
    sync: {
      cloudUser: null,
      cloudSyncInFlight: false,
      cloudOfflineQueue: []
    },
    settings: structuredClone(DEFAULT_SETTINGS)
  };
  notify();
}

export { PAGE_TITLES, DEFAULT_SETTINGS };
