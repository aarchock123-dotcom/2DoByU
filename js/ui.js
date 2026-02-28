import { getState, patchState, setState, subscribe, resetState } from './state.js';
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
let taskFilters = {
  query: '',
  sort: 'default',
  due: 'all'
};

const NOTE_COLORS = ['#fff8e1', '#e3f2fd', '#f3e5f5', '#e8f5e9', '#ffebee', '#fbe9e7'];

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
  return state.ui.currentView || state.ui.currentPage || 'tasks';
}

function setCurrentView(view) {
  patchState({
    ui: {
      ...getState().ui,
      currentView: view,
      currentPage: view
    }
  });
}

function applySettingsVisuals() {
  const settings = getState().settings || {};

  if (settings.accent) {
    document.documentElement.style.setProperty('--accent', settings.accent);
  }

  if (settings.accentDark) {
    document.documentElement.style.setProperty('--accent-dark', settings.accentDark);
  }

  const theme = settings.theme || 'light';
  document.body.classList.remove('theme-light', 'theme-dark', 'theme-system');
  document.body.classList.add(`theme-${theme}`);

  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const forceDark = theme === 'dark' || (theme === 'system' && prefersDark);
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

  setState((prev) => {
    const next = structuredClone(prev);
    const task = removeTaskById(next.tasks, taskId);
    if (!task || !next.tasks[targetCol]) return prev;
    next.tasks[targetCol].push(task);
    moved = true;
    return next;
  });

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
        meta: getColumnLabel(task._column)
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
        meta: getHabitStatusLabel(status)
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
      meta: 'Note'
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

function renderCalendarItemButton(item) {
  return `
    <button class="calendar-pill calendar-item-${item.type}" data-action="calendar-open-item" data-item-type="${item.type}" data-item-id="${escapeHtml(item.id)}">
      ${escapeHtml(item.title)}
    </button>
  `;
}

function renderMonthGrid(monthStart, itemsByDate, selectedDateKey) {
  const monthEnd = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0);
  const gridStart = getCalendarGridStart(monthStart);
  const todayKey = new Date().toISOString().slice(0, 10);
  const cells = [];

  for (let idx = 0; idx < 42; idx += 1) {
    const day = new Date(gridStart);
    day.setDate(gridStart.getDate() + idx);
    const key = getDateKeyFromDate(day);
    const inMonth = day >= monthStart && day <= monthEnd;
    const isToday = key === todayKey;
    const isSelected = key === selectedDateKey;
    const dayItems = itemsByDate[key] || [];

    cells.push(`
      <div class="calendar-day ${inMonth ? '' : 'outside'} ${isToday ? 'today' : ''} ${isSelected ? 'selected' : ''}" data-action="calendar-select-day" data-date="${key}">
        <div class="calendar-day-head">
          <span>${day.getDate()}</span>
          <span class="calendar-count">${dayItems.length > 0 ? dayItems.length : ''}</span>
        </div>
        <div class="calendar-day-items">
          ${dayItems.slice(0, 3).map(renderCalendarItemButton).join('')}
        </div>
      </div>
    `);
  }

  return `
    <div class="calendar-month-block">
      <div class="calendar-month-label">${escapeHtml(formatMonthLabel(monthStart))}</div>
      <div class="calendar-weekdays">
        <span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span><span>Sun</span>
      </div>
      <div class="calendar-grid">${cells.join('')}</div>
    </div>
  `;
}

function renderRangeView(days, itemsByDate) {
  const todayKey = new Date().toISOString().slice(0, 10);
  return `
    <div class="calendar-range-grid" style="--calendar-cols:${days.length};">
      ${days
        .map((day) => {
          const dateKey = getDateKeyFromDate(day);
          const items = itemsByDate[dateKey] || [];
          const isToday = dateKey === todayKey;
          return `
            <div class="calendar-range-col ${isToday ? 'today' : ''}">
              <button class="calendar-range-head" data-action="calendar-select-day" data-date="${dateKey}">
                <strong>${escapeHtml(day.toLocaleDateString(undefined, { weekday: 'short' }))}</strong>
                <span>${escapeHtml(day.toLocaleDateString())}</span>
              </button>
              <div class="calendar-range-items">
                ${items.length === 0 ? '<div class="settings-row-desc">No items</div>' : items.map(renderCalendarItemButton).join('')}
              </div>
            </div>
          `;
        })
        .join('')}
    </div>
  `;
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

  document.querySelectorAll('.tree-flower').forEach((flower) => {
    flower.classList.toggle('blooming', rate === 100);
  });

  document.querySelectorAll('.tree-branch').forEach((branch, idx) => {
    branch.style.opacity = rate > idx * 10 + 5 ? '1' : '0';
  });

  document.querySelectorAll('.tree-leaf').forEach((leaf, idx) => {
    const threshold = 20 + idx * 6.6;
    const visible = rate > threshold;
    leaf.style.opacity = visible ? '1' : '0';
    leaf.style.transform = visible ? 'scale(1)' : 'scale(0)';
  });
}

function renderTasks() {
  const container = document.getElementById('page-tasks');
  if (!container) return;

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

  container.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">Task Board</h1>
      <button class="action-btn" data-action="open-task-modal">+ New Task</button>
    </div>
    <div class="task-toolbar">
      <div class="task-view-switch">
        <button class="tb-btn ${taskView === 'status' ? 'active' : ''}" data-action="set-task-view" data-view="status">Status</button>
        <button class="tb-btn ${taskView === 'list' ? 'active' : ''}" data-action="set-task-view" data-view="list">List</button>
        <button class="tb-btn ${taskView === 'card' ? 'active' : ''}" data-action="set-task-view" data-view="card">Card</button>
      </div>
      <input
        class="input-field task-filter-input"
        type="text"
        placeholder="Search tasks..."
        value="${escapeHtml(taskFilters.query)}"
        data-role="task-filter-query"
      />
      <div class="task-sort-menu">
        <button class="tb-btn" data-action="toggle-sort-menu">Sort ▾</button>
        <div class="task-sort-panel ${taskSortMenuOpen ? 'open' : ''}">
          <button class="task-sort-option ${taskFilters.sort === 'default' ? 'active' : ''}" data-action="set-task-sort" data-sort="default">Default</button>
          <button class="task-sort-option ${taskFilters.sort === 'recent' ? 'active' : ''}" data-action="set-task-sort" data-sort="recent">Recent</button>
          <button class="task-sort-option ${taskFilters.sort === 'due-asc' ? 'active' : ''}" data-action="set-task-sort" data-sort="due-asc">Due Soon</button>
          <button class="task-sort-option ${taskFilters.sort === 'due-desc' ? 'active' : ''}" data-action="set-task-sort" data-sort="due-desc">Due Later</button>
          <button class="task-sort-option ${taskFilters.sort === 'title' ? 'active' : ''}" data-action="set-task-sort" data-sort="title">Title</button>
        </div>
      </div>
      <select class="input-field task-filter-select" data-role="task-filter-due">
        <option value="all" ${taskFilters.due === 'all' ? 'selected' : ''}>Due: All</option>
        <option value="today" ${taskFilters.due === 'today' ? 'selected' : ''}>Due: Today</option>
        <option value="overdue" ${taskFilters.due === 'overdue' ? 'selected' : ''}>Due: Overdue</option>
        <option value="upcoming" ${taskFilters.due === 'upcoming' ? 'selected' : ''}>Due: Upcoming</option>
        <option value="nodate" ${taskFilters.due === 'nodate' ? 'selected' : ''}>Due: No Date</option>
      </select>
      <button class="tb-btn" data-action="clear-task-filters">Clear</button>
      <span class="task-filter-meta">Showing ${totalVisible} task${totalVisible === 1 ? '' : 's'}</span>
    </div>
    ${
      taskView === 'status'
        ? `
          <div class="columns-container">
            ${columns
              .map(
                (col) => `
                  <div class="column" data-column="${col.key}">
                    <div class="column-header">${col.title} <span class="task-count">${visibleTasks[col.key].length}</span></div>
                    <div class="cards" data-drop-col="${col.key}">
                      ${visibleTasks[col.key]
                        .map(
                          (task) => `
                            <div class="card task-item" draggable="true" data-task-id="${task.id}">
                              <div class="card-title">${escapeHtml(task.title)}</div>
                              <div class="card-meta">
                                <span class="date-text">${escapeHtml(task.dueDate || 'No date')}</span>
                                ${task.tag ? `<span class="tag-badge">${escapeHtml(task.tag)}</span>` : ''}
                              </div>
                            </div>
                          `
                        )
                        .join('')}
                    </div>
                  </div>
                `
              )
              .join('')}
          </div>
        `
        : ''
    }
    ${
      taskView === 'list'
        ? `
          <div class="task-list-view">
            ${
              visibleFlatTasks.length === 0
                ? '<div class="settings-row-desc">No tasks match current filters.</div>'
                : visibleFlatTasks
                    .map(
                      (task) => `
                        <div class="task-list-item" data-task-id="${task.id}">
                          <div>
                            <div class="card-title">${escapeHtml(task.title)}</div>
                            <div class="date-text">${escapeHtml(task.dueDate || 'No date')}</div>
                          </div>
                          <span class="task-list-status">${task._column === 'inprogress' ? 'In Progress' : task._column === 'done' ? 'Done' : 'To Do'}</span>
                        </div>
                      `
                    )
                    .join('')
            }
          </div>
        `
        : ''
    }
    ${
      taskView === 'card'
        ? `
          <div class="task-card-grid">
            ${
              visibleFlatTasks.length === 0
                ? '<div class="settings-row-desc">No tasks match current filters.</div>'
                : visibleFlatTasks
                    .map(
                      (task) => `
                        <div class="card task-item" data-task-id="${task.id}">
                          <div class="card-title">${escapeHtml(task.title)}</div>
                          <div class="card-meta">
                            <span class="date-text">${escapeHtml(task.dueDate || 'No date')}</span>
                            <span class="tag-badge">${task._column === 'inprogress' ? 'In Progress' : task._column === 'done' ? 'Done' : 'To Do'}</span>
                          </div>
                        </div>
                      `
                    )
                    .join('')
            }
          </div>
        `
        : ''
    }
  `;

  if (taskView === 'status') {
    setupTaskDnD();
  }
}

function renderHabits() {
  const container = document.getElementById('page-habits');
  if (!container) return;

  const { habits } = getState();

  container.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">Habits</h1>
      <button class="action-btn" data-action="open-habit-modal">+ New Habit</button>
    </div>
    <div class="tree-container">
      <h3 style="font-size:.8em;text-transform:uppercase;letter-spacing:1.5px;color:var(--muted);font-weight:600;margin-bottom:4px">Weekly Progress</h3>
      <svg class="tree-svg" viewBox="0 0 200 200">
        <rect fill="#8b7355" x="95" y="150" width="10" height="40"></rect>
        <g>
          <path class="tree-branch" d="M100 150 Q80 130 60 110" stroke="#6b5d4f" stroke-width="3" fill="none"></path>
          <path class="tree-branch" d="M100 150 Q120 130 140 110" stroke="#6b5d4f" stroke-width="3" fill="none"></path>
          <path class="tree-branch" d="M100 130 Q90 110 90 80" stroke="#6b5d4f" stroke-width="2" fill="none"></path>
          <path class="tree-branch" d="M100 130 Q110 110 110 80" stroke="#6b5d4f" stroke-width="2" fill="none"></path>
        </g>
        <g>
          <circle class="tree-leaf" cx="60" cy="110" r="8"></circle>
          <circle class="tree-leaf" cx="140" cy="110" r="8"></circle>
          <circle class="tree-leaf" cx="90" cy="80" r="8"></circle>
          <circle class="tree-leaf" cx="110" cy="80" r="8"></circle>
        </g>
        <g>
          <circle class="tree-flower" cx="60" cy="105" r="4"></circle>
          <circle class="tree-flower" cx="140" cy="105" r="4"></circle>
          <circle class="tree-flower" cx="100" cy="55" r="5"></circle>
        </g>
      </svg>
      <div style="margin-top:8px;color:var(--muted);font-weight:bold;font-size:1.1em;">Weekly Completion: <span id="comp-rate">0%</span></div>
    </div>
    <div class="habits-grid" id="habits-grid">
      ${habits
        .map((habit, habitIdx) => {
          const dateKeys = getRecentDateKeys(7);
          const counts = getHabitWeeklyCounts(habit);
          return `
            <div class="habit-card" data-habit-id="${habitIdx}">
              <div class="habit-header">
                <div class="habit-name-area">
                  <div class="habit-name">${escapeHtml(habit.name)}</div>
                  <div class="habit-category">${escapeHtml(habit.category || 'Other')}</div>
                </div>
                <div class="habit-badges"><span class="habit-streak">🔥 ${counts.done}/${counts.total}</span></div>
              </div>
              <div class="habit-history-grid">
                ${dateKeys
                  .map((dateKey) => {
                    const state = getHabitStateByDate(habit, dateKey);
                    const className = state === 'done' ? 'history-done' : state === 'skipped' ? 'history-skipped' : 'history-missed';
                    const isToday = dateKey === new Date().toISOString().slice(0, 10);
                    return `
                      <button class="day-checkbox history-cell ${className} ${isToday ? 'today' : ''}" data-role="habit-history-day" data-id="${habitIdx}" data-date="${dateKey}" title="${dateKey}">
                        ${escapeHtml(formatShortDayLabel(dateKey))}
                      </button>
                    `;
                  })
                  .join('')}
              </div>
              <div class="habit-actions-row">
                <button class="tb-btn" data-action="open-habit-reflection" data-id="${habitIdx}">📝</button>
                <button class="tb-btn" data-action="toggle-habit-skip-today" data-id="${habitIdx}">Skip</button>
                <button class="tb-btn" data-action="open-habit-modal" data-id="${habitIdx}">Edit</button>
              </div>
            </div>
          `;
        })
        .join('')}
    </div>
  `;

  updateGrowthTree();
}

function renderNotes() {
  const container = document.getElementById('page-notes');
  if (!container) return;

  const { notes } = getState();

  container.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">Notes</h1>
      <button class="action-btn" data-action="open-note-modal">+ New Note</button>
    </div>
    <div class="notes-masonry" id="notes-grid">
      ${notes
        .map(
          (note) => `
            <div class="note-card" data-note-id="${note.id}" style="background:${escapeHtml(note.color || NOTE_COLORS[0])}">
              <div class="note-title">${escapeHtml(note.title || '(Untitled)')}</div>
              <div class="note-body">${escapeHtml(note.body || '')}</div>
            </div>
          `
        )
        .join('')}
    </div>
  `;
}

function renderCalendar() {
  const container = document.getElementById('page-calendar');
  if (!container) return;

  const allItems = getCalendarItems();
  const categories = getCalendarCategories(allItems);
  const visibleItems = filterCalendarItems(allItems);
  const itemsByDate = buildItemsByDate(visibleItems);
  const selectedItems = itemsByDate[calendarSelectedDateKey] || [];

  let calendarBody = '';
  if (calendarView === 'month') {
    const monthStart = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth(), 1);
    calendarBody = renderMonthGrid(monthStart, itemsByDate, calendarSelectedDateKey);
  }

  if (calendarView === '3month' || calendarView === '6month') {
    const count = calendarView === '3month' ? 3 : 6;
    const start = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth(), 1);
    const blocks = [];
    for (let idx = 0; idx < count; idx += 1) {
      const month = new Date(start.getFullYear(), start.getMonth() + idx, 1);
      blocks.push(renderMonthGrid(month, itemsByDate, calendarSelectedDateKey));
    }
    calendarBody = `<div class="calendar-multi-month">${blocks.join('')}</div>`;
  }

  if (calendarView === 'day' || calendarView === '3day' || calendarView === 'workweek' || calendarView === '7day') {
    calendarBody = renderRangeView(getCalendarRangeDays(), itemsByDate);
  }

  container.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">Calendar</h1>
      <div class="calendar-nav">
        <button class="tb-btn" data-action="calendar-prev">←</button>
        <button class="tb-btn" data-action="calendar-today">Today</button>
        <button class="tb-btn" data-action="calendar-next">→</button>
      </div>
    </div>
    <div class="calendar-wrap">
      <div class="calendar-toolbar">
        <div class="calendar-view-switch">
          <button class="tb-btn ${calendarView === 'day' ? 'active' : ''}" data-action="calendar-set-view" data-value="day">Day</button>
          <button class="tb-btn ${calendarView === '3day' ? 'active' : ''}" data-action="calendar-set-view" data-value="3day">3 Day</button>
          <button class="tb-btn ${calendarView === 'workweek' ? 'active' : ''}" data-action="calendar-set-view" data-value="workweek">Work Week</button>
          <button class="tb-btn ${calendarView === '7day' ? 'active' : ''}" data-action="calendar-set-view" data-value="7day">7 Day</button>
          <button class="tb-btn ${calendarView === 'month' ? 'active' : ''}" data-action="calendar-set-view" data-value="month">Month</button>
          <button class="tb-btn ${calendarView === '3month' ? 'active' : ''}" data-action="calendar-set-view" data-value="3month">3 Month</button>
          <button class="tb-btn ${calendarView === '6month' ? 'active' : ''}" data-action="calendar-set-view" data-value="6month">6 Month</button>
        </div>
        <div class="calendar-filter-row">
          <label><input type="checkbox" data-role="calendar-filter-type" data-type="task" ${calendarFilters.task ? 'checked' : ''} /> Task</label>
          <label><input type="checkbox" data-role="calendar-filter-type" data-type="habit" ${calendarFilters.habit ? 'checked' : ''} /> Habit</label>
          <label><input type="checkbox" data-role="calendar-filter-type" data-type="other" ${calendarFilters.other ? 'checked' : ''} /> Other</label>
          <select class="input-field task-filter-select" data-role="calendar-filter-category">
            ${categories
              .map((category) => `<option value="${escapeHtml(category)}" ${calendarFilters.category === category ? 'selected' : ''}>${category === 'all' ? 'All Categories' : escapeHtml(category)}</option>`)
              .join('')}
          </select>
        </div>
      </div>
      ${calendarBody}
      <div class="calendar-agenda">
        <div class="calendar-agenda-title">Items on ${escapeHtml(calendarSelectedDateKey)}</div>
        <div class="calendar-agenda-list">
          ${selectedItems.length === 0 ? '<div class="settings-row-desc">No items for selected date.</div>' : ''}
          ${selectedItems
            .map(
              (item) => `
                <button class="calendar-agenda-item calendar-item-${item.type}" data-action="calendar-open-item" data-item-type="${item.type}" data-item-id="${escapeHtml(item.id)}">
                  <span>${escapeHtml(item.title)}</span>
                  <span>${escapeHtml(item.meta)} • ${escapeHtml(item.category || 'General')}</span>
                </button>
              `
            )
            .join('')}
        </div>
      </div>
    </div>
  `;
}

function renderAnalytics() {
  const container = document.getElementById('page-analytics');
  if (!container) return;
  container.innerHTML = '<div class="analytics-section"><h3>Analytics</h3><div class="settings-row-desc">Analytics rendering module hooks are ready.</div></div>';
}

function renderInsights() {
  const container = document.getElementById('page-insights');
  if (!container) return;
  container.innerHTML = '<div class="analytics-section"><h3>Insights</h3><div class="settings-row-desc">Insights rendering module hooks are ready.</div></div>';
}

function renderSettings() {
  const container = document.getElementById('page-settings');
  if (!container) return;

  const state = getState();
  const settings = state.settings || {};
  const tzCurrent = settings.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const timeZoneOptions = SETTINGS_TIME_ZONES.map(
    (tz) => `<option value="${escapeHtml(tz)}" ${tz === tzCurrent ? 'selected' : ''}>${escapeHtml(tz)}</option>`
  ).join('');

  container.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">Settings</h1>
      <button class="action-btn" data-action="settings-sync-now">Sync Now</button>
    </div>

    <div class="settings-stack">
      <section class="settings-card">
        <h3>Appearance</h3>
        <div class="settings-grid">
          <label class="settings-field">Theme
            <select class="input-field" data-role="settings-theme">
              <option value="light" ${settings.theme === 'light' ? 'selected' : ''}>Light</option>
              <option value="dark" ${settings.theme === 'dark' ? 'selected' : ''}>Dark</option>
              <option value="system" ${settings.theme === 'system' ? 'selected' : ''}>System</option>
            </select>
          </label>
          <label class="settings-field">Accent Color
            <input class="input-field" data-role="settings-accent" type="color" value="${escapeHtml(settings.accent || '#d4a373')}" />
          </label>
          <label class="settings-field">Accent Dark
            <input class="input-field" data-role="settings-accent-dark" type="color" value="${escapeHtml(settings.accentDark || '#c49363')}" />
          </label>
          <label class="settings-check"><input type="checkbox" data-role="settings-compact" ${settings.compact ? 'checked' : ''} /> Compact Layout</label>
        </div>
      </section>

      <section class="settings-card">
        <h3>Calendar & Time</h3>
        <div class="settings-grid">
          <label class="settings-field">Time Zone
            <select class="input-field" data-role="settings-timezone">${timeZoneOptions}</select>
          </label>
          <label class="settings-field">First Day of Week
            <select class="input-field" data-role="settings-firstday">
              <option value="mon" ${settings.firstday === 'mon' ? 'selected' : ''}>Monday</option>
              <option value="sun" ${settings.firstday === 'sun' ? 'selected' : ''}>Sunday</option>
            </select>
          </label>
        </div>
      </section>

      <section class="settings-card">
        <h3>Behavior</h3>
        <div class="settings-grid">
          <label class="settings-check"><input type="checkbox" data-role="settings-autolock" ${settings.autolock ? 'checked' : ''} /> Auto-lock</label>
          <label class="settings-check"><input type="checkbox" data-role="settings-fireworks" ${settings.fireworks ? 'checked' : ''} /> Fireworks Effects</label>
        </div>
      </section>

      <section class="settings-card">
        <h3>Cloud</h3>
        <div class="settings-grid">
          <label class="settings-field settings-wide">Supabase URL
            <input class="input-field" data-role="settings-supabase-url" type="text" value="${escapeHtml(settings.supabaseUrl || '')}" placeholder="https://...supabase.co" />
          </label>
          <label class="settings-field settings-wide">Supabase Anon Key
            <input class="input-field" data-role="settings-supabase-key" type="password" value="${escapeHtml(settings.supabaseAnonKey || '')}" placeholder="sb_publishable_..." />
          </label>
          <label class="settings-check"><input type="checkbox" data-role="settings-google-auth" ${settings.googleAuthEnabled ? 'checked' : ''} /> Google Auth Enabled</label>
        </div>
      </section>

      <section class="settings-card">
        <h3>Account & Data</h3>
        <div class="settings-actions">
          <button class="tb-btn" data-action="settings-signout">Sign Out</button>
          <button class="tb-btn" data-action="settings-export">Export Backup</button>
          <button class="tb-btn" data-action="settings-import">Import Backup</button>
          <button class="tb-btn" data-action="settings-reset-local">Reset Local Data</button>
          <input data-role="settings-import-file" type="file" accept="application/json" hidden />
        </div>
      </section>
    </div>
  `;
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
  if (view === 'analytics') renderAnalytics();
  if (view === 'insights') renderInsights();
  if (view === 'settings') renderSettings();
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
        await persistSnapshot();
      }
    });
  });
}

function ensureModals() {
  const taskModal = document.getElementById('task-modal');
  if (taskModal && !taskModal.dataset.initialized) {
    taskModal.dataset.initialized = '1';
    taskModal.innerHTML = `
      <div class="modal">
        <h2 id="task-modal-title">Task</h2>
        <div class="form-group"><label>Title</label><input id="task-title-input" class="input-field" type="text" /></div>
        <div class="form-group"><label>Due Date</label><input id="task-date-input" class="input-field" type="date" /></div>
        <div class="modal-footer">
          <button class="btn btn-cancel" data-action="close-modal" data-modal="task-modal">Cancel</button>
          <button class="btn btn-save" data-action="save-task-modal">Save</button>
        </div>
      </div>
    `;
  }

  const habitModal = document.getElementById('habit-modal');
  if (habitModal && !habitModal.dataset.initialized) {
    habitModal.dataset.initialized = '1';
    habitModal.innerHTML = `
      <div class="modal">
        <h2 id="habit-modal-title">Habit</h2>
        <div class="form-group"><label>Name</label><input id="habit-name-input" class="input-field" type="text" /></div>
        <div class="form-group"><label>Category</label><input id="habit-category-input" class="input-field" type="text" /></div>
        <div class="modal-footer">
          <button class="btn btn-cancel" data-action="close-modal" data-modal="habit-modal">Cancel</button>
          <button class="btn btn-save" data-action="save-habit-modal">Save</button>
        </div>
      </div>
    `;
  }

  const noteModal = document.getElementById('note-modal');
  if (noteModal && !noteModal.dataset.initialized) {
    noteModal.dataset.initialized = '1';
    noteModal.innerHTML = `
      <div class="modal">
        <h2 id="note-modal-title">Note</h2>
        <div class="form-group"><label>Title</label><input id="note-title-input" class="input-field" type="text" /></div>
        <div class="form-group"><label>Body</label><textarea id="note-body-input" class="input-field" rows="5"></textarea></div>
        <div class="modal-footer">
          <button class="btn btn-cancel" data-action="close-modal" data-modal="note-modal">Cancel</button>
          <button class="btn btn-save" data-action="save-note-modal">Save</button>
        </div>
      </div>
    `;
  }

  const reflectionModal = document.getElementById('habit-reflection-modal');
  if (reflectionModal && !reflectionModal.dataset.initialized) {
    reflectionModal.dataset.initialized = '1';
    reflectionModal.innerHTML = `
      <div class="modal">
        <h2>Habit Reflection</h2>
        <div class="settings-row-desc" id="habit-reflection-label"></div>
        <div class="form-group"><textarea id="habit-reflection-input" class="input-field" rows="5" placeholder="Write your reflection..."></textarea></div>
        <div class="modal-footer">
          <button class="btn btn-cancel" data-action="close-modal" data-modal="habit-reflection-modal">Cancel</button>
          <button class="btn btn-save" data-action="save-habit-reflection">Save Reflection</button>
        </div>
      </div>
    `;
  }

  const authGate = document.getElementById('auth-gate');
  if (authGate && !authGate.dataset.initialized) {
    authGate.dataset.initialized = '1';
    authGate.innerHTML = `
      <div class="auth-card">
        <div class="auth-title">2DoByU</div>
        <div class="auth-sub">Sign in to continue</div>
        <div class="auth-form show">
          <input id="auth-email" type="email" class="input-field" placeholder="Email" />
          <input id="auth-password" type="password" class="input-field" placeholder="Password" />
          <div class="auth-actions">
            <button class="settings-btn" data-action="auth-signup">Create Account</button>
            <button class="settings-btn primary" data-action="auth-signin">Sign In</button>
          </div>
        </div>
      </div>
    `;
  }
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
  if (modal) modal.style.display = 'flex';
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
  if (modal) modal.style.display = 'none';
}

function triggerHapticFeedback() {
  if (!('vibrate' in navigator)) return;
  navigator.vibrate(12);
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

  const title = titleInput.value.trim();
  if (!title) return;

  const editId = titleInput.dataset.editTaskId;

  setState((prev) => {
    const next = structuredClone(prev);

    if (editId) {
      const found = getTaskById(editId);
      if (found) {
        next.tasks[found.col][found.idx] = {
          ...next.tasks[found.col][found.idx],
          title,
          dueDate: dateInput.value || ''
        };
      }
      return next;
    }

    next.tasks.todo.push({
      id: next.taskIdCounter,
      title,
      dueDate: dateInput.value || '',
      priority: 'medium',
      tag: '',
      notes: ''
    });
    next.taskIdCounter += 1;
    return next;
  });

  closeModal('task-modal');
  await persistSnapshot();
}

async function saveHabitFromModal() {
  const nameInput = document.getElementById('habit-name-input');
  const categoryInput = document.getElementById('habit-category-input');
  if (!nameInput || !categoryInput) return;

  const name = nameInput.value.trim();
  if (!name) return;

  const editId = nameInput.dataset.editHabitId;

  setState((prev) => {
    const next = structuredClone(prev);

    if (editId != null && editId !== '') {
      const idx = Number(editId);
      if (next.habits[idx]) {
        next.habits[idx] = {
          ...next.habits[idx],
          name,
          category: categoryInput.value || 'Other'
        };
      }
      return next;
    }

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

  closeModal('habit-modal');
  await persistSnapshot();
}

async function saveNoteFromModal() {
  const titleInput = document.getElementById('note-title-input');
  const bodyInput = document.getElementById('note-body-input');
  if (!titleInput || !bodyInput) return;

  const title = titleInput.value.trim();
  const body = bodyInput.value.trim();
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

  await persistSnapshot();
}

async function toggleHabitSkipToday(habitId) {
  const dateKey = new Date().toISOString().slice(0, 10);
  await toggleHabitSkipByDate(habitId, dateKey);
}

async function handleAuthSignIn() {
  const emailInput = document.getElementById('auth-email');
  const passwordInput = document.getElementById('auth-password');
  if (!emailInput || !passwordInput) return;

  await signIn(emailInput.value.trim(), passwordInput.value);
}

async function handleAuthSignUp() {
  const emailInput = document.getElementById('auth-email');
  const passwordInput = document.getElementById('auth-password');
  if (!emailInput || !passwordInput) return;

  await signUp(emailInput.value.trim(), passwordInput.value);
}

function applyAuthGateVisibility() {
  const gate = document.getElementById('auth-gate');
  if (!gate) return;

  const state = getState();
  const showAuth = Boolean(state.ui.authModal || !state.user);
  gate.classList.toggle('hidden', !showAuth);
}

async function updateSettings(nextPartial) {
  patchState({
    settings: {
      ...getState().settings,
      ...nextPartial
    }
  });
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
        await handleAuthSignIn();
        return;
      }

      if (action === 'auth-signup') {
        await handleAuthSignUp();
        return;
      }

      if (action === 'clear-task-filters') {
        taskFilters = { query: '', sort: 'default', due: 'all' };
        taskSortMenuOpen = false;
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
        const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
        const href = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = href;
        link.download = `2dobyu-backup-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(href);
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
        applySettingsVisuals();
        await persistSnapshot();
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
      triggerHapticFeedback();
      await toggleHabitDayByDate(habitDay.dataset.id, habitDay.dataset.date);
      return;
    }

    const taskCard = event.target.closest('[data-task-id]');
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
  });

  applySettingsVisuals();
  renderApp();
  applyAuthGateVisibility();
}
