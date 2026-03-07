import {
  enqueuePendingChange,
  getState,
  markDirty,
  patchState,
  resetState,
  setState,
  subscribe,
  undoLastChange
} from './state.js';
import { pushUpdate, saveUserData, signIn, signUp, signOut, syncData } from './api.js';

let initialized = false;
let draggingTask = null;
let touchDragging = false;
let touchDragGhost = null;
let touchDropColumn = null;
let touchDnDListenersBound = false;
let calendarCursor = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let calendarSelectedDateKey = new Date().toISOString().slice(0, 10);
let calendarView = 'month';
let calendarFilters = {
  task: true,
  habit: true,
  other: true,
  category: 'all'
};
let taskSortMenuOpen = false;
let taskMenuExpanded = false;
let calendarMenuExpanded = false;
let insightsTrendDays = 7;
let taskFilters = {
  query: '',
  sort: 'default',
  due: 'all',
  smartRule: '',
  smartViewId: 'none'
};
let activeModalTrap = null;
let commandPaletteQuery = '';

function getStoredMenuState(key, fallback = false) {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    return raw === '1';
  } catch (_err) {
    return fallback;
  }
}

function setStoredMenuState(key, value) {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch (_err) {
    // ignore storage failures
  }
}

taskMenuExpanded = getStoredMenuState('2dobyu_task_menu_expanded', false);
calendarMenuExpanded = getStoredMenuState('2dobyu_calendar_menu_expanded', false);
try {
  const rawTrendDays = localStorage.getItem('2dobyu_insights_trend_days');
  if (rawTrendDays === '30') insightsTrendDays = 30;
} catch (_err) {
  // ignore storage failures
}

const NOTE_COLORS = ['#fff8e1', '#e3f2fd', '#f3e5f5', '#e8f5e9', '#ffebee', '#fbe9e7'];

const THEME_PRESETS = {
  'the-w': {
    accent: '#d71920',
    accentDark: '#b1151b'
  },
  christmas: {
    accent: '#1f8f4e',
    accentDark: '#176a3a'
  },
  aurora: {
    accent: '#7a5cff',
    accentDark: '#5840d1'
  }
};

const SETTINGS_TIME_ZONES = (() => {
  try {
    const zones = Intl.supportedValuesOf?.('timeZone') || [];
    if (zones.length > 0) return zones;
  } catch (_err) {
    // fallback below
  }

  return [
    'UTC',
    'Australia/Sydney',
    'Australia/Melbourne',
    'Australia/Perth',
    'Europe/London',
    'Europe/Berlin',
    'America/New_York',
    'America/Los_Angeles',
    'Asia/Singapore',
    'Asia/Tokyo'
  ];
})();

function getCurrentView() {
  const state = getState();
  const rawView = state.ui.currentView || state.ui.currentPage || 'tasks';
  return rawView === 'analytics' ? 'insights' : rawView;
}

function setCurrentView(view) {
  const nextView = view === 'analytics' ? 'insights' : view;
  patchState({
    ui: {
      ...getState().ui,
      currentView: nextView,
      currentPage: nextView
    }
  });
}

function applySettingsVisuals() {
  const settings = getState().settings || {};
  const theme = settings.theme || 'light';
  const presetTheme = THEME_PRESETS[theme] || null;

  if (presetTheme) {
    document.documentElement.style.setProperty('--accent', presetTheme.accent);
    document.documentElement.style.setProperty('--accent-dark', presetTheme.accentDark);
  } else if (settings.accent) {
    document.documentElement.style.setProperty('--accent', settings.accent);
  }

  if (!presetTheme && settings.accentDark) {
    document.documentElement.style.setProperty('--accent-dark', settings.accentDark);
  }

  document.body.classList.remove('theme-light', 'theme-dark', 'theme-system', 'theme-the-w', 'theme-christmas', 'theme-aurora');
  document.body.classList.add(`theme-${theme}`);

  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const forceDark = theme === 'dark' || theme === 'aurora' || (theme === 'system' && prefersDark);
  document.body.classList.toggle('dark', forceDark);
  document.body.classList.toggle('compact', Boolean(settings.compact));

  const fireworksEl = document.getElementById('fireworks');
  if (fireworksEl) {
    fireworksEl.style.display = settings.fireworks === false ? 'none' : 'block';
  }
}

function cloneForSync(snapshot) {
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

async function persistSnapshot() {
  const snapshot = getState();
  const doc = cloneForSync(snapshot);
  await saveUserData(doc);
  await pushUpdate(snapshot);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function sanitizeUserText(value) {
  return String(value ?? '').trim().replace(/[\u0000-\u001F\u007F]/g, '');
}

function getReadableTextColor(backgroundColor) {
  const value = String(backgroundColor || '').trim();
  const hexMatch = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!hexMatch) return '#1a1a1a';

  let hex = hexMatch[1];
  if (hex.length === 3) {
    hex = hex
      .split('')
      .map((char) => char + char)
      .join('');
  }

  const red = Number.parseInt(hex.slice(0, 2), 16);
  const green = Number.parseInt(hex.slice(2, 4), 16);
  const blue = Number.parseInt(hex.slice(4, 6), 16);
  const yiq = (red * 299 + green * 587 + blue * 114) / 1000;

  return yiq >= 150 ? '#1a1a1a' : '#ffffff';
}

function queuePendingChange(type, payload) {
  enqueuePendingChange({ type, payload });
}

function queueFullSnapshotChange() {
  queuePendingChange('full-snapshot', { doc: cloneForSync(getState()) });
}

function getCustomTaskViews() {
  const customViews = getState().settings?.customTaskViews;
  return Array.isArray(customViews) ? customViews : [];
}

function evaluateSmartClause(task, rawClause) {
  const clause = rawClause.trim();
  if (!clause) return true;

  const todayKey = new Date().toISOString().slice(0, 10);

  const includesMatch = clause.match(/^(title|tag|notes)\s*\.includes\((['"])(.*?)\2\)$/i);
  if (includesMatch) {
    const field = includesMatch[1].toLowerCase();
    const needle = includesMatch[3].toLowerCase();
    const value = String(task?.[field] || '').toLowerCase();
    return value.includes(needle);
  }

  const match = clause.match(/^(priority|dueDate|tag|title)\s*(===|!==|<=|>=|<|>)\s*(.+)$/i);
  if (!match) return true;

  const field = match[1];
  const op = match[2];
  let rawValue = match[3].trim();

  if (rawValue === 'today') rawValue = `'${todayKey}'`;
  const unquoted = rawValue.replace(/^['"]|['"]$/g, '');
  const left = String(task?.[field] || '');

  if (field === 'dueDate') {
    const leftVal = left || '9999-12-31';
    const rightVal = unquoted;
    if (op === '===') return leftVal === rightVal;
    if (op === '!==') return leftVal !== rightVal;
    if (op === '<') return leftVal < rightVal;
    if (op === '<=') return leftVal <= rightVal;
    if (op === '>') return leftVal > rightVal;
    if (op === '>=') return leftVal >= rightVal;
    return true;
  }

  if (op === '===') return left === unquoted;
  if (op === '!==') return left !== unquoted;
  if (op === '<') return left < unquoted;
  if (op === '<=') return left <= unquoted;
  if (op === '>') return left > unquoted;
  if (op === '>=') return left >= unquoted;
  return true;
}

function matchesSmartRule(task, rule) {
  const normalized = sanitizeUserText(rule);
  if (!normalized) return true;
  return normalized
    .split('&&')
    .map((clause) => clause.trim())
    .filter(Boolean)
    .every((clause) => evaluateSmartClause(task, clause));
}

function getActiveSmartRule() {
  if (taskFilters.smartViewId && taskFilters.smartViewId !== 'none') {
    const view = getCustomTaskViews().find((item) => item.id === taskFilters.smartViewId);
    if (view?.rule) return view.rule;
  }
  return taskFilters.smartRule || '';
}

function buildTaskCsv() {
  const rows = [['type', 'id', 'column', 'title', 'dueDate', 'priority', 'tag', 'notes']];
  ['todo', 'inprogress', 'done'].forEach((column) => {
    getState().tasks[column].forEach((task) => {
      rows.push([
        'task',
        String(task.id ?? ''),
        column,
        String(task.title ?? ''),
        String(task.dueDate ?? ''),
        String(task.priority ?? ''),
        String(task.tag ?? ''),
        String(task.notes ?? '')
      ]);
    });
  });
  return rows;
}

function buildHabitCsv() {
  const rows = [['type', 'index', 'name', 'category', 'freq', 'dateKey', 'status', 'reflection']];
  getState().habits.forEach((habit, index) => {
    const historyEntries = Object.entries(habit.history || {});
    if (historyEntries.length === 0) {
      rows.push(['habit', String(index), String(habit.name || ''), String(habit.category || ''), String(habit.freq || ''), '', '', '']);
      return;
    }

    historyEntries.forEach(([dateKey, raw]) => {
      const status = raw === true ? 'done' : raw === 'skipped' ? 'skipped' : 'missed';
      rows.push([
        'habit',
        String(index),
        String(habit.name || ''),
        String(habit.category || ''),
        String(habit.freq || ''),
        dateKey,
        status,
        String(habit.reflections?.[dateKey] || '')
      ]);
    });
  });
  return rows;
}

function rowsToCsv(rows) {
  return rows
    .map((row) =>
      row
        .map((value) => {
          const text = String(value ?? '');
          const escaped = text.replace(/"/g, '""');
          return /[",\n]/.test(escaped) ? `"${escaped}"` : escaped;
        })
        .join(',')
    )
    .join('\n');
}

function downloadTextFile(filename, content, type = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type });
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(href);
}

function parseNaturalDueDate(inputValue) {
  const input = sanitizeUserText(inputValue).toLowerCase();
  if (!input) return '';

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (/(^|\s)today(\s|$)/.test(input)) {
    return today.toISOString().slice(0, 10);
  }

  if (/(^|\s)tomorrow(\s|$)/.test(input)) {
    const next = new Date(today);
    next.setDate(today.getDate() + 1);
    return next.toISOString().slice(0, 10);
  }

  const weekdayMap = {
    sunday: 0,
    monday: 1,
    tuesday: 2,
    wednesday: 3,
    thursday: 4,
    friday: 5,
    saturday: 6
  };

  for (const [name, targetDow] of Object.entries(weekdayMap)) {
    if (!new RegExp(`(^|\\s)${name}(\\s|$)`).test(input)) continue;

    const result = new Date(today);
    const currentDow = result.getDay();
    let delta = targetDow - currentDow;
    if (delta <= 0) delta += 7;
    result.setDate(result.getDate() + delta);
    return result.toISOString().slice(0, 10);
  }

  return '';
}

function getWeekDate(dIdx) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dow = today.getDay();
  const daysSinceMon = dow === 0 ? 6 : dow - 1;
  const monday = new Date(today);
  monday.setDate(today.getDate() - daysSinceMon);
  const day = new Date(monday);
  day.setDate(monday.getDate() + dIdx);
  return day;
}

function getDateKey(dIdx) {
  return getWeekDate(dIdx).toISOString().slice(0, 10);
}

function getDateKeyFromDate(date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function getRecentDateKeys(daysBack = 7) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const keys = [];
  for (let offset = daysBack; offset >= 0; offset -= 1) {
    const date = new Date(today);
    date.setDate(today.getDate() - offset);
    keys.push(getDateKeyFromDate(date));
  }
  return keys;
}

function formatShortDayLabel(dateKey) {
  const d = new Date(`${dateKey}T00:00:00`);
  const day = d.toLocaleDateString(undefined, { weekday: 'short' });
  return `${day} ${d.getDate()}`;
}

function getHabitStateByDate(habit, dateKey) {
  const raw = habit?.history?.[dateKey];
  if (raw === true) return 'done';
  if (raw === 'skipped' || raw === 'snoozed' || raw === 'skip') return 'skipped';
  if (raw && typeof raw === 'object') {
    if (raw.status === 'done') return 'done';
    if (raw.status === 'skipped' || raw.status === 'snoozed' || raw.status === 'skip') return 'skipped';
  }
  return 'missed';
}

function setHabitDateState(habit, dateKey, nextState) {
  if (!habit.history || typeof habit.history !== 'object') habit.history = {};
  habit.history[dateKey] = nextState === 'done' ? true : nextState === 'skipped' ? 'skipped' : false;
}

function freqActiveDays(habit) {
  const freq = habit.freq || 'daily';
  if (freq === 'daily') return [0, 1, 2, 3, 4, 5, 6];
  if (freq === 'weekdays') return [0, 1, 2, 3, 4];
  if (freq === 'weekends') return [5, 6];
  if (freq === '3x') return [0, 2, 4];
  if (freq === 'custom') return Array.isArray(habit.customDays) ? habit.customDays : [];
  return [0, 1, 2, 3, 4, 5, 6];
}

function getHabitWeeklyCounts(habit) {
  const active = freqActiveDays(habit);
  let done = 0;
  let total = 0;
  for (const dIdx of active) {
    const state = getHabitStateByDate(habit, getDateKey(dIdx));
    if (state === 'skipped') continue;
    total += 1;
    if (state === 'done') done += 1;
  }
  return { done, total };
}

function getTaskById(id) {
  const state = getState();
  const cols = ['todo', 'inprogress', 'done'];
  for (const col of cols) {
    const idx = state.tasks[col].findIndex((task) => String(task.id) === String(id));
    if (idx !== -1) return { task: state.tasks[col][idx], col, idx };
  }
  return null;
}

function removeTaskById(tasks, id) {
  const cols = ['todo', 'inprogress', 'done'];
  for (const col of cols) {
    const idx = tasks[col].findIndex((task) => String(task.id) === String(id));
    if (idx !== -1) return tasks[col].splice(idx, 1)[0];
  }
  return null;
}

function moveTaskToColumn(taskId, targetCol) {
  let moved = false;
  let movedTask = null;

  setState((prev) => {
    const next = structuredClone(prev);
    const task = removeTaskById(next.tasks, taskId);
    if (!task || !next.tasks[targetCol]) return prev;
    next.tasks[targetCol].push(task);
    movedTask = task;
    moved = true;
    return next;
  });

  if (moved) {
    markDirty('tasks', taskId);
    queuePendingChange('task-upsert', {
      task: movedTask,
      column: targetCol
    });
  }

  return moved;
}

function getAllTasksWithColumn(tasks) {
  const entries = [];
  ['todo', 'inprogress', 'done'].forEach((col) => {
    tasks[col].forEach((task) => {
      entries.push({ ...task, _column: col });
    });
  });
  return entries;
}

function getTaskDueDate(task) {
  if (!task?.dueDate) return null;
  const parsed = new Date(`${task.dueDate}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function getStartOfDay(value) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function getTaskSortValue(task) {
  const due = getTaskDueDate(task);
  return due ? due.getTime() : Number.MAX_SAFE_INTEGER;
}

function filterTask(task) {
  const query = taskFilters.query.trim().toLowerCase();
  const today = getStartOfDay(new Date());
  const dueDate = getTaskDueDate(task);
  const smartRule = getActiveSmartRule();

  if (query) {
    const haystack = [task.title, task.tag, task.notes].filter(Boolean).join(' ').toLowerCase();
    if (!haystack.includes(query)) return false;
  }

  if (taskFilters.due === 'today') {
    if (!dueDate || getStartOfDay(dueDate).getTime() !== today.getTime()) return false;
  }

  if (taskFilters.due === 'overdue') {
    if (!dueDate || getStartOfDay(dueDate).getTime() >= today.getTime()) return false;
  }

  if (taskFilters.due === 'upcoming') {
    if (!dueDate || getStartOfDay(dueDate).getTime() <= today.getTime()) return false;
  }

  if (taskFilters.due === 'nodate' && dueDate) {
    return false;
  }

  if (!matchesSmartRule(task, smartRule)) {
    return false;
  }

  return true;
}

function sortTasks(items) {
  const sorted = [...items];

  if (taskFilters.sort === 'title') {
    sorted.sort((a, b) => String(a.title || '').localeCompare(String(b.title || '')));
    return sorted;
  }

  if (taskFilters.sort === 'due-asc') {
    sorted.sort((a, b) => getTaskSortValue(a) - getTaskSortValue(b));
    return sorted;
  }

  if (taskFilters.sort === 'due-desc') {
    sorted.sort((a, b) => getTaskSortValue(b) - getTaskSortValue(a));
    return sorted;
  }

  if (taskFilters.sort === 'recent') {
    sorted.sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
    return sorted;
  }

  return sorted;
}

function getFilteredTaskColumns(tasks) {
  const byColumn = {
    todo: [],
    inprogress: [],
    done: []
  };

  const filtered = sortTasks(getAllTasksWithColumn(tasks).filter(filterTask));
  filtered.forEach((task) => {
    byColumn[task._column].push(task);
  });

  return byColumn;
}

function formatMonthLabel(date) {
  return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function getCalendarGridStart(monthStart) {
  const day = monthStart.getDay();
  const mondayIdx = day === 0 ? 6 : day - 1;
  const gridStart = new Date(monthStart);
  gridStart.setDate(monthStart.getDate() - mondayIdx);
  return gridStart;
}

function getColumnLabel(column) {
  if (column === 'inprogress') return 'In Progress';
  if (column === 'done') return 'Done';
  return 'To Do';
}

function getHabitStatusLabel(status) {
  if (status === 'done') return 'Completed';
  if (status === 'skipped') return 'Skipped';
  return 'Missed';
}

function getCalendarItems() {
  const state = getState();
  const items = [];

  getAllTasksWithColumn(state.tasks)
    .filter((task) => task.dueDate)
    .forEach((task) => {
      items.push({
        type: 'task',
        id: String(task.id),
        title: task.title || '(Untitled Task)',
        dateKey: task.dueDate,
        category: task.tag || 'General',
        meta: getColumnLabel(task._column),
        isAllDay: true,
        hour: 9,
        minute: 0
      });
    });

  state.habits.forEach((habit, idx) => {
    const category = habit.category || 'Other';
    const entries = Object.entries(habit.history || {});
    entries.forEach(([dateKey]) => {
      const status = getHabitStateByDate(habit, dateKey);
      items.push({
        type: 'habit',
        id: String(idx),
        title: habit.name || '(Untitled Habit)',
        dateKey,
        category,
        meta: getHabitStatusLabel(status),
        isAllDay: true,
        hour: 9,
        minute: 0
      });
    });
  });

  state.notes.forEach((note) => {
    const ts = Number(note.id);
    if (!Number.isFinite(ts) || ts <= 0) return;
    const date = new Date(ts);
    if (Number.isNaN(date.getTime())) return;
    items.push({
      type: 'other',
      id: String(note.id),
      title: note.title || '(Untitled Note)',
      dateKey: getDateKeyFromDate(date),
      category: 'Notes',
      meta: 'Note',
      isAllDay: false,
      hour: date.getHours(),
      minute: date.getMinutes()
    });
  });

  return items;
}

function getCalendarCategories(items) {
  const categories = new Set(['all']);
  items.forEach((item) => {
    if (item.category) categories.add(item.category);
  });
  return [...categories];
}

function filterCalendarItems(items) {
  return items.filter((item) => {
    if (item.type === 'task' && !calendarFilters.task) return false;
    if (item.type === 'habit' && !calendarFilters.habit) return false;
    if (item.type === 'other' && !calendarFilters.other) return false;
    if (calendarFilters.category !== 'all' && item.category !== calendarFilters.category) return false;
    return true;
  });
}

function buildItemsByDate(items) {
  return items.reduce((acc, item) => {
    if (!acc[item.dateKey]) acc[item.dateKey] = [];
    acc[item.dateKey].push(item);
    return acc;
  }, {});
}

function getViewStep() {
  if (calendarView === 'day') return { unit: 'day', amount: 1 };
  if (calendarView === '3day') return { unit: 'day', amount: 3 };
  if (calendarView === 'workweek') return { unit: 'day', amount: 5 };
  if (calendarView === '7day') return { unit: 'day', amount: 7 };
  if (calendarView === '3month') return { unit: 'month', amount: 3 };
  if (calendarView === '6month') return { unit: 'month', amount: 6 };
  return { unit: 'month', amount: 1 };
}

function shiftCalendarCursor(direction) {
  const { unit, amount } = getViewStep();
  const next = new Date(calendarCursor);
  if (unit === 'day') {
    next.setDate(next.getDate() + direction * amount);
  } else {
    next.setMonth(next.getMonth() + direction * amount, 1);
  }
  calendarCursor = next;
}

function getCalendarRangeDays() {
  const base = new Date(calendarCursor);
  base.setHours(0, 0, 0, 0);

  if (calendarView === 'day') return [base];

  if (calendarView === '3day' || calendarView === '7day') {
    const count = calendarView === '3day' ? 3 : 7;
    return Array.from({ length: count }, (_unused, idx) => {
      const d = new Date(base);
      d.setDate(base.getDate() + idx);
      return d;
    });
  }

  if (calendarView === 'workweek') {
    const day = base.getDay();
    const mondayOffset = day === 0 ? -6 : 1 - day;
    const monday = new Date(base);
    monday.setDate(base.getDate() + mondayOffset);
    return Array.from({ length: 5 }, (_unused, idx) => {
      const d = new Date(monday);
      d.setDate(monday.getDate() + idx);
      return d;
    });
  }

  return [];
}

function createNode(tag, options = {}, children = []) {
  const el = document.createElement(tag);
  if (options.className) el.className = options.className;
  if (options.text != null) el.textContent = String(options.text);
  if (options.type) el.type = options.type;
  if (options.value != null) el.value = String(options.value);

  if (options.attrs) {
    Object.entries(options.attrs).forEach(([k, v]) => {
      if (v == null) return;
      el.setAttribute(k, String(v));
    });
  }

  if (options.dataset) {
    Object.entries(options.dataset).forEach(([k, v]) => {
      if (v == null) return;
      el.dataset[k] = String(v);
    });
  }

  const list = Array.isArray(children) ? children : [children];
  list.forEach((child) => {
    if (child == null) return;
    if (typeof child === 'string') {
      el.appendChild(document.createTextNode(child));
      return;
    }
    el.appendChild(child);
  });

  return el;
}

function createTaskCard(task, options = {}) {
  const card = createNode('div', {
    className: 'card task-item',
    dataset: { taskId: task.id }
  });
  if (options.draggable) card.setAttribute('draggable', 'true');

  card.appendChild(createNode('div', { className: 'card-title', text: sanitizeUserText(task.title) || '(Untitled Task)' }));

  const meta = createNode('div', { className: 'card-meta' });
  meta.appendChild(createNode('span', { className: 'date-text', text: sanitizeUserText(task.dueDate || 'No date') }));

  if (task.tag) {
    meta.appendChild(createNode('span', { className: 'tag-badge', text: sanitizeUserText(task.tag) }));
  }

  card.appendChild(meta);
  return card;
}

function renderCalendarItemButton(item) {
  return createNode(
    'button',
    {
      className: `calendar-pill calendar-item-${item.type}`,
      dataset: {
        action: 'calendar-open-item',
        itemType: item.type,
        itemId: item.id
      }
    },
    [sanitizeUserText(item.title) || '(Untitled)']
  );
}

function renderMonthGrid(monthStart, itemsByDate, selectedDateKey) {
  const monthBlock = createNode('div', { className: 'calendar-month-block' });
  monthBlock.appendChild(createNode('div', { className: 'calendar-month-label', text: formatMonthLabel(monthStart) }));

  const weekdays = createNode('div', { className: 'calendar-weekdays' });
  ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].forEach((w) => weekdays.appendChild(createNode('span', { text: w })));
  monthBlock.appendChild(weekdays);

  const grid = createNode('div', { className: 'calendar-grid' });
  const monthEnd = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0);
  const gridStart = getCalendarGridStart(monthStart);
  const todayKey = new Date().toISOString().slice(0, 10);

  for (let idx = 0; idx < 42; idx += 1) {
    const day = new Date(gridStart);
    day.setDate(gridStart.getDate() + idx);
    const key = getDateKeyFromDate(day);
    const inMonth = day >= monthStart && day <= monthEnd;
    const isToday = key === todayKey;
    const isSelected = key === selectedDateKey;
    const dayItems = itemsByDate[key] || [];

    const cls = ['calendar-day'];
    if (!inMonth) cls.push('outside');
    if (isToday) cls.push('today');
    if (isSelected) cls.push('selected');

    const dayEl = createNode('div', {
      className: cls.join(' '),
      dataset: {
        action: 'calendar-select-day',
        date: key
      }
    });

    const head = createNode('div', { className: 'calendar-day-head' });
    head.appendChild(createNode('span', { text: String(day.getDate()) }));
    head.appendChild(createNode('span', { className: 'calendar-count', text: dayItems.length > 0 ? String(dayItems.length) : '' }));
    dayEl.appendChild(head);

    const itemsWrap = createNode('div', { className: 'calendar-day-items' });
    dayItems.slice(0, 3).forEach((item) => itemsWrap.appendChild(renderCalendarItemButton(item)));
    dayEl.appendChild(itemsWrap);

    grid.appendChild(dayEl);
  }

  monthBlock.appendChild(grid);
  return monthBlock;
}

function renderRangeView(days, itemsByDate) {
  const HOUR_START = 6;
  const HOUR_END = 22;
  const settings = getState().settings || {};
  const weekStyle = settings.weekStyle || 'personal';
  const workMode = weekStyle === 'work';
  const timeGrid = createNode('div', { className: 'calendar-time-grid' });
  timeGrid.style.setProperty('--calendar-cols', String(days.length));

  const todayKey = new Date().toISOString().slice(0, 10);

  const headerRow = createNode('div', { className: 'calendar-time-row calendar-time-header' });
  headerRow.appendChild(createNode('div', { className: 'calendar-time-corner', text: 'Time' }));
  days.forEach((day) => {
    const dateKey = getDateKeyFromDate(day);
    const isWeekend = day.getDay() === 0 || day.getDay() === 6;
    const cls = `calendar-time-day-head ${dateKey === todayKey ? 'today' : ''}`;
    const nextClass = workMode && isWeekend ? `${cls} weekend-muted` : cls;
    headerRow.appendChild(
      createNode(
        'button',
        {
          className: nextClass,
          dataset: {
            action: 'calendar-select-day',
            date: dateKey
          }
        },
        [
          createNode('strong', { text: day.toLocaleDateString(undefined, { weekday: 'short' }) }),
          createNode('span', { text: day.toLocaleDateString() })
        ]
      )
    );
  });
  timeGrid.appendChild(headerRow);

  const allDayRow = createNode('div', { className: 'calendar-time-row calendar-time-all-day' });
  allDayRow.appendChild(createNode('div', { className: 'calendar-time-hour-label', text: 'All-day' }));
  days.forEach((day) => {
    const dateKey = getDateKeyFromDate(day);
    const isWeekend = day.getDay() === 0 || day.getDay() === 6;
    const items = (itemsByDate[dateKey] || []).filter((item) => item.isAllDay);
    const allDayClasses = ['calendar-time-cell'];
    if (dateKey === todayKey) allDayClasses.push('today');
    if (workMode && isWeekend) allDayClasses.push('weekend-muted');
    const cell = createNode('div', { className: allDayClasses.join(' ') });
    const stack = createNode('div', { className: 'calendar-time-items' });
    if (items.length === 0) {
      stack.appendChild(createNode('span', { className: 'calendar-time-empty', text: '—' }));
    } else {
      items.slice(0, 3).forEach((item) => {
        stack.appendChild(
          createNode('button', {
            className: `calendar-time-item calendar-item-${item.type}`,
            dataset: {
              action: 'calendar-open-item',
              itemType: item.type,
              itemId: item.id
            },
            text: sanitizeUserText(item.title) || '(Untitled)'
          })
        );
      });
    }
    cell.appendChild(stack);
    allDayRow.appendChild(cell);
  });
  timeGrid.appendChild(allDayRow);

  for (let hour = HOUR_START; hour <= HOUR_END; hour += 1) {
    const row = createNode('div', { className: 'calendar-time-row' });
    const label = hour === 12 ? '12 PM' : hour > 12 ? `${hour - 12} PM` : `${hour} AM`;
    row.appendChild(createNode('div', { className: 'calendar-time-hour-label', text: label }));

    days.forEach((day) => {
      const dateKey = getDateKeyFromDate(day);
      const isWeekend = day.getDay() === 0 || day.getDay() === 6;
      const isOffHours = hour < 8 || hour > 17;
      const items = (itemsByDate[dateKey] || []).filter((item) => !item.isAllDay && Number(item.hour) === hour);
      const classes = ['calendar-time-cell'];
      if (dateKey === todayKey) classes.push('today');
      if (workMode && isWeekend) classes.push('weekend-muted');
      else if (workMode && isOffHours) classes.push('offhours-muted');
      const cell = createNode('div', { className: classes.join(' ') });
      const stack = createNode('div', { className: 'calendar-time-items' });
      items.slice(0, 2).forEach((item) => {
        const minute = Number(item.minute || 0);
        const timeLabel = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
        stack.appendChild(
          createNode('button', {
            className: `calendar-time-item calendar-item-${item.type}`,
            dataset: {
              action: 'calendar-open-item',
              itemType: item.type,
              itemId: item.id
            },
            text: `${timeLabel} ${sanitizeUserText(item.title) || '(Untitled)'}`
          })
        );
      });
      cell.appendChild(stack);
      row.appendChild(cell);
    });

    timeGrid.appendChild(row);
  }

  return timeGrid;
}

function updateGrowthTree() {
  const state = getState();
  let total = 0;
  let done = 0;

  state.habits.forEach((habit) => {
    const counts = getHabitWeeklyCounts(habit);
    total += counts.total;
    done += counts.done;
  });

  const rate = total > 0 ? Math.round((done / total) * 100) : 0;

  const compRateEl = document.getElementById('comp-rate');
  if (compRateEl) {
    compRateEl.textContent = `${rate}%`;
    compRateEl.classList.toggle('perfect-score', rate === 100);
  }

  const treeContainer = document.querySelector('.tree-container');
  if (treeContainer) {
    treeContainer.style.setProperty('--tree-rate', String(rate / 100));
  }

  const progressRing = document.querySelector('.tree-progress-ring');
  if (progressRing) {
    const radius = Number(progressRing.getAttribute('r') || 56);
    const circumference = 2 * Math.PI * radius;
    progressRing.style.strokeDasharray = `${circumference}`;
    progressRing.style.strokeDashoffset = `${circumference * (1 - rate / 100)}`;
  }

  document.querySelectorAll('.tree-flower').forEach((flower) => {
    const threshold = Number(flower.dataset.threshold || 95);
    const visible = rate >= threshold;
    flower.classList.toggle('blooming', visible);
    flower.style.opacity = visible ? '1' : '0';
    flower.style.transform = visible ? 'scale(1)' : 'scale(0.2)';
  });

  document.querySelectorAll('.tree-branch').forEach((branch, idx) => {
    const threshold = Number(branch.dataset.threshold || idx * 11 + 8);
    const visible = rate >= threshold;
    branch.style.opacity = visible ? '1' : '0.18';
    branch.style.transform = visible ? 'scale(1)' : 'scale(0.94)';
  });

  document.querySelectorAll('.tree-leaf').forEach((leaf, idx) => {
    const threshold = Number(leaf.dataset.threshold || 16 + idx * 7);
    const visible = rate >= threshold;
    leaf.style.opacity = visible ? '1' : '0';
    leaf.style.transform = visible ? 'scale(1)' : 'scale(0.25)';
  });

  document.querySelectorAll('.tree-canopy').forEach((canopy, idx) => {
    const threshold = Number(canopy.dataset.threshold || idx * 22);
    canopy.style.opacity = rate >= threshold ? '1' : '0.3';
  });
}

function renderTasks() {
  const container = document.getElementById('page-tasks');
  if (!container) return;

  container.replaceChildren();

  if (getState().ui?.syncPending) {
    const header = createNode('div', { className: 'page-header' }, [createNode('h1', { className: 'page-title', text: 'Task Board' })]);
    const grid = createNode('div', { className: 'skeleton-grid' });
    grid.appendChild(createNode('div', { className: 'skeleton-card' }));
    grid.appendChild(createNode('div', { className: 'skeleton-card' }));
    grid.appendChild(createNode('div', { className: 'skeleton-card' }));
    container.appendChild(header);
    container.appendChild(grid);
    return;
  }

  const state = getState();
  const { tasks } = state;
  const taskView = state.ui.taskView || 'status';
  const visibleTasks = getFilteredTaskColumns(tasks);
  const visibleFlatTasks = sortTasks(getAllTasksWithColumn(tasks).filter(filterTask));
  const totalVisible = visibleTasks.todo.length + visibleTasks.inprogress.length + visibleTasks.done.length;
  const columns = [
    { key: 'todo', title: 'To Do' },
    { key: 'inprogress', title: 'In Progress' },
    { key: 'done', title: 'Done' }
  ];

  const fragment = document.createDocumentFragment();

  const header = createNode('div', { className: 'page-header' });
  header.appendChild(createNode('h1', { className: 'page-title', text: 'Task Board' }));
  header.appendChild(createNode('button', { className: 'action-btn', dataset: { action: 'open-task-modal' }, text: '+ New Task' }));
  fragment.appendChild(header);

  const toolbar = createNode('div', { className: 'task-toolbar' });
  const toolbarHead = createNode('div', { className: 'minimal-menu-head' });
  toolbarHead.appendChild(
    createNode('button', {
      className: 'tb-btn minimal-menu-toggle',
      dataset: { action: 'toggle-task-menu' },
      text: taskMenuExpanded ? 'Hide View & Filters' : 'View & Filters'
    })
  );
  toolbarHead.appendChild(createNode('span', { className: 'task-filter-meta', text: `Showing ${totalVisible} task${totalVisible === 1 ? '' : 's'}` }));
  toolbar.appendChild(toolbarHead);

  const controlsPanel = createNode('div', { className: `minimal-menu-panel ${taskMenuExpanded ? 'open' : ''}` });

  const viewSwitch = createNode('div', { className: 'task-view-switch' });
  [
    ['status', 'Status'],
    ['list', 'List'],
    ['card', 'Card']
  ].forEach(([value, label]) => {
    const btn = createNode('button', {
      className: `tb-btn ${taskView === value ? 'active' : ''}`,
      dataset: { action: 'set-task-view', view: value },
      text: label
    });
    viewSwitch.appendChild(btn);
  });
  controlsPanel.appendChild(viewSwitch);

  const searchInput = createNode('input', {
    className: 'input-field task-filter-input',
    attrs: { placeholder: 'Search tasks...' },
    dataset: { role: 'task-filter-query' },
    value: taskFilters.query,
    type: 'text'
  });
  controlsPanel.appendChild(searchInput);

  const smartRuleInput = createNode('input', {
    className: 'input-field task-filter-input',
    attrs: { placeholder: "Smart Rule (e.g. priority === 'high' && dueDate < today)" },
    dataset: { role: 'task-smart-rule' },
    value: taskFilters.smartRule,
    type: 'text'
  });
  controlsPanel.appendChild(smartRuleInput);

  const smartViewsSelect = createNode('select', { className: 'input-field task-filter-select', dataset: { role: 'task-smart-view' } });
  smartViewsSelect.appendChild(createNode('option', { attrs: { value: 'none' }, text: 'Smart View: None' }));
  getCustomTaskViews().forEach((view) => {
    smartViewsSelect.appendChild(createNode('option', { attrs: { value: view.id }, text: `Smart View: ${view.name}` }));
  });
  smartViewsSelect.value = taskFilters.smartViewId || 'none';
  controlsPanel.appendChild(smartViewsSelect);

  controlsPanel.appendChild(createNode('button', { className: 'tb-btn', dataset: { action: 'save-smart-view' }, text: 'Save Smart View' }));

  const sortMenu = createNode('div', { className: 'task-sort-menu' });
  sortMenu.appendChild(createNode('button', { className: 'tb-btn', dataset: { action: 'toggle-sort-menu' }, text: 'Sort ▾' }));
  const sortPanel = createNode('div', { className: `task-sort-panel ${taskSortMenuOpen ? 'open' : ''}` });
  [
    ['default', 'Default'],
    ['recent', 'Recent'],
    ['due-asc', 'Due Soon'],
    ['due-desc', 'Due Later'],
    ['title', 'Title']
  ].forEach(([value, label]) => {
    sortPanel.appendChild(
      createNode('button', {
        className: `task-sort-option ${taskFilters.sort === value ? 'active' : ''}`,
        dataset: { action: 'set-task-sort', sort: value },
        text: label
      })
    );
  });
  sortMenu.appendChild(sortPanel);
  controlsPanel.appendChild(sortMenu);

  const dueSelect = createNode('select', { className: 'input-field task-filter-select', dataset: { role: 'task-filter-due' } });
  [
    ['all', 'Due: All'],
    ['today', 'Due: Today'],
    ['overdue', 'Due: Overdue'],
    ['upcoming', 'Due: Upcoming'],
    ['nodate', 'Due: No Date']
  ].forEach(([value, label]) => {
    dueSelect.appendChild(createNode('option', { attrs: { value }, text: label }));
  });
  dueSelect.value = taskFilters.due;
  controlsPanel.appendChild(dueSelect);

  controlsPanel.appendChild(createNode('button', { className: 'tb-btn', dataset: { action: 'clear-task-filters' }, text: 'Clear' }));

  toolbar.appendChild(controlsPanel);

  fragment.appendChild(toolbar);

  if (taskView === 'status') {
    const board = createNode('div', { className: 'columns-container' });
    columns.forEach((col) => {
      const colWrap = createNode('div', { className: 'column', dataset: { column: col.key } });
      const colHeader = createNode('div', { className: 'column-header' });
      colHeader.appendChild(document.createTextNode(`${col.title} `));
      colHeader.appendChild(createNode('span', { className: 'task-count', text: String(visibleTasks[col.key].length) }));
      colWrap.appendChild(colHeader);

      const cards = createNode('div', { className: 'cards', dataset: { dropCol: col.key } });
      visibleTasks[col.key].forEach((task) => cards.appendChild(createTaskCard(task, { draggable: true })));
      colWrap.appendChild(cards);
      board.appendChild(colWrap);
    });
    fragment.appendChild(board);
  }

  if (taskView === 'list') {
    const list = createNode('div', { className: 'task-list-view' });
    if (visibleFlatTasks.length === 0) {
      list.appendChild(createNode('div', { className: 'settings-row-desc', text: 'No tasks match current filters.' }));
    } else {
      visibleFlatTasks.forEach((task) => {
        const item = createNode('div', { className: 'task-list-item', dataset: { taskId: task.id } });
        const left = createNode('div');
        left.appendChild(createNode('div', { className: 'card-title', text: sanitizeUserText(task.title) || '(Untitled Task)' }));
        left.appendChild(createNode('div', { className: 'date-text', text: sanitizeUserText(task.dueDate || 'No date') }));
        item.appendChild(left);
        item.appendChild(createNode('span', { className: 'task-list-status', text: getColumnLabel(task._column) }));
        list.appendChild(item);
      });
    }
    fragment.appendChild(list);
  }

  if (taskView === 'card') {
    const grid = createNode('div', { className: 'task-card-grid' });
    if (visibleFlatTasks.length === 0) {
      grid.appendChild(createNode('div', { className: 'settings-row-desc', text: 'No tasks match current filters.' }));
    } else {
      visibleFlatTasks.forEach((task) => {
        const card = createTaskCard(task, { draggable: false });
        const meta = card.querySelector('.card-meta');
        if (meta) {
          meta.appendChild(createNode('span', { className: 'tag-badge', text: getColumnLabel(task._column) }));
        }
        grid.appendChild(card);
      });
    }
    fragment.appendChild(grid);
  }

  container.appendChild(fragment);

  if (taskView === 'status') {
    setupTaskDnD();
  }
}

function renderHabits() {
  const container = document.getElementById('page-habits');
  if (!container) return;

  container.replaceChildren();

  const { habits } = getState();

  const fragment = document.createDocumentFragment();

  const header = createNode('div', { className: 'page-header' });
  header.appendChild(createNode('h1', { className: 'page-title', text: 'Habits' }));
  header.appendChild(createNode('button', { className: 'action-btn', dataset: { action: 'open-habit-modal' }, text: '+ New Habit' }));
  fragment.appendChild(header);

  const treeContainer = createNode('div', { className: 'tree-container' });
  treeContainer.appendChild(
    createNode('h3', {
      attrs: {
        style: 'font-size:.8em;text-transform:uppercase;letter-spacing:1.5px;color:var(--muted);font-weight:600;margin-bottom:4px'
      },
      text: 'Weekly Progress'
    })
  );

  const svgNs = 'http://www.w3.org/2000/svg';
  const treeSvg = document.createElementNS(svgNs, 'svg');
  treeSvg.setAttribute('class', 'tree-svg');
  treeSvg.setAttribute('viewBox', '0 0 200 200');

  const ground = document.createElementNS(svgNs, 'ellipse');
  ground.setAttribute('class', 'tree-ground');
  ground.setAttribute('cx', '100');
  ground.setAttribute('cy', '186');
  ground.setAttribute('rx', '62');
  ground.setAttribute('ry', '10');
  treeSvg.appendChild(ground);

  const progressTrack = document.createElementNS(svgNs, 'circle');
  progressTrack.setAttribute('class', 'tree-progress-track');
  progressTrack.setAttribute('cx', '100');
  progressTrack.setAttribute('cy', '90');
  progressTrack.setAttribute('r', '56');
  treeSvg.appendChild(progressTrack);

  const progressRing = document.createElementNS(svgNs, 'circle');
  progressRing.setAttribute('class', 'tree-progress-ring');
  progressRing.setAttribute('cx', '100');
  progressRing.setAttribute('cy', '90');
  progressRing.setAttribute('r', '56');
  treeSvg.appendChild(progressRing);

  const canopyGroup = document.createElementNS(svgNs, 'g');
  [
    ['100', '84', '45', '8'],
    ['72', '96', '30', '28'],
    ['128', '96', '30', '48'],
    ['100', '62', '26', '66']
  ].forEach(([cx, cy, r, threshold]) => {
    const c = document.createElementNS(svgNs, 'circle');
    c.setAttribute('class', 'tree-canopy');
    c.setAttribute('cx', cx);
    c.setAttribute('cy', cy);
    c.setAttribute('r', r);
    c.dataset.threshold = threshold;
    canopyGroup.appendChild(c);
  });
  treeSvg.appendChild(canopyGroup);

  const trunk = document.createElementNS(svgNs, 'path');
  trunk.setAttribute('class', 'tree-trunk');
  trunk.setAttribute('d', 'M92 152 Q100 142 108 152 L112 187 Q100 193 88 187 Z');
  treeSvg.appendChild(trunk);

  const roots = document.createElementNS(svgNs, 'path');
  roots.setAttribute('class', 'tree-roots');
  roots.setAttribute('d', 'M88 184 Q74 188 64 182 M112 184 Q126 188 136 182 M95 187 Q100 192 105 187');
  treeSvg.appendChild(roots);

  const branchesGroup = document.createElementNS(svgNs, 'g');
  [
    ['M100 150 Q84 133 62 116', '4', '10'],
    ['M100 150 Q116 133 138 116', '4', '20'],
    ['M100 138 Q92 116 84 92', '3', '30'],
    ['M100 138 Q108 116 116 92', '3', '40'],
    ['M84 122 Q74 108 66 94', '2.2', '52'],
    ['M116 122 Q126 108 134 94', '2.2', '64']
  ].forEach(([d, width, threshold]) => {
    const path = document.createElementNS(svgNs, 'path');
    path.setAttribute('class', 'tree-branch');
    path.setAttribute('d', d);
    path.setAttribute('stroke-width', width);
    path.setAttribute('fill', 'none');
    path.dataset.threshold = threshold;
    branchesGroup.appendChild(path);
  });
  treeSvg.appendChild(branchesGroup);

  const leavesGroup = document.createElementNS(svgNs, 'g');
  [
    ['62', '116', '8', '22'],
    ['138', '116', '8', '30'],
    ['84', '90', '7', '40'],
    ['116', '90', '7', '48'],
    ['67', '96', '6', '56'],
    ['133', '96', '6', '64'],
    ['94', '72', '7', '72'],
    ['106', '72', '7', '80'],
    ['79', '106', '6', '86'],
    ['121', '106', '6', '90']
  ].forEach(([cx, cy, r, threshold]) => {
    const c = document.createElementNS(svgNs, 'circle');
    c.setAttribute('class', 'tree-leaf');
    c.setAttribute('cx', cx);
    c.setAttribute('cy', cy);
    c.setAttribute('r', r);
    c.dataset.threshold = threshold;
    leavesGroup.appendChild(c);
  });
  treeSvg.appendChild(leavesGroup);

  const flowersGroup = document.createElementNS(svgNs, 'g');
  [
    ['60', '106', '3.5', '92'],
    ['140', '106', '3.5', '94'],
    ['100', '58', '4.6', '96'],
    ['84', '80', '3.2', '98'],
    ['116', '80', '3.2', '99']
  ].forEach(([cx, cy, r, threshold]) => {
    const c = document.createElementNS(svgNs, 'circle');
    c.setAttribute('class', 'tree-flower');
    c.setAttribute('cx', cx);
    c.setAttribute('cy', cy);
    c.setAttribute('r', r);
    c.dataset.threshold = threshold;
    flowersGroup.appendChild(c);
  });
  treeSvg.appendChild(flowersGroup);

  treeContainer.appendChild(treeSvg);

  const weekly = createNode('div', {
    attrs: { style: 'margin-top:8px;color:var(--muted);font-weight:bold;font-size:1.1em;' }
  });
  weekly.appendChild(document.createTextNode('Weekly Completion: '));
  weekly.appendChild(createNode('span', { attrs: { id: 'comp-rate' }, text: '0%' }));
  treeContainer.appendChild(weekly);
  fragment.appendChild(treeContainer);

  const grid = createNode('div', { className: 'habits-grid', attrs: { id: 'habits-grid' } });
  const todayKey = new Date().toISOString().slice(0, 10);

  habits.forEach((habit, habitIdx) => {
    const dateKeys = getRecentDateKeys(7);
    const counts = getHabitWeeklyCounts(habit);

    const card = createNode('div', { className: 'habit-card', dataset: { habitId: habitIdx } });
    const hHeader = createNode('div', { className: 'habit-header' });
    const nameArea = createNode('div', { className: 'habit-name-area' });
    nameArea.appendChild(createNode('div', { className: 'habit-name', text: sanitizeUserText(habit.name) || '(Untitled Habit)' }));
    nameArea.appendChild(createNode('div', { className: 'habit-category', text: sanitizeUserText(habit.category || 'Other') }));
    hHeader.appendChild(nameArea);

    const badges = createNode('div', { className: 'habit-badges' });
    badges.appendChild(createNode('span', { className: 'habit-streak', text: `🔥 ${counts.done}/${counts.total}` }));
    hHeader.appendChild(badges);
    card.appendChild(hHeader);

    const historyGrid = createNode('div', { className: 'habit-history-grid' });
    dateKeys.forEach((dateKey) => {
      const state = getHabitStateByDate(habit, dateKey);
      const cls = ['day-checkbox', 'history-cell'];
      if (state === 'done') cls.push('history-done');
      else if (state === 'skipped') cls.push('history-skipped');
      else cls.push('history-missed');
      if (dateKey === todayKey) cls.push('today');

      historyGrid.appendChild(
        createNode('button', {
          className: cls.join(' '),
          dataset: {
            role: 'habit-history-day',
            id: habitIdx,
            date: dateKey
          },
          attrs: {
            title: dateKey
          },
          text: formatShortDayLabel(dateKey)
        })
      );
    });
    card.appendChild(historyGrid);

    const actions = createNode('div', { className: 'habit-actions-row' });
    actions.appendChild(createNode('button', { className: 'tb-btn', dataset: { action: 'open-habit-reflection', id: habitIdx }, text: '📝' }));
    actions.appendChild(createNode('button', { className: 'tb-btn', dataset: { action: 'toggle-habit-skip-today', id: habitIdx }, text: 'Skip' }));
    actions.appendChild(createNode('button', { className: 'tb-btn', dataset: { action: 'open-habit-modal', id: habitIdx }, text: 'Edit' }));
    card.appendChild(actions);

    grid.appendChild(card);
  });

  fragment.appendChild(grid);
  container.appendChild(fragment);

  updateGrowthTree();
}

function renderNotes() {
  const container = document.getElementById('page-notes');
  if (!container) return;

  container.replaceChildren();

  const { notes } = getState();

  const header = createNode('div', { className: 'page-header' });
  header.appendChild(createNode('h1', { className: 'page-title', text: 'Notes' }));
  header.appendChild(createNode('button', { className: 'action-btn', dataset: { action: 'open-note-modal' }, text: '+ New Note' }));
  container.appendChild(header);

  const grid = createNode('div', { className: 'notes-masonry', attrs: { id: 'notes-grid' } });
  notes.forEach((note) => {
    const background = sanitizeUserText(note.color || NOTE_COLORS[0]);
    const textColor = getReadableTextColor(background);
    const card = createNode('div', {
      className: 'note-card',
      dataset: { noteId: note.id }
    });
    card.style.background = background;
    card.style.color = textColor;
    card.appendChild(createNode('div', { className: 'note-title', text: sanitizeUserText(note.title || '(Untitled)') }));
    card.appendChild(createNode('div', { className: 'note-body', text: sanitizeUserText(note.body || '') }));
    grid.appendChild(card);
  });

  container.appendChild(grid);
}

function renderCalendar() {
  const container = document.getElementById('page-calendar');
  if (!container) return;

  container.replaceChildren();

  const allItems = getCalendarItems();
  const categories = getCalendarCategories(allItems);
  const visibleItems = filterCalendarItems(allItems);
  const itemsByDate = buildItemsByDate(visibleItems);
  const selectedItems = itemsByDate[calendarSelectedDateKey] || [];

  const fragment = document.createDocumentFragment();

  const header = createNode('div', { className: 'page-header' });
  header.appendChild(createNode('h1', { className: 'page-title', text: 'Calendar' }));
  const nav = createNode('div', { className: 'calendar-nav' });
  nav.appendChild(createNode('button', { className: 'tb-btn', dataset: { action: 'calendar-prev' }, text: '←' }));
  nav.appendChild(createNode('button', { className: 'tb-btn', dataset: { action: 'calendar-today' }, text: 'Today' }));
  nav.appendChild(createNode('button', { className: 'tb-btn', dataset: { action: 'calendar-next' }, text: '→' }));
  header.appendChild(nav);
  fragment.appendChild(header);

  const wrap = createNode('div', { className: 'calendar-wrap' });
  const toolbar = createNode('div', { className: 'calendar-toolbar' });

  const calendarHead = createNode('div', { className: 'minimal-menu-head' });
  calendarHead.appendChild(
    createNode('button', {
      className: 'tb-btn minimal-menu-toggle',
      dataset: { action: 'toggle-calendar-menu' },
      text: calendarMenuExpanded ? 'Hide View & Filters' : 'View & Filters'
    })
  );
  calendarHead.appendChild(createNode('span', { className: 'task-filter-meta', text: `View: ${calendarView}` }));
  toolbar.appendChild(calendarHead);

  const calendarControls = createNode('div', { className: `minimal-menu-panel ${calendarMenuExpanded ? 'open' : ''}` });

  const viewSwitch = createNode('div', { className: 'calendar-view-switch' });
  [
    ['day', 'Day'],
    ['3day', '3 Day'],
    ['workweek', 'Work Week'],
    ['7day', '7 Day'],
    ['month', 'Month'],
    ['3month', '3 Month'],
    ['6month', '6 Month']
  ].forEach(([value, label]) => {
    viewSwitch.appendChild(
      createNode('button', {
        className: `tb-btn ${calendarView === value ? 'active' : ''}`,
        dataset: { action: 'calendar-set-view', value },
        text: label
      })
    );
  });
  calendarControls.appendChild(viewSwitch);

  const filterRow = createNode('div', { className: 'calendar-filter-row' });
  [
    ['task', 'Task', calendarFilters.task],
    ['habit', 'Habit', calendarFilters.habit],
    ['other', 'Other', calendarFilters.other]
  ].forEach(([type, label, checked]) => {
    const cb = createNode('input', {
      type: 'checkbox',
      dataset: { role: 'calendar-filter-type', type }
    });
    cb.checked = Boolean(checked);
    const labelEl = createNode('label', {}, [cb, ` ${label}`]);
    filterRow.appendChild(labelEl);
  });

  const categorySelect = createNode('select', { className: 'input-field task-filter-select', dataset: { role: 'calendar-filter-category' } });
  categories.forEach((category) => {
    const label = category === 'all' ? 'All Categories' : category;
    categorySelect.appendChild(createNode('option', { attrs: { value: category }, text: label }));
  });
  categorySelect.value = calendarFilters.category;
  filterRow.appendChild(categorySelect);

  calendarControls.appendChild(filterRow);
  toolbar.appendChild(calendarControls);
  wrap.appendChild(toolbar);

  if (calendarView === 'month') {
    const monthStart = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth(), 1);
    wrap.appendChild(renderMonthGrid(monthStart, itemsByDate, calendarSelectedDateKey));
  }

  if (calendarView === '3month' || calendarView === '6month') {
    const count = calendarView === '3month' ? 3 : 6;
    const start = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth(), 1);
    const multi = createNode('div', { className: 'calendar-multi-month' });
    for (let idx = 0; idx < count; idx += 1) {
      const month = new Date(start.getFullYear(), start.getMonth() + idx, 1);
      multi.appendChild(renderMonthGrid(month, itemsByDate, calendarSelectedDateKey));
    }
    wrap.appendChild(multi);
  }

  if (calendarView === 'day' || calendarView === '3day' || calendarView === 'workweek' || calendarView === '7day') {
    wrap.appendChild(renderRangeView(getCalendarRangeDays(), itemsByDate));
  }

  const agenda = createNode('div', { className: 'calendar-agenda' });
  agenda.appendChild(createNode('div', { className: 'calendar-agenda-title', text: `Items on ${calendarSelectedDateKey}` }));
  const agendaList = createNode('div', { className: 'calendar-agenda-list' });
  if (selectedItems.length === 0) {
    agendaList.appendChild(createNode('div', { className: 'settings-row-desc', text: 'No items for selected date.' }));
  } else {
    selectedItems.forEach((item) => {
      const row = createNode('button', {
        className: `calendar-agenda-item calendar-item-${item.type}`,
        dataset: {
          action: 'calendar-open-item',
          itemType: item.type,
          itemId: item.id
        }
      });
      row.appendChild(createNode('span', { text: sanitizeUserText(item.title) || '(Untitled)' }));
      row.appendChild(createNode('span', { text: `${sanitizeUserText(item.meta)} • ${sanitizeUserText(item.category || 'General')}` }));
      agendaList.appendChild(row);
    });
  }
  agenda.appendChild(agendaList);
  wrap.appendChild(agenda);

  fragment.appendChild(wrap);
  container.appendChild(fragment);
}

function renderInsights() {
  const container = document.getElementById('page-insights');
  if (!container) return;

  container.replaceChildren();
  const state = getState();
  const allTasks = getAllTasksWithColumn(state.tasks);
  const totalTasks = allTasks.length;
  const doneTasks = state.tasks.done.length;
  const openTasks = totalTasks - doneTasks;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const dueToday = allTasks.filter((task) => {
    const due = getTaskDueDate(task);
    return due && getStartOfDay(due).getTime() === today.getTime();
  }).length;

  const overdue = allTasks.filter((task) => {
    if (task._column === 'done') return false;
    const due = getTaskDueDate(task);
    return due && getStartOfDay(due).getTime() < today.getTime();
  }).length;

  let habitDone = 0;
  let habitTotal = 0;
  state.habits.forEach((habit) => {
    const counts = getHabitWeeklyCounts(habit);
    habitDone += counts.done;
    habitTotal += counts.total;
  });
  const habitRate = habitTotal > 0 ? Math.round((habitDone / habitTotal) * 100) : 0;

  const completionRate = totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0;
  const notesCount = state.notes.length;

  const upcomingTasks = allTasks
    .filter((task) => task._column !== 'done' && task.dueDate)
    .sort((a, b) => getTaskSortValue(a) - getTaskSortValue(b))
    .slice(0, 6);

  const habitMomentum = state.habits
    .map((habit) => {
      const counts = getHabitWeeklyCounts(habit);
      const rate = counts.total > 0 ? Math.round((counts.done / counts.total) * 100) : 0;
      return {
        name: habit.name || '(Untitled Habit)',
        category: habit.category || 'Other',
        done: counts.done,
        total: counts.total,
        rate
      };
    })
    .sort((a, b) => b.rate - a.rate)
    .slice(0, 6);

  const trendDaysBack = insightsTrendDays === 30 ? 29 : 6;
  const recentKeys = getRecentDateKeys(trendDaysBack);
  const dateLabel = (dateKey) => {
    const date = new Date(`${dateKey}T00:00:00`);
    return date.toLocaleDateString(undefined, { weekday: 'short' });
  };

  const openTaskLoadSeries = recentKeys.map((dateKey) => {
    const count = allTasks.filter((task) => task._column !== 'done' && task.dueDate === dateKey).length;
    return { dateKey, value: count };
  });

  const habitChecksSeries = recentKeys.map((dateKey) => {
    const count = state.habits.reduce((sum, habit) => {
      return sum + (getHabitStateByDate(habit, dateKey) === 'done' ? 1 : 0);
    }, 0);
    return { dateKey, value: count };
  });

  const notesCaptureSeries = recentKeys.map((dateKey) => {
    const count = state.notes.reduce((sum, note) => {
      const ts = Number(note.id);
      if (!Number.isFinite(ts) || ts <= 0) return sum;
      const key = getDateKeyFromDate(new Date(ts));
      return sum + (key === dateKey ? 1 : 0);
    }, 0);
    return { dateKey, value: count };
  });

  const trendWindowLabel = insightsTrendDays === 30 ? 'last 30 days' : 'last 7 days';

  const createTrendCard = (title, subtitle, series) => {
    const card = createNode('section', { className: 'insight-card' });
    card.appendChild(createNode('h3', { text: title }));
    card.appendChild(createNode('div', { className: 'insight-meta', text: subtitle }));

    const chart = createNode('div', { className: 'insight-trend-chart' });
    const maxVal = Math.max(1, ...series.map((point) => Number(point.value || 0)));

    series.forEach((point) => {
      const barWrap = createNode('div', { className: 'insight-trend-point' });
      const bar = createNode('div', {
        className: 'insight-trend-bar',
        attrs: { title: `${dateLabel(point.dateKey)}: ${point.value}` }
      });
      bar.style.setProperty('--bar-h', `${Math.max(8, Math.round((Number(point.value || 0) / maxVal) * 54))}px`);
      bar.appendChild(createNode('span', { className: 'insight-trend-fill' }));
      barWrap.appendChild(bar);
      barWrap.appendChild(createNode('span', { className: 'insight-trend-label', text: dateLabel(point.dateKey) }));
      chart.appendChild(barWrap);
    });

    card.appendChild(chart);
    return card;
  };

  const header = createNode('div', { className: 'page-header' });
  header.appendChild(createNode('h1', { className: 'page-title', text: 'Insights' }));
  container.appendChild(header);

  const statGrid = createNode('div', { className: 'insights-grid' });
  [
    ['Task Completion', `${completionRate}%`, `${doneTasks}/${totalTasks || 0} tasks done`],
    ['Open Tasks', String(openTasks), overdue > 0 ? `${overdue} overdue` : 'No overdue tasks'],
    ['Due Today', String(dueToday), dueToday > 0 ? 'Focus window today' : 'Nothing due today'],
    ['Habit Consistency', `${habitRate}%`, `${habitDone}/${habitTotal || 0} weekly checks`],
    ['Notes Captured', String(notesCount), notesCount > 0 ? 'Knowledge base growing' : 'No notes yet']
  ].forEach(([label, value, meta]) => {
    const card = createNode('section', { className: 'insight-card' });
    card.appendChild(createNode('div', { className: 'insight-label', text: label }));
    card.appendChild(createNode('div', { className: 'insight-value', text: value }));
    card.appendChild(createNode('div', { className: 'insight-meta', text: meta }));
    statGrid.appendChild(card);
  });
  container.appendChild(statGrid);

  const trendHeader = createNode('div', { className: 'insights-trend-head' });
  trendHeader.appendChild(createNode('h3', { text: 'Trends' }));
  const trendRangeSwitch = createNode('div', { className: 'insights-trend-switch' });
  trendRangeSwitch.appendChild(
    createNode('button', {
      className: `tb-btn ${insightsTrendDays === 7 ? 'active' : ''}`,
      dataset: { action: 'insights-set-trend-range', days: '7' },
      text: '7D'
    })
  );
  trendRangeSwitch.appendChild(
    createNode('button', {
      className: `tb-btn ${insightsTrendDays === 30 ? 'active' : ''}`,
      dataset: { action: 'insights-set-trend-range', days: '30' },
      text: '30D'
    })
  );
  trendHeader.appendChild(trendRangeSwitch);
  container.appendChild(trendHeader);

  const trendGrid = createNode('div', { className: 'insights-trend-grid' });
  trendGrid.appendChild(createTrendCard('Open Task Load', `Open tasks due each day (${trendWindowLabel})`, openTaskLoadSeries));
  trendGrid.appendChild(createTrendCard('Habit Checks', `Completed habit check-ins per day (${trendWindowLabel})`, habitChecksSeries));
  trendGrid.appendChild(createTrendCard('Notes Capture', `Notes created per day (${trendWindowLabel})`, notesCaptureSeries));
  container.appendChild(trendGrid);

  const detailGrid = createNode('div', { className: 'insights-detail-grid' });

  const upcomingCard = createNode('section', { className: 'insight-card' });
  upcomingCard.appendChild(createNode('h3', { text: 'Upcoming Tasks' }));
  const upcomingList = createNode('div', { className: 'insight-list' });
  if (upcomingTasks.length === 0) {
    upcomingList.appendChild(createNode('div', { className: 'settings-row-desc', text: 'No upcoming dated tasks.' }));
  } else {
    upcomingTasks.forEach((task) => {
      const row = createNode('button', {
        className: 'insight-list-row',
        dataset: { action: 'insight-open-task', id: String(task.id) }
      });
      row.appendChild(createNode('strong', { text: sanitizeUserText(task.title) || '(Untitled Task)' }));
      row.appendChild(createNode('span', { text: `${sanitizeUserText(task.dueDate || 'No date')} • ${getColumnLabel(task._column)}` }));
      upcomingList.appendChild(row);
    });
  }
  upcomingCard.appendChild(upcomingList);
  detailGrid.appendChild(upcomingCard);

  const habitsCard = createNode('section', { className: 'insight-card' });
  habitsCard.appendChild(createNode('h3', { text: 'Habit Momentum' }));
  const habitsList = createNode('div', { className: 'insight-list' });
  if (habitMomentum.length === 0) {
    habitsList.appendChild(createNode('div', { className: 'settings-row-desc', text: 'Add habits to unlock momentum insights.' }));
  } else {
    habitMomentum.forEach((item) => {
      const row = createNode('div', { className: 'insight-list-row static' });
      row.appendChild(createNode('strong', { text: sanitizeUserText(item.name) }));
      row.appendChild(createNode('span', { text: `${item.rate}% • ${item.done}/${item.total || 0} • ${sanitizeUserText(item.category)}` }));
      habitsList.appendChild(row);
    });
  }
  habitsCard.appendChild(habitsList);
  detailGrid.appendChild(habitsCard);

  container.appendChild(detailGrid);
}

function renderSettings() {
  const container = document.getElementById('page-settings');
  if (!container) return;

  container.replaceChildren();

  const state = getState();
  const settings = state.settings || {};
  const tzCurrent = settings.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const fragment = document.createDocumentFragment();

  const header = createNode('div', { className: 'page-header' });
  header.appendChild(createNode('h1', { className: 'page-title', text: 'Settings' }));
  header.appendChild(createNode('button', { className: 'action-btn', dataset: { action: 'settings-sync-now' }, text: 'Sync Now' }));
  fragment.appendChild(header);

  const stack = createNode('div', { className: 'settings-stack' });

  const appearance = createNode('section', { className: 'settings-card' });
  appearance.appendChild(createNode('h3', { text: 'Appearance' }));
  const appearanceGrid = createNode('div', { className: 'settings-grid' });

  const themeField = createNode('label', { className: 'settings-field' }, ['Theme']);
  const themeSelect = createNode('select', { className: 'input-field', dataset: { role: 'settings-theme' } });
  [
    ['light', 'Light'],
    ['dark', 'Dark'],
    ['system', 'System'],
    ['the-w', 'The W'],
    ['christmas', 'Christmas'],
    ['aurora', 'Aurora']
  ].forEach(([value, label]) => {
    themeSelect.appendChild(createNode('option', { attrs: { value }, text: label }));
  });
  themeSelect.value = settings.theme || 'light';
  themeField.appendChild(themeSelect);
  appearanceGrid.appendChild(themeField);

  const accentField = createNode('label', { className: 'settings-field' }, ['Accent Color']);
  const accentInput = createNode('input', {
    className: 'input-field',
    dataset: { role: 'settings-accent' },
    type: 'color',
    value: settings.accent || '#d4a373'
  });
  accentField.appendChild(accentInput);
  appearanceGrid.appendChild(accentField);

  const accentDarkField = createNode('label', { className: 'settings-field' }, ['Accent Dark']);
  const accentDarkInput = createNode('input', {
    className: 'input-field',
    dataset: { role: 'settings-accent-dark' },
    type: 'color',
    value: settings.accentDark || '#c49363'
  });
  accentDarkField.appendChild(accentDarkInput);
  appearanceGrid.appendChild(accentDarkField);

  const compactCheckbox = createNode('input', { type: 'checkbox', dataset: { role: 'settings-compact' } });
  compactCheckbox.checked = Boolean(settings.compact);
  appearanceGrid.appendChild(createNode('label', { className: 'settings-check' }, [compactCheckbox, ' Compact Layout']));
  appearance.appendChild(appearanceGrid);
  stack.appendChild(appearance);

  const calendarTime = createNode('section', { className: 'settings-card' });
  calendarTime.appendChild(createNode('h3', { text: 'Calendar & Time' }));
  const calendarGrid = createNode('div', { className: 'settings-grid' });

  const tzField = createNode('label', { className: 'settings-field' }, ['Time Zone']);
  const tzSelect = createNode('select', { className: 'input-field', dataset: { role: 'settings-timezone' } });
  SETTINGS_TIME_ZONES.forEach((tz) => {
    tzSelect.appendChild(createNode('option', { attrs: { value: tz }, text: tz }));
  });
  tzSelect.value = tzCurrent;
  tzField.appendChild(tzSelect);
  calendarGrid.appendChild(tzField);

  const firstDayField = createNode('label', { className: 'settings-field' }, ['First Day of Week']);
  const firstDaySelect = createNode('select', { className: 'input-field', dataset: { role: 'settings-firstday' } });
  firstDaySelect.appendChild(createNode('option', { attrs: { value: 'mon' }, text: 'Monday' }));
  firstDaySelect.appendChild(createNode('option', { attrs: { value: 'sun' }, text: 'Sunday' }));
  firstDaySelect.value = settings.firstday || 'mon';
  firstDayField.appendChild(firstDaySelect);
  calendarGrid.appendChild(firstDayField);

  const weekStyleField = createNode('label', { className: 'settings-field' }, ['Week Style']);
  const weekStyleSelect = createNode('select', { className: 'input-field', dataset: { role: 'settings-week-style' } });
  weekStyleSelect.appendChild(createNode('option', { attrs: { value: 'personal' }, text: 'Personal Week' }));
  weekStyleSelect.appendChild(createNode('option', { attrs: { value: 'work' }, text: 'Work Week (grey non-work hours)' }));
  weekStyleSelect.value = settings.weekStyle || 'personal';
  weekStyleField.appendChild(weekStyleSelect);
  calendarGrid.appendChild(weekStyleField);

  calendarTime.appendChild(calendarGrid);
  stack.appendChild(calendarTime);

  const behavior = createNode('section', { className: 'settings-card' });
  behavior.appendChild(createNode('h3', { text: 'Behavior' }));
  const behaviorGrid = createNode('div', { className: 'settings-grid' });

  const autolockCheckbox = createNode('input', { type: 'checkbox', dataset: { role: 'settings-autolock' } });
  autolockCheckbox.checked = Boolean(settings.autolock);
  behaviorGrid.appendChild(createNode('label', { className: 'settings-check' }, [autolockCheckbox, ' Auto-lock']));

  const fireworksCheckbox = createNode('input', { type: 'checkbox', dataset: { role: 'settings-fireworks' } });
  fireworksCheckbox.checked = Boolean(settings.fireworks);
  behaviorGrid.appendChild(createNode('label', { className: 'settings-check' }, [fireworksCheckbox, ' Fireworks Effects']));

  behavior.appendChild(behaviorGrid);
  stack.appendChild(behavior);

  const cloud = createNode('section', { className: 'settings-card' });
  cloud.appendChild(createNode('h3', { text: 'Cloud' }));
  const cloudGrid = createNode('div', { className: 'settings-grid' });

  const urlField = createNode('label', { className: 'settings-field settings-wide' }, ['Supabase URL']);
  urlField.appendChild(
    createNode('input', {
      className: 'input-field',
      dataset: { role: 'settings-supabase-url' },
      type: 'text',
      value: settings.supabaseUrl || '',
      attrs: { placeholder: 'https://...supabase.co' }
    })
  );
  cloudGrid.appendChild(urlField);

  const keyField = createNode('label', { className: 'settings-field settings-wide' }, ['Supabase Anon Key']);
  keyField.appendChild(
    createNode('input', {
      className: 'input-field',
      dataset: { role: 'settings-supabase-key' },
      type: 'password',
      value: settings.supabaseAnonKey || '',
      attrs: { placeholder: 'sb_publishable_...' }
    })
  );
  cloudGrid.appendChild(keyField);

  const pushKeyField = createNode('label', { className: 'settings-field settings-wide' }, ['Push VAPID Public Key']);
  pushKeyField.appendChild(
    createNode('input', {
      className: 'input-field',
      dataset: { role: 'settings-push-public-key' },
      type: 'text',
      value: settings.pushPublicKey || '',
      attrs: { placeholder: 'BEl... (Base64URL public key)' }
    })
  );
  cloudGrid.appendChild(pushKeyField);

  const googleAuthCheckbox = createNode('input', { type: 'checkbox', dataset: { role: 'settings-google-auth' } });
  googleAuthCheckbox.checked = Boolean(settings.googleAuthEnabled);
  cloudGrid.appendChild(createNode('label', { className: 'settings-check' }, [googleAuthCheckbox, ' Google Auth Enabled']));

  cloud.appendChild(cloudGrid);
  stack.appendChild(cloud);

  const account = createNode('section', { className: 'settings-card' });
  account.appendChild(createNode('h3', { text: 'Account & Data' }));
  const actions = createNode('div', { className: 'settings-actions' });
  actions.appendChild(createNode('button', { className: 'tb-btn', dataset: { action: 'settings-signout' }, text: 'Sign Out' }));
  actions.appendChild(createNode('button', { className: 'tb-btn', dataset: { action: 'settings-export' }, text: 'Export Backup' }));
  actions.appendChild(createNode('button', { className: 'tb-btn', dataset: { action: 'settings-export-csv' }, text: 'Export to CSV' }));
  actions.appendChild(createNode('button', { className: 'tb-btn', dataset: { action: 'settings-import' }, text: 'Import Backup' }));
  actions.appendChild(createNode('button', { className: 'tb-btn', dataset: { action: 'settings-reset-local' }, text: 'Reset Local Data' }));
  actions.appendChild(createNode('input', { dataset: { role: 'settings-import-file' }, type: 'file', attrs: { accept: 'application/json', hidden: '' } }));
  account.appendChild(actions);
  stack.appendChild(account);

  fragment.appendChild(stack);
  container.appendChild(fragment);
}

export function renderApp() {
  const state = getState();
  const view = getCurrentView();

  document.querySelectorAll('.page').forEach((pageEl) => {
    pageEl.classList.toggle('active', pageEl.id === `page-${view}`);
  });

  document.querySelectorAll('.nav-item').forEach((item) => {
    item.classList.toggle('active', item.dataset.page === view);
  });

  const titleEl = document.getElementById('topbar-title');
  if (titleEl) {
    const t = state.ui.pageTitles?.[view] || state.ui.pageTitles?.tasks || '2DoByU';
    titleEl.textContent = t;
  }

  if (view === 'tasks') renderTasks();
  if (view === 'habits') renderHabits();
  if (view === 'notes') renderNotes();
  if (view === 'calendar') renderCalendar();
  if (view === 'insights') renderInsights();
  if (view === 'settings') renderSettings();

  renderCustomViewsSidebar();
}

function ensureCustomViewsSidebarHost() {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return null;

  let host = document.getElementById('custom-views-nav');
  if (host) return host;

  host = createNode('div', { attrs: { id: 'custom-views-nav' } });
  const navList = sidebar.querySelector('.nav-list');
  if (navList) navList.insertAdjacentElement('afterend', host);
  else sidebar.appendChild(host);

  return host;
}

function renderCustomViewsSidebar() {
  const host = ensureCustomViewsSidebarHost();
  if (!host) return;

  host.replaceChildren();

  const views = getCustomTaskViews();
  if (views.length === 0) return;

  host.appendChild(createNode('div', { className: 'custom-views-title', text: 'Custom Views' }));
  const list = createNode('div', { className: 'custom-views-list' });
  views.forEach((view) => {
    list.appendChild(
      createNode('button', {
        className: `custom-view-btn ${taskFilters.smartViewId === view.id ? 'active' : ''}`,
        dataset: { action: 'apply-smart-view', id: view.id },
        text: sanitizeUserText(view.name || 'Smart View')
      })
    );
  });
  host.appendChild(list);
}

function fuzzyScore(haystack, needle) {
  const text = haystack.toLowerCase();
  const query = needle.toLowerCase().trim();
  if (!query) return 0;
  if (text.includes(query)) return query.length + 100;

  let score = 0;
  let qi = 0;
  for (let ti = 0; ti < text.length && qi < query.length; ti += 1) {
    if (text[ti] === query[qi]) {
      score += 2;
      qi += 1;
    }
  }
  return qi === query.length ? score : -1;
}

function getCommandPaletteEntries() {
  const entries = [];
  const state = getState();

  getAllTasksWithColumn(state.tasks).forEach((task) => {
    entries.push({
      id: `task-${task.id}`,
      label: `Task: ${task.title || '(Untitled Task)'}`,
      action: 'command-open-task',
      payload: { taskId: task.id }
    });
  });

  state.habits.forEach((habit, index) => {
    entries.push({
      id: `habit-${index}`,
      label: `Habit: ${habit.name || '(Untitled Habit)'}`,
      action: 'command-open-habit',
      payload: { habitId: index }
    });
  });

  state.notes.forEach((note) => {
    entries.push({
      id: `note-${note.id}`,
      label: `Note: ${note.title || '(Untitled Note)'}`,
      action: 'command-open-note',
      payload: { noteId: note.id }
    });
  });

  [
    ['Switch to Calendar', 'command-switch-view', { view: 'calendar' }],
    ['Switch to Tasks', 'command-switch-view', { view: 'tasks' }],
    ['Switch to Habits', 'command-switch-view', { view: 'habits' }],
    ['Switch to Notes', 'command-switch-view', { view: 'notes' }],
    ['Create New Task', 'command-create-task', {}],
    ['Create New Habit', 'command-create-habit', {}],
    ['Create New Note', 'command-create-note', {}]
  ].forEach(([label, action, payload], idx) => {
    entries.push({ id: `quick-${idx}`, label, action, payload });
  });

  return entries;
}

function renderCommandPalette() {
  const modal = document.getElementById('global-search-modal');
  if (!modal) return;

  const list = modal.querySelector('[data-role="command-results"]');
  if (!list) return;

  list.replaceChildren();

  const query = commandPaletteQuery.trim();
  const entries = getCommandPaletteEntries()
    .map((entry) => ({ ...entry, _score: query ? fuzzyScore(entry.label, query) : 1 }))
    .filter((entry) => entry._score >= 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, 12);

  if (entries.length === 0) {
    list.appendChild(createNode('div', { className: 'settings-row-desc', text: 'No matching commands' }));
    return;
  }

  entries.forEach((entry) => {
    list.appendChild(
      createNode('button', {
        className: 'command-item',
        dataset: {
          action: entry.action,
          commandPayload: encodeURIComponent(JSON.stringify(entry.payload || {}))
        },
        text: entry.label
      })
    );
  });
}

function openCommandPalette() {
  commandPaletteQuery = '';
  openModal('global-search-modal');

  const input = document.querySelector('[data-role="command-query"]');
  if (input) input.value = '';

  renderCommandPalette();
}

function setupTaskDnD() {
  const clearTouchDropTargets = () => {
    document.querySelectorAll('[data-drop-col]').forEach((zone) => zone.classList.remove('touch-drop-target'));
  };

  const removeTouchGhost = () => {
    if (!touchDragGhost) return;
    touchDragGhost.remove();
    touchDragGhost = null;
  };

  const positionTouchGhost = (touch) => {
    if (!touchDragGhost) return;
    touchDragGhost.style.left = `${touch.clientX + 12}px`;
    touchDragGhost.style.top = `${touch.clientY + 12}px`;
  };

  const finishTouchDrag = async () => {
    const taskId = draggingTask;
    const targetCol = touchDropColumn;

    draggingTask = null;
    touchDragging = false;
    touchDropColumn = null;
    clearTouchDropTargets();
    removeTouchGhost();

    if (!taskId || !targetCol) return;

    const moved = moveTaskToColumn(taskId, targetCol);
    if (moved) {
      triggerHapticFeedback();
      await persistSnapshot();
    }
  };

  document.querySelectorAll('.task-item').forEach((card) => {
    card.addEventListener('dragstart', (event) => {
      draggingTask = event.currentTarget.dataset.taskId;
      event.dataTransfer.effectAllowed = 'move';
    });

    card.addEventListener(
      'touchstart',
      (event) => {
        if (event.touches.length !== 1) return;

        draggingTask = event.currentTarget.dataset.taskId;
        touchDragging = true;
        touchDropColumn = null;

        touchDragGhost = event.currentTarget.cloneNode(true);
        touchDragGhost.classList.add('touch-drag-ghost');
        document.body.appendChild(touchDragGhost);
        positionTouchGhost(event.touches[0]);
      },
      { passive: true }
    );
  });

  if (!touchDnDListenersBound) {
    touchDnDListenersBound = true;

    document.addEventListener(
      'touchmove',
      (event) => {
        if (!touchDragging || !draggingTask) return;
        if (event.touches.length !== 1) return;

        event.preventDefault();

        const touch = event.touches[0];
        positionTouchGhost(touch);

        const hit = document.elementFromPoint(touch.clientX, touch.clientY);
        const dropZone = hit?.closest('[data-drop-col]');

        clearTouchDropTargets();
        touchDropColumn = null;

        if (dropZone) {
          touchDropColumn = dropZone.dataset.dropCol || null;
          dropZone.classList.add('touch-drop-target');
        }
      },
      { passive: false }
    );

    document.addEventListener('touchend', () => {
      if (!touchDragging) return;
      finishTouchDrag();
    });

    document.addEventListener('touchcancel', () => {
      if (!touchDragging) return;
      finishTouchDrag();
    });
  }

  document.querySelectorAll('[data-drop-col]').forEach((dropZone) => {
    dropZone.addEventListener('dragover', (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
    });

    dropZone.addEventListener('drop', async (event) => {
      event.preventDefault();
      const targetCol = event.currentTarget.dataset.dropCol;
      if (!draggingTask || !targetCol) return;

      const moved = moveTaskToColumn(draggingTask, targetCol);

      draggingTask = null;
      if (moved) {
        triggerHapticFeedback();
        await persistSnapshot();
      }
    });
  });
}

function ensureModals() {
  const taskModal = document.getElementById('task-modal');
  if (taskModal && !taskModal.dataset.initialized) {
    taskModal.dataset.initialized = '1';
    const wrap = createNode('div', { className: 'modal' });
    wrap.appendChild(createNode('h2', { attrs: { id: 'task-modal-title' }, text: 'Task' }));

    const group1 = createNode('div', { className: 'form-group' });
    group1.appendChild(createNode('label', { text: 'Title' }));
    group1.appendChild(createNode('input', { className: 'input-field', attrs: { id: 'task-title-input' }, type: 'text' }));
    wrap.appendChild(group1);

    const group2 = createNode('div', { className: 'form-group' });
    group2.appendChild(createNode('label', { text: 'Due Date' }));
    group2.appendChild(createNode('input', { className: 'input-field', attrs: { id: 'task-date-input' }, type: 'date' }));
    wrap.appendChild(group2);

    const footer = createNode('div', { className: 'modal-footer' });
    footer.appendChild(createNode('button', { className: 'btn btn-cancel', dataset: { action: 'close-modal', modal: 'task-modal' }, text: 'Cancel' }));
    footer.appendChild(createNode('button', { className: 'btn btn-save', dataset: { action: 'save-task-modal' }, text: 'Save' }));
    wrap.appendChild(footer);

    taskModal.replaceChildren(wrap);
  }

  const habitModal = document.getElementById('habit-modal');
  if (habitModal && !habitModal.dataset.initialized) {
    habitModal.dataset.initialized = '1';
    const wrap = createNode('div', { className: 'modal' });
    wrap.appendChild(createNode('h2', { attrs: { id: 'habit-modal-title' }, text: 'Habit' }));

    const group1 = createNode('div', { className: 'form-group' });
    group1.appendChild(createNode('label', { text: 'Name' }));
    group1.appendChild(createNode('input', { className: 'input-field', attrs: { id: 'habit-name-input' }, type: 'text' }));
    wrap.appendChild(group1);

    const group2 = createNode('div', { className: 'form-group' });
    group2.appendChild(createNode('label', { text: 'Category' }));
    group2.appendChild(createNode('input', { className: 'input-field', attrs: { id: 'habit-category-input' }, type: 'text' }));
    wrap.appendChild(group2);

    const footer = createNode('div', { className: 'modal-footer' });
    footer.appendChild(createNode('button', { className: 'btn btn-cancel', dataset: { action: 'close-modal', modal: 'habit-modal' }, text: 'Cancel' }));
    footer.appendChild(createNode('button', { className: 'btn btn-save', dataset: { action: 'save-habit-modal' }, text: 'Save' }));
    wrap.appendChild(footer);

    habitModal.replaceChildren(wrap);
  }

  const noteModal = document.getElementById('note-modal');
  if (noteModal && !noteModal.dataset.initialized) {
    noteModal.dataset.initialized = '1';
    const wrap = createNode('div', { className: 'modal' });
    wrap.appendChild(createNode('h2', { attrs: { id: 'note-modal-title' }, text: 'Note' }));

    const group1 = createNode('div', { className: 'form-group' });
    group1.appendChild(createNode('label', { text: 'Title' }));
    group1.appendChild(createNode('input', { className: 'input-field', attrs: { id: 'note-title-input' }, type: 'text' }));
    wrap.appendChild(group1);

    const group2 = createNode('div', { className: 'form-group' });
    group2.appendChild(createNode('label', { text: 'Body' }));
    group2.appendChild(createNode('textarea', { className: 'input-field', attrs: { id: 'note-body-input', rows: '5' } }));
    wrap.appendChild(group2);

    const footer = createNode('div', { className: 'modal-footer' });
    footer.appendChild(createNode('button', { className: 'btn btn-cancel', dataset: { action: 'close-modal', modal: 'note-modal' }, text: 'Cancel' }));
    footer.appendChild(createNode('button', { className: 'btn btn-save', dataset: { action: 'save-note-modal' }, text: 'Save' }));
    wrap.appendChild(footer);

    noteModal.replaceChildren(wrap);
  }

  const reflectionModal = document.getElementById('habit-reflection-modal');
  if (reflectionModal && !reflectionModal.dataset.initialized) {
    reflectionModal.dataset.initialized = '1';
    const wrap = createNode('div', { className: 'modal' });
    wrap.appendChild(createNode('h2', { text: 'Habit Reflection' }));
    wrap.appendChild(createNode('div', { className: 'settings-row-desc', attrs: { id: 'habit-reflection-label' } }));

    const group = createNode('div', { className: 'form-group' });
    group.appendChild(
      createNode('textarea', {
        className: 'input-field',
        attrs: {
          id: 'habit-reflection-input',
          rows: '5',
          placeholder: 'Write your reflection...'
        }
      })
    );
    wrap.appendChild(group);

    const footer = createNode('div', { className: 'modal-footer' });
    footer.appendChild(createNode('button', { className: 'btn btn-cancel', dataset: { action: 'close-modal', modal: 'habit-reflection-modal' }, text: 'Cancel' }));
    footer.appendChild(createNode('button', { className: 'btn btn-save', dataset: { action: 'save-habit-reflection' }, text: 'Save Reflection' }));
    wrap.appendChild(footer);

    reflectionModal.replaceChildren(wrap);
  }

  const commandModal = document.getElementById('global-search-modal');
  if (commandModal && !commandModal.dataset.initialized) {
    commandModal.dataset.initialized = '1';
    const wrap = createNode('div', { className: 'modal command-palette-modal' });
    wrap.appendChild(createNode('h2', { text: 'Command Palette' }));
    wrap.appendChild(
      createNode('input', {
        className: 'input-field',
        dataset: { role: 'command-query' },
        type: 'text',
        attrs: { placeholder: 'Search tasks, habits, notes, and actions...' }
      })
    );
    wrap.appendChild(createNode('div', { className: 'command-results', dataset: { role: 'command-results' } }));

    const footer = createNode('div', { className: 'modal-footer' });
    footer.appendChild(createNode('button', { className: 'btn btn-cancel', dataset: { action: 'close-modal', modal: 'global-search-modal' }, text: 'Close' }));
    wrap.appendChild(footer);

    commandModal.replaceChildren(wrap);
  }

  const authGate = document.getElementById('auth-gate');
  if (authGate && !authGate.dataset.initialized) {
    authGate.dataset.initialized = '1';
    renderAuthGateContent();
  }
}

function renderAuthGateContent() {
  const authGate = document.getElementById('auth-gate');
  if (!authGate) return;

  const ui = getState().ui || {};
  const gateStep = ui.gateStep || 'choice';
  const gateMode = ui.gateMode || 'signin';
  const authSubmitting = Boolean(ui.authSubmitting);
  const authError = ui.authError || '';
  const authInfo = ui.authInfo || '';

  const card = createNode('div', { className: 'auth-card auth-main' });
  card.appendChild(createNode('div', { className: 'auth-title', text: 'Welcome to 2DoByU' }));
  card.appendChild(
    createNode('div', {
      className: 'auth-sub',
      text: gateStep === 'choice' ? 'Choose how you want to continue.' : gateMode === 'signin' ? 'Sign in to continue to your dashboard.' : 'Create your account to get started.'
    })
  );

  if (gateStep === 'choice') {
    const choiceWrap = createNode('div', { className: 'auth-choice-grid' });
    choiceWrap.appendChild(createNode('button', { className: 'settings-btn primary auth-choice-btn', dataset: { action: 'auth-open-signin' }, text: 'Sign In' }));
    choiceWrap.appendChild(createNode('button', { className: 'settings-btn auth-choice-btn', dataset: { action: 'auth-open-signup' }, text: 'Create Account' }));
    card.appendChild(choiceWrap);
  } else {
    const form = createNode('div', { className: 'auth-form show' });
    form.appendChild(createNode('input', { className: 'input-field', attrs: { id: 'auth-email', placeholder: 'Email' }, type: 'email' }));
    form.appendChild(createNode('input', { className: 'input-field', attrs: { id: 'auth-password', placeholder: 'Password' }, type: 'password' }));
    if (authError) {
      form.appendChild(createNode('div', { className: 'auth-message auth-error', text: authError }));
    } else if (authInfo) {
      form.appendChild(createNode('div', { className: 'auth-message auth-info', text: authInfo }));
    }

    const actions = createNode('div', { className: 'auth-actions' });
    actions.appendChild(
      createNode('button', {
        className: 'settings-btn',
        dataset: { action: 'auth-back-choice' },
        text: 'Back',
        attrs: authSubmitting ? { disabled: 'disabled' } : undefined
      })
    );
    if (gateMode === 'signin') {
      actions.appendChild(
        createNode('button', {
          className: 'settings-btn primary',
          dataset: { action: 'auth-signin' },
          text: authSubmitting ? 'Signing In…' : 'Sign In',
          attrs: authSubmitting ? { disabled: 'disabled' } : undefined
        })
      );
    } else {
      actions.appendChild(
        createNode('button', {
          className: 'settings-btn primary',
          dataset: { action: 'auth-signup' },
          text: authSubmitting ? 'Creating…' : 'Create Account',
          attrs: authSubmitting ? { disabled: 'disabled' } : undefined
        })
      );
    }
    form.appendChild(actions);
    card.appendChild(form);
  }

  authGate.replaceChildren(card);
}

export function openModal(modalId) {
  if (modalId === 'auth-modal') {
    patchState({
      ui: {
        ...getState().ui,
        authModal: true
      }
    });
    return;
  }

  const modal = document.getElementById(modalId);
  if (!modal) return;

  modal.style.display = 'flex';
  activateModalFocusTrap(modal);
}

export function closeModal(modalId) {
  if (modalId === 'auth-modal') {
    patchState({
      ui: {
        ...getState().ui,
        authModal: false
      }
    });
    return;
  }

  const modal = document.getElementById(modalId);
  if (!modal) return;

  modal.style.display = 'none';
  if (activeModalTrap?.modal === modal) {
    deactivateModalFocusTrap();
  }
}

function getModalFocusableElements(modal) {
  return Array.from(
    modal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
  ).filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null);
}

function deactivateModalFocusTrap() {
  if (!activeModalTrap) return;
  document.removeEventListener('keydown', activeModalTrap.handler, true);
  activeModalTrap = null;
}

function activateModalFocusTrap(modal) {
  deactivateModalFocusTrap();

  const focusables = getModalFocusableElements(modal);
  const first = focusables[0] || modal;
  const last = focusables[focusables.length - 1] || modal;

  const handler = (event) => {
    if (event.key !== 'Tab') return;
    if (!modal || modal.style.display === 'none') return;

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
      return;
    }

    if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  document.addEventListener('keydown', handler, true);
  activeModalTrap = { modal, handler };

  queueMicrotask(() => {
    if (first && typeof first.focus === 'function') first.focus();
  });
}

function triggerHapticFeedback() {
  if (!('vibrate' in navigator)) return;
  navigator.vibrate(12);
}

async function handleHabitCheck(habitId, dateKey) {
  triggerHapticFeedback();
  await toggleHabitDayByDate(habitId, dateKey);
}

async function handleTaskComplete(taskId) {
  triggerHapticFeedback();
  const moved = moveTaskToColumn(taskId, 'done');
  if (!moved) return;
  await persistSnapshot();
}

function openTaskModal(taskId = null) {
  const titleEl = document.getElementById('task-modal-title');
  const titleInput = document.getElementById('task-title-input');
  const dateInput = document.getElementById('task-date-input');

  if (!titleEl || !titleInput || !dateInput) return;

  if (taskId != null) {
    const found = getTaskById(taskId);
    if (found) {
      titleEl.textContent = 'Edit Task';
      titleInput.value = found.task.title || '';
      dateInput.value = found.task.dueDate || '';
      titleInput.dataset.editTaskId = String(found.task.id);
    }
  } else {
    titleEl.textContent = 'New Task';
    titleInput.value = '';
    dateInput.value = '';
    delete titleInput.dataset.editTaskId;
  }

  openModal('task-modal');
}

function openHabitModal(habitId = null) {
  const titleEl = document.getElementById('habit-modal-title');
  const nameInput = document.getElementById('habit-name-input');
  const categoryInput = document.getElementById('habit-category-input');

  if (!titleEl || !nameInput || !categoryInput) return;

  if (habitId != null) {
    const habit = getState().habits[Number(habitId)];
    if (habit) {
      titleEl.textContent = 'Edit Habit';
      nameInput.value = habit.name || '';
      categoryInput.value = habit.category || 'Other';
      nameInput.dataset.editHabitId = String(habitId);
    }
  } else {
    titleEl.textContent = 'New Habit';
    nameInput.value = '';
    categoryInput.value = 'Health';
    delete nameInput.dataset.editHabitId;
  }

  openModal('habit-modal');
}

function openNoteModal(noteId = null) {
  const titleEl = document.getElementById('note-modal-title');
  const titleInput = document.getElementById('note-title-input');
  const bodyInput = document.getElementById('note-body-input');

  if (!titleEl || !titleInput || !bodyInput) return;

  if (noteId != null) {
    const note = getState().notes.find((item) => String(item.id) === String(noteId));
    if (note) {
      titleEl.textContent = 'Edit Note';
      titleInput.value = note.title || '';
      bodyInput.value = note.body || '';
      titleInput.dataset.editNoteId = String(noteId);
    }
  } else {
    titleEl.textContent = 'New Note';
    titleInput.value = '';
    bodyInput.value = '';
    delete titleInput.dataset.editNoteId;
  }

  openModal('note-modal');
}

function openHabitReflection(habitId) {
  const idx = Number(habitId);
  const habit = getState().habits[idx];
  if (!habit) return;

  const today = new Date().toISOString().slice(0, 10);
  const input = document.getElementById('habit-reflection-input');
  const label = document.getElementById('habit-reflection-label');

  if (!input || !label) return;

  input.value = String(habit.reflections?.[today] || '');
  input.dataset.habitId = String(idx);
  input.dataset.dateKey = today;
  label.textContent = `${habit.name} — ${today}`;

  openModal('habit-reflection-modal');
}

async function saveTaskFromModal() {
  const titleInput = document.getElementById('task-title-input');
  const dateInput = document.getElementById('task-date-input');
  if (!titleInput || !dateInput) return;

  const title = sanitizeUserText(titleInput.value);
  if (!title) return;

  const editId = titleInput.dataset.editTaskId;

  let changedTaskId = null;

  setState((prev) => {
    const next = structuredClone(prev);

    if (editId) {
      const found = getTaskById(editId);
      if (found) {
        changedTaskId = String(found.task.id);
        next.tasks[found.col][found.idx] = {
          ...next.tasks[found.col][found.idx],
          title,
          dueDate: dateInput.value || parseNaturalDueDate(title) || ''
        };
      }
      return next;
    }

    changedTaskId = String(next.taskIdCounter);
    next.tasks.todo.push({
      id: next.taskIdCounter,
      title,
      dueDate: dateInput.value || parseNaturalDueDate(title) || '',
      priority: 'medium',
      tag: '',
      notes: ''
    });
    next.taskIdCounter += 1;
    return next;
  });

  if (changedTaskId) markDirty('tasks', changedTaskId);
  if (changedTaskId) {
    const live = getTaskById(changedTaskId);
    if (live) {
      queuePendingChange('task-upsert', {
        task: structuredClone(live.task),
        column: live.col
      });
    }
  }

  closeModal('task-modal');
  await persistSnapshot();
}

async function saveHabitFromModal() {
  const nameInput = document.getElementById('habit-name-input');
  const categoryInput = document.getElementById('habit-category-input');
  if (!nameInput || !categoryInput) return;

  const name = sanitizeUserText(nameInput.value);
  if (!name) return;

  const editId = nameInput.dataset.editHabitId;

  let changedHabitIndex = null;

  setState((prev) => {
    const next = structuredClone(prev);

    if (editId != null && editId !== '') {
      const idx = Number(editId);
      if (next.habits[idx]) {
        changedHabitIndex = idx;
        next.habits[idx] = {
          ...next.habits[idx],
          name,
          category: categoryInput.value || 'Other'
        };
      }
      return next;
    }

    changedHabitIndex = next.habits.length;
    next.habits.push({
      name,
      category: categoryInput.value || 'Other',
      type: 'positive',
      freq: 'daily',
      history: {},
      reflections: {},
      color: '#d4a373'
    });
    return next;
  });

  if (changedHabitIndex != null) markDirty('habits', changedHabitIndex);
  if (changedHabitIndex != null) {
    const habit = getState().habits[changedHabitIndex];
    if (habit) {
      queuePendingChange('habit-upsert', {
        index: changedHabitIndex,
        habit: structuredClone(habit)
      });
    }
  }

  closeModal('habit-modal');
  await persistSnapshot();
}

async function saveNoteFromModal() {
  const titleInput = document.getElementById('note-title-input');
  const bodyInput = document.getElementById('note-body-input');
  if (!titleInput || !bodyInput) return;

  const title = sanitizeUserText(titleInput.value);
  const body = sanitizeUserText(bodyInput.value);
  const editId = titleInput.dataset.editNoteId;

  setState((prev) => {
    const next = structuredClone(prev);

    if (editId) {
      const idx = next.notes.findIndex((item) => String(item.id) === String(editId));
      if (idx !== -1) {
        next.notes[idx] = {
          ...next.notes[idx],
          title,
          body
        };
      }
      return next;
    }

    next.notes.push({
      id: Date.now(),
      title,
      body,
      color: NOTE_COLORS[next.notes.length % NOTE_COLORS.length]
    });

    return next;
  });

  markDirty('notes');

  const note = editId
    ? getState().notes.find((item) => String(item.id) === String(editId))
    : getState().notes[getState().notes.length - 1];
  if (note) {
    queuePendingChange('note-upsert', { note: structuredClone(note) });
  }

  closeModal('note-modal');
  await persistSnapshot();
}

async function saveHabitReflectionFromModal() {
  const input = document.getElementById('habit-reflection-input');
  if (!input) return;

  const habitId = Number(input.dataset.habitId);
  const dateKey = input.dataset.dateKey;
  const reflection = input.value.trim();

  if (Number.isNaN(habitId) || !dateKey) return;

  setState((prev) => {
    const next = structuredClone(prev);
    const habit = next.habits[habitId];
    if (!habit) return prev;

    if (!habit.reflections || typeof habit.reflections !== 'object') {
      habit.reflections = {};
    }

    if (reflection) {
      habit.reflections[dateKey] = reflection;
    } else {
      delete habit.reflections[dateKey];
    }

    return next;
  });

  markDirty('habits', habitId);
  const habit = getState().habits[habitId];
  if (habit) {
    queuePendingChange('habit-upsert', {
      index: habitId,
      habit: structuredClone(habit)
    });
  }

  closeModal('habit-reflection-modal');
  await persistSnapshot();
}

async function toggleHabitDayByDate(habitId, dateKey) {
  const idx = Number(habitId);

  setState((prev) => {
    const next = structuredClone(prev);
    const habit = next.habits[idx];
    if (!habit) return prev;
    const current = getHabitStateByDate(habit, dateKey);
    setHabitDateState(habit, dateKey, current === 'done' ? 'missed' : 'done');

    return next;
  });

  markDirty('habits', idx);
  const habit = getState().habits[idx];
  if (habit) {
    queuePendingChange('habit-upsert', {
      index: idx,
      habit: structuredClone(habit)
    });
  }

  await persistSnapshot();
}

async function toggleHabitSkipByDate(habitId, dateKey) {
  const idx = Number(habitId);

  setState((prev) => {
    const next = structuredClone(prev);
    const habit = next.habits[idx];
    if (!habit) return prev;
    const current = getHabitStateByDate(habit, dateKey);
    setHabitDateState(habit, dateKey, current === 'skipped' ? 'missed' : 'skipped');

    return next;
  });

  markDirty('habits', idx);
  const habit = getState().habits[idx];
  if (habit) {
    queuePendingChange('habit-upsert', {
      index: idx,
      habit: structuredClone(habit)
    });
  }

  await persistSnapshot();
}

async function toggleHabitSkipToday(habitId) {
  const dateKey = new Date().toISOString().slice(0, 10);
  await toggleHabitSkipByDate(habitId, dateKey);
}

async function handleAuthSignIn() {
  if (getState().ui?.authSubmitting) return;
  const emailInput = document.getElementById('auth-email');
  const passwordInput = document.getElementById('auth-password');
  if (!emailInput || !passwordInput) return;

  patchState({
    ui: {
      ...getState().ui,
      authSubmitting: true,
      authError: null,
      authInfo: null
    }
  });

  try {
    await signIn(emailInput.value.trim(), passwordInput.value);
    patchState({
      ui: {
        ...getState().ui,
        gateStep: 'choice',
        gateMode: 'signin',
        appUnlocked: true,
        authSubmitting: false,
        authError: null,
        authInfo: null
      }
    });
  } catch (error) {
    const rawMessage = String(error?.message || 'Unable to sign in right now.');
    const lower = rawMessage.toLowerCase();
    let message = rawMessage;
    if (lower.includes('invalid login credentials')) {
      message = 'Incorrect email or password.';
    } else if (lower.includes('email not confirmed')) {
      message = 'Please confirm your email before signing in.';
    }
    patchState({
      ui: {
        ...getState().ui,
        authModal: true,
        gateStep: 'form',
        gateMode: 'signin',
        appUnlocked: false,
        authSubmitting: false,
        authError: message,
        authInfo: null
      }
    });
  } finally {
    patchState({
      ui: {
        ...getState().ui,
        authSubmitting: false
      }
    });
  }
}

async function handleAuthSignUp() {
  if (getState().ui?.authSubmitting) return;
  const emailInput = document.getElementById('auth-email');
  const passwordInput = document.getElementById('auth-password');
  if (!emailInput || !passwordInput) return;

  patchState({
    ui: {
      ...getState().ui,
      authSubmitting: true,
      authError: null,
      authInfo: null
    }
  });

  try {
    const authData = await signUp(emailInput.value.trim(), passwordInput.value);
    const hasSession = Boolean(authData?.session?.user);

    patchState({
      ui: {
        ...getState().ui,
        authModal: !hasSession,
        gateStep: hasSession ? 'choice' : 'form',
        gateMode: 'signin',
        appUnlocked: hasSession,
        authSubmitting: false,
        authError: null,
        authInfo: hasSession ? null : 'Account created. Check your email to confirm your account, then sign in.'
      }
    });
  } catch (error) {
    const rawMessage = String(error?.message || 'Unable to create your account right now.');
    const lower = rawMessage.toLowerCase();
    let message = rawMessage;
    if (lower.includes('user already registered')) {
      message = 'An account with this email already exists. Please sign in.';
    } else if (lower.includes('password') && lower.includes('6')) {
      message = 'Password must be at least 6 characters.';
    }
    patchState({
      ui: {
        ...getState().ui,
        authModal: true,
        gateStep: 'form',
        gateMode: 'signup',
        appUnlocked: false,
        authSubmitting: false,
        authError: message,
        authInfo: null
      }
    });
  } finally {
    patchState({
      ui: {
        ...getState().ui,
        authSubmitting: false
      }
    });
  }
}

function applyAuthGateVisibility() {
  const gate = document.getElementById('auth-gate');
  if (!gate) return;

  const state = getState();
  const showAuth = Boolean(state.ui.authModal || !state.user);
  gate.classList.toggle('hidden', !showAuth);
  document.body.classList.toggle('auth-active', showAuth);
  renderAuthGateContent();
}

function renderSnackbar() {
  let snackbarEl = document.getElementById('snackbar-host');
  if (!snackbarEl) {
    snackbarEl = document.createElement('div');
    snackbarEl.id = 'snackbar-host';
    document.body.appendChild(snackbarEl);
  }

  const snackbar = getState().ui?.snackbar;
  if (!snackbar) {
    snackbarEl.replaceChildren();
    snackbarEl.classList.remove('show');
    return;
  }

  const card = createNode('div', { className: 'snackbar-card' });
  card.appendChild(createNode('span', { text: sanitizeUserText(snackbar.label || 'Changes saved') }));
  card.appendChild(createNode('button', { className: 'tb-btn', dataset: { action: 'undo-snackbar' }, text: 'Undo' }));

  snackbarEl.replaceChildren(card);
  snackbarEl.classList.add('show');
}

async function updateSettings(nextPartial) {
  markDirty('settings');
  queuePendingChange('settings-merge', { settings: nextPartial });

  patchState({
    settings: {
      ...getState().settings,
      ...nextPartial
    }
  });

  if (Object.prototype.hasOwnProperty.call(nextPartial, 'supabaseUrl')) {
    localStorage.setItem('2dobyu_supabase_url', String(nextPartial.supabaseUrl || '').trim());
  }

  if (Object.prototype.hasOwnProperty.call(nextPartial, 'supabaseAnonKey')) {
    localStorage.setItem('2dobyu_supabase_anon_key', String(nextPartial.supabaseAnonKey || '').trim());
  }

  applySettingsVisuals();
  await persistSnapshot();
}

function bindGlobalEvents() {
  const sidebar = document.getElementById('sidebar');
  const sidebarOverlay = document.getElementById('sidebar-overlay');
  const hamburgerBtn = document.getElementById('hamburger');

  const openSidebar = () => {
    if (!sidebar) return;
    sidebar.classList.add('open');
    sidebarOverlay?.classList.add('show');
  };

  const closeSidebar = () => {
    if (!sidebar) return;
    sidebar.classList.remove('open');
    sidebarOverlay?.classList.remove('show');
  };

  const closeAllModals = () => {
    document.querySelectorAll('.modal-overlay').forEach((modal) => {
      modal.style.display = 'none';
    });
    closeModal('auth-modal');
    deactivateModalFocusTrap();
  };

  if (hamburgerBtn) {
    hamburgerBtn.addEventListener('click', () => {
      if (!sidebar) return;
      const isOpen = sidebar.classList.contains('open');
      if (isOpen) {
        closeSidebar();
      } else {
        openSidebar();
      }
    });
  }

  if (sidebarOverlay) {
    sidebarOverlay.addEventListener('click', closeSidebar);
  }

  document.addEventListener('keydown', (event) => {
    const active = document.activeElement;
    const typingTarget = active && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName);

    if (event.key === 'Enter' && typingTarget && !event.repeat && !event.isComposing) {
      const targetEl = event.target instanceof HTMLElement ? event.target : null;
      const inAuthGate = Boolean(targetEl?.closest('#auth-gate'));
      if (inAuthGate) {
        const ui = getState().ui || {};
        if (ui.gateStep === 'form' && !ui.authSubmitting) {
          event.preventDefault();
          if (ui.gateMode === 'signup') {
            void handleAuthSignUp();
          } else {
            void handleAuthSignIn();
          }
        }
        return;
      }
    }

    if (event.key === 'Escape') {
      closeAllModals();
      return;
    }

    if (event.ctrlKey && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      openCommandPalette();
      return;
    }

    if (typingTarget) return;

    if (!event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'n') {
      event.preventDefault();
      openTaskModal();
    }
  });

  document.addEventListener('click', async (event) => {
    if (taskSortMenuOpen && !event.target.closest('.task-sort-menu')) {
      taskSortMenuOpen = false;
      if (getCurrentView() === 'tasks') renderTasks();
    }

    const actionEl = event.target.closest('[data-action]');

    if (actionEl) {
      const action = actionEl.dataset.action;
      const id = actionEl.dataset.id;

      if (action === 'open-task-modal') {
        openTaskModal(id || null);
        return;
      }

      if (action === 'open-habit-modal') {
        openHabitModal(id || null);
        return;
      }

      if (action === 'open-note-modal') {
        openNoteModal(id || null);
        return;
      }

      if (action === 'open-habit-reflection') {
        openHabitReflection(id);
        return;
      }

      if (action === 'toggle-habit-skip-today') {
        await toggleHabitSkipToday(id);
        return;
      }

      if (action === 'close-modal') {
        closeModal(actionEl.dataset.modal);
        return;
      }

      if (action === 'save-task-modal') {
        await saveTaskFromModal();
        return;
      }

      if (action === 'save-habit-modal') {
        await saveHabitFromModal();
        return;
      }

      if (action === 'save-note-modal') {
        await saveNoteFromModal();
        return;
      }

      if (action === 'save-habit-reflection') {
        await saveHabitReflectionFromModal();
        return;
      }

      if (action === 'auth-signin') {
        if (getState().ui?.authSubmitting) return;
        await handleAuthSignIn();
        return;
      }

      if (action === 'auth-open-signin') {
        patchState({
          ui: {
            ...getState().ui,
            authModal: true,
            gateMode: 'signin',
            gateStep: 'form',
            appUnlocked: false,
            authSubmitting: false,
            authError: null,
            authInfo: null
          }
        });
        return;
      }

      if (action === 'auth-open-signup') {
        patchState({
          ui: {
            ...getState().ui,
            authModal: true,
            gateMode: 'signup',
            gateStep: 'form',
            appUnlocked: false,
            authSubmitting: false,
            authError: null,
            authInfo: null
          }
        });
        return;
      }

      if (action === 'auth-back-choice') {
        patchState({
          ui: {
            ...getState().ui,
            gateStep: 'choice',
            gateMode: 'signin',
            appUnlocked: false,
            authSubmitting: false,
            authError: null,
            authInfo: null
          }
        });
        return;
      }

      if (action === 'auth-signup') {
        if (getState().ui?.authSubmitting) return;
        await handleAuthSignUp();
        return;
      }

      if (action === 'clear-task-filters') {
        taskFilters = { query: '', sort: 'default', due: 'all', smartRule: '', smartViewId: 'none' };
        taskSortMenuOpen = false;
        renderTasks();
        return;
      }

      if (action === 'toggle-task-menu') {
        taskMenuExpanded = !taskMenuExpanded;
        setStoredMenuState('2dobyu_task_menu_expanded', taskMenuExpanded);
        if (!taskMenuExpanded) taskSortMenuOpen = false;
        renderTasks();
        return;
      }

      if (action === 'save-smart-view') {
        const rule = sanitizeUserText(taskFilters.smartRule);
        if (!rule) return;

        const name = window.prompt('Smart view name', 'High Priority');
        if (!name) return;

        const view = {
          id: `view-${Date.now()}`,
          name: sanitizeUserText(name),
          rule
        };

        updateSettings({
          customTaskViews: [...getCustomTaskViews(), view]
        }).catch((err) => console.warn('[2DoByU] save smart view failed', err));
        taskFilters = {
          ...taskFilters,
          smartViewId: view.id
        };
        renderTasks();
        return;
      }

      if (action === 'apply-smart-view') {
        taskFilters = {
          ...taskFilters,
          smartViewId: actionEl.dataset.id || 'none'
        };
        renderTasks();
        return;
      }

      if (action === 'toggle-sort-menu') {
        taskSortMenuOpen = !taskSortMenuOpen;
        renderTasks();
        return;
      }

      if (action === 'set-task-sort') {
        taskFilters = {
          ...taskFilters,
          sort: actionEl.dataset.sort || 'default'
        };
        taskSortMenuOpen = false;
        renderTasks();
        return;
      }

      if (action === 'set-task-view') {
        patchState({
          ui: {
            ...getState().ui,
            taskView: actionEl.dataset.view || 'status'
          }
        });
        return;
      }

      if (action === 'calendar-prev') {
        shiftCalendarCursor(-1);
        renderCalendar();
        return;
      }

      if (action === 'calendar-next') {
        shiftCalendarCursor(1);
        renderCalendar();
        return;
      }

      if (action === 'calendar-today') {
        const today = new Date();
        calendarCursor = new Date(today.getFullYear(), today.getMonth(), today.getDate());
        calendarSelectedDateKey = today.toISOString().slice(0, 10);
        renderCalendar();
        return;
      }

      if (action === 'calendar-set-view') {
        calendarView = actionEl.dataset.value || 'month';
        renderCalendar();
        return;
      }

      if (action === 'toggle-calendar-menu') {
        calendarMenuExpanded = !calendarMenuExpanded;
        setStoredMenuState('2dobyu_calendar_menu_expanded', calendarMenuExpanded);
        renderCalendar();
        return;
      }

      if (action === 'calendar-select-day') {
        calendarSelectedDateKey = actionEl.dataset.date || calendarSelectedDateKey;
        const parsed = new Date(`${calendarSelectedDateKey}T00:00:00`);
        if (!Number.isNaN(parsed.getTime())) {
          calendarCursor = parsed;
        }
        renderCalendar();
        return;
      }

      if (action === 'calendar-open-item') {
        const itemType = actionEl.dataset.itemType;
        const itemId = actionEl.dataset.itemId;
        if (itemType === 'task') {
          openTaskModal(itemId);
          return;
        }
        if (itemType === 'habit') {
          openHabitModal(itemId);
          return;
        }
        if (itemType === 'other') {
          openNoteModal(itemId);
        }
        return;
      }

      if (action === 'insight-open-task') {
        openTaskModal(actionEl.dataset.id || null);
        return;
      }

      if (action === 'insights-set-trend-range') {
        const days = Number(actionEl.dataset.days || 7);
        insightsTrendDays = days === 30 ? 30 : 7;
        try {
          localStorage.setItem('2dobyu_insights_trend_days', String(insightsTrendDays));
        } catch (_err) {
          // ignore storage failures
        }
        renderInsights();
        return;
      }

      if (action === 'settings-sync-now') {
        await persistSnapshot();
        await syncData();
        return;
      }

      if (action === 'settings-signout') {
        await signOut();
        return;
      }

      if (action === 'settings-export') {
        const snapshot = cloneForSync(getState());
        downloadTextFile(`2dobyu-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(snapshot, null, 2), 'application/json');
        return;
      }

      if (action === 'settings-export-csv') {
        const rows = [...buildTaskCsv(), ...buildHabitCsv().slice(1)];
        downloadTextFile(`2dobyu-export-${new Date().toISOString().slice(0, 10)}.csv`, rowsToCsv(rows), 'text/csv;charset=utf-8');
        return;
      }

      if (action === 'settings-import') {
        const fileInput = document.querySelector('[data-role="settings-import-file"]');
        if (fileInput) fileInput.click();
        return;
      }

      if (action === 'settings-reset-local') {
        const confirmed = window.confirm('Reset all local data? This cannot be undone.');
        if (!confirmed) return;
        resetState();
        markDirty('full');
        queueFullSnapshotChange();
        applySettingsVisuals();
        await persistSnapshot();
        return;
      }

      if (action === 'undo-snackbar') {
        const didUndo = undoLastChange();
        if (didUndo) {
          queueFullSnapshotChange();
          await persistSnapshot();
        }
        return;
      }

      if (action === 'command-switch-view') {
        try {
          const payload = JSON.parse(decodeURIComponent(actionEl.dataset.commandPayload || '%7B%7D'));
          if (payload.view) setCurrentView(payload.view);
        } catch (_err) {
          // ignore malformed payload
        }
        closeModal('global-search-modal');
        return;
      }

      if (action === 'command-create-task') {
        closeModal('global-search-modal');
        openTaskModal();
        return;
      }

      if (action === 'command-create-habit') {
        closeModal('global-search-modal');
        openHabitModal();
        return;
      }

      if (action === 'command-create-note') {
        closeModal('global-search-modal');
        openNoteModal();
        return;
      }

      if (action === 'command-open-task' || action === 'command-open-habit' || action === 'command-open-note') {
        try {
          const payload = JSON.parse(decodeURIComponent(actionEl.dataset.commandPayload || '%7B%7D'));
          closeModal('global-search-modal');
          if (action === 'command-open-task') openTaskModal(payload.taskId);
          if (action === 'command-open-habit') openHabitModal(payload.habitId);
          if (action === 'command-open-note') openNoteModal(payload.noteId);
        } catch (_err) {
          closeModal('global-search-modal');
        }
        return;
      }
    }

    const navItem = event.target.closest('.nav-item[data-page]');
    if (navItem) {
      setCurrentView(navItem.dataset.page);
      if (window.matchMedia('(max-width: 768px)').matches) {
        closeSidebar();
      }
      return;
    }

    const habitDay = event.target.closest('[data-role="habit-history-day"]');
    if (habitDay) {
      await handleHabitCheck(habitDay.dataset.id, habitDay.dataset.date);
      return;
    }

    const taskCard = event.target.closest('[data-task-id]');
    if (taskCard && event.detail === 2 && (event.shiftKey || event.altKey)) {
      await handleTaskComplete(taskCard.dataset.taskId);
      return;
    }

    if (taskCard && event.detail === 2) {
      openTaskModal(taskCard.dataset.taskId);
      return;
    }

    const noteCard = event.target.closest('[data-note-id]');
    if (noteCard) {
      openNoteModal(noteCard.dataset.noteId);
    }
  });

  document.addEventListener('contextmenu', async (event) => {
    const habitDay = event.target.closest('[data-role="habit-history-day"]');
    if (!habitDay) return;
    event.preventDefault();
    await toggleHabitSkipByDate(habitDay.dataset.id, habitDay.dataset.date);
  });

  document.addEventListener('input', (event) => {
    const queryInput = event.target.closest('[data-role="task-filter-query"]');
    if (!queryInput) return;
    taskFilters = {
      ...taskFilters,
      query: queryInput.value || ''
    };
    renderTasks();

    const smartInput = event.target.closest('[data-role="task-smart-rule"]');
    if (smartInput) {
      taskFilters = {
        ...taskFilters,
        smartRule: smartInput.value || '',
        smartViewId: 'none'
      };
      renderTasks();
      return;
    }

    const commandInput = event.target.closest('[data-role="command-query"]');
    if (commandInput) {
      commandPaletteQuery = commandInput.value || '';
      renderCommandPalette();
    }
  });

  document.addEventListener('change', async (event) => {
    const sortSelect = event.target.closest('[data-role="task-filter-sort"]');
    if (sortSelect) {
      taskFilters = {
        ...taskFilters,
        sort: sortSelect.value || 'default'
      };
      taskSortMenuOpen = false;
      renderTasks();
      return;
    }

    const dueSelect = event.target.closest('[data-role="task-filter-due"]');
    if (dueSelect) {
      taskFilters = {
        ...taskFilters,
        due: dueSelect.value || 'all'
      };
      renderTasks();
      return;
    }

    const smartViewSelect = event.target.closest('[data-role="task-smart-view"]');
    if (smartViewSelect) {
      taskFilters = {
        ...taskFilters,
        smartViewId: smartViewSelect.value || 'none'
      };
      renderTasks();
      return;
    }

    const calendarCategory = event.target.closest('[data-role="calendar-filter-category"]');
    if (calendarCategory) {
      calendarFilters = {
        ...calendarFilters,
        category: calendarCategory.value || 'all'
      };
      renderCalendar();
      return;
    }

    const calendarTypeFilter = event.target.closest('[data-role="calendar-filter-type"]');
    if (calendarTypeFilter) {
      const type = calendarTypeFilter.dataset.type;
      if (!['task', 'habit', 'other'].includes(type)) return;
      calendarFilters = {
        ...calendarFilters,
        [type]: Boolean(calendarTypeFilter.checked)
      };
      renderCalendar();
      return;
    }

    const settingTheme = event.target.closest('[data-role="settings-theme"]');
    if (settingTheme) {
      await updateSettings({ theme: settingTheme.value || 'light' });
      return;
    }

    const settingAccent = event.target.closest('[data-role="settings-accent"]');
    if (settingAccent) {
      await updateSettings({ accent: settingAccent.value || '#d4a373' });
      return;
    }

    const settingAccentDark = event.target.closest('[data-role="settings-accent-dark"]');
    if (settingAccentDark) {
      await updateSettings({ accentDark: settingAccentDark.value || '#c49363' });
      return;
    }

    const settingCompact = event.target.closest('[data-role="settings-compact"]');
    if (settingCompact) {
      await updateSettings({ compact: Boolean(settingCompact.checked) });
      return;
    }

    const settingTimezone = event.target.closest('[data-role="settings-timezone"]');
    if (settingTimezone) {
      await updateSettings({ timeZone: settingTimezone.value || 'UTC' });
      return;
    }

    const settingFirstDay = event.target.closest('[data-role="settings-firstday"]');
    if (settingFirstDay) {
      await updateSettings({ firstday: settingFirstDay.value || 'mon' });
      return;
    }

    const settingWeekStyle = event.target.closest('[data-role="settings-week-style"]');
    if (settingWeekStyle) {
      await updateSettings({ weekStyle: settingWeekStyle.value || 'personal' });
      return;
    }

    const settingAutolock = event.target.closest('[data-role="settings-autolock"]');
    if (settingAutolock) {
      await updateSettings({ autolock: Boolean(settingAutolock.checked) });
      return;
    }

    const settingFireworks = event.target.closest('[data-role="settings-fireworks"]');
    if (settingFireworks) {
      await updateSettings({ fireworks: Boolean(settingFireworks.checked) });
      return;
    }

    const settingGoogleAuth = event.target.closest('[data-role="settings-google-auth"]');
    if (settingGoogleAuth) {
      await updateSettings({ googleAuthEnabled: Boolean(settingGoogleAuth.checked) });
      return;
    }

    const settingSupabaseUrl = event.target.closest('[data-role="settings-supabase-url"]');
    if (settingSupabaseUrl) {
      await updateSettings({ supabaseUrl: String(settingSupabaseUrl.value || '').trim() });
      return;
    }

    const settingSupabaseKey = event.target.closest('[data-role="settings-supabase-key"]');
    if (settingSupabaseKey) {
      await updateSettings({ supabaseAnonKey: String(settingSupabaseKey.value || '').trim() });
      return;
    }

    const settingPushPublicKey = event.target.closest('[data-role="settings-push-public-key"]');
    if (settingPushPublicKey) {
      await updateSettings({ pushPublicKey: String(settingPushPublicKey.value || '').trim() });
      return;
    }

    const importFileInput = event.target.closest('[data-role="settings-import-file"]');
    if (importFileInput && importFileInput.files?.[0]) {
      try {
        const text = await importFileInput.files[0].text();
        const parsed = JSON.parse(text);
        setState((prev) => ({
          ...prev,
          tasks: parsed.tasks || prev.tasks,
          habits: Array.isArray(parsed.habits) ? parsed.habits : prev.habits,
          notes: Array.isArray(parsed.notes) ? parsed.notes : prev.notes,
          archived: parsed.archived || prev.archived,
          taskIdCounter: Number(parsed.taskIdCounter || prev.taskIdCounter || 1),
          settings: {
            ...prev.settings,
            ...(parsed.settings || {})
          }
        }));
        markDirty('full');
        queueFullSnapshotChange();
        applySettingsVisuals();
        await persistSnapshot();
      } catch (err) {
        console.warn('[2DoByU] Import failed', err);
      } finally {
        importFileInput.value = '';
      }
    }
  });

  const topbarAction = document.getElementById('topbar-action');
  if (topbarAction) {
    topbarAction.addEventListener('click', () => {
      const view = getCurrentView();
      if (view === 'tasks') openTaskModal();
      if (view === 'habits') openHabitModal();
      if (view === 'notes') openNoteModal();
    });
  }

  const searchBtn = document.getElementById('search-btn');
  if (searchBtn) {
    searchBtn.addEventListener('click', () => {
      openCommandPalette();
    });
  }
}

export function initUI() {
  if (initialized) return;
  initialized = true;

  ensureModals();
  bindGlobalEvents();
  subscribe(() => {
    renderApp();
    applyAuthGateVisibility();
    applySettingsVisuals();
    renderSnackbar();
  });

  applySettingsVisuals();
  renderApp();
  applyAuthGateVisibility();
  renderSnackbar();
}
