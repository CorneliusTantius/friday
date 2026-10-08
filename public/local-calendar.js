import { buildMonthDays, countEventsByDay, dayKeyInTimeZone, formatEventTime, localDayKey, parseLocalDayKey, shiftMonth } from './calendar-view.js';

const form = document.querySelector('#calendar-event-form');
const titleInput = document.querySelector('#calendar-title');
const descriptionInput = document.querySelector('#calendar-description');
const startInput = document.querySelector('#calendar-start');
const endInput = document.querySelector('#calendar-end');
const zoneLabel = document.querySelector('#calendar-time-zone');
const eventList = document.querySelector('#calendar-event-list');
const status = document.querySelector('#calendar-status');
const saveButton = document.querySelector('#calendar-save');
const cancelButton = document.querySelector('#calendar-cancel');
const refreshButton = document.querySelector('#calendar-refresh');
const monthLabel = document.querySelector('#calendar-month-label');
const monthGrid = document.querySelector('#calendar-month-grid');
const monthDays = document.querySelector('#calendar-month-days');
const selectedDateLabel = document.querySelector('#calendar-selected-date');
const previousMonthButton = document.querySelector('#calendar-previous-month');
const nextMonthButton = document.querySelector('#calendar-next-month');
const todayButton = document.querySelector('#calendar-today');
const addEventButton = document.querySelector('#calendar-add-event');
const mobileDateInput = document.querySelector('#calendar-mobile-date');
const mobileAgenda = document.querySelector('#calendar-mobile-agenda');
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
let events = [];
let editingId = null;
let selectedDay = new Date();
let visibleMonth = new Date(selectedDay.getFullYear(), selectedDay.getMonth(), 1);

zoneLabel.textContent = timeZone;

async function request(url, options) {
  const response = await fetch(url, { credentials: 'same-origin', ...options, headers: { ...(options?.headers || {}), ...(options?.body ? { 'Content-Type': 'application/json' } : {}) } });
  const result = await response.json().catch(() => ({}));
  if (response.status === 401) location.replace('/login?notice=login-required');
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
  return result;
}

function localValue(date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function eventDayKey(event) {
  return dayKeyInTimeZone(new Date(event.start), timeZone);
}

function dateLabel(event) {
  return new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone }).format(new Date(event.start));
}

function timeLabel(event) {
  return formatEventTime(event, timeZone);
}

function eventCountLabel(count) {
  return `${count} ${count === 1 ? 'event' : 'events'}`;
}

function renderMobileAgenda() {
  mobileAgenda.replaceChildren();
  const monthPrefix = `${visibleMonth.getFullYear()}-${String(visibleMonth.getMonth() + 1).padStart(2, '0')}-`;
  const monthEvents = events.filter((event) => eventDayKey(event).startsWith(monthPrefix));
  if (!monthEvents.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-placeholder';
    empty.textContent = 'No events this month.';
    mobileAgenda.append(empty);
    return;
  }
  for (const event of monthEvents) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'calendar-mobile-event';
    button.setAttribute('aria-label', `${event.title}, ${dateLabel(event)}, ${timeLabel(event)}. Show day agenda`);
    const title = document.createElement('strong');
    title.textContent = event.title;
    const time = document.createElement('span');
    time.textContent = `${dateLabel(event)} · ${timeLabel(event)}`;
    button.append(title, time);
    button.addEventListener('click', () => {
      selectedDay = parseLocalDayKey(eventDayKey(event));
      visibleMonth = new Date(selectedDay.getFullYear(), selectedDay.getMonth(), 1);
      render();
      document.querySelector('#calendar-agenda-heading').focus();
    });
    mobileAgenda.append(button);
  }
}

function renderMonth() {
  const year = visibleMonth.getFullYear();
  const month = visibleMonth.getMonth();
  const counts = countEventsByDay(events, timeZone);
  const monthName = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(visibleMonth);
  monthLabel.textContent = monthName;
  monthGrid.setAttribute('aria-label', `${monthName} calendar`);
  mobileDateInput.value = localDayKey(selectedDay);
  monthDays.replaceChildren();
  renderMobileAgenda();

  const days = buildMonthDays(year, month, selectedDay);
  for (let index = 0; index < days.length; index += 7) {
    const row = document.createElement('tr');
    for (const day of days.slice(index, index + 7)) {
      const cell = document.createElement('td');
      const button = document.createElement('button');
      const count = counts.get(day.key) || 0;
      button.type = 'button';
      button.dataset.day = day.key;
      button.className = `calendar-day-button${day.inMonth ? '' : ' outside-month'}${day.selected ? ' selected' : ''}${day.today ? ' today' : ''}`;
      button.setAttribute('aria-label', `${dateLabel({ start: `${day.key}T12:00:00`, timeZone })}${count ? `, ${eventCountLabel(count)}` : ', no events'}`);
      button.setAttribute('aria-pressed', String(day.selected));
      if (day.today) button.setAttribute('aria-current', 'date');
      const number = document.createElement('span');
      number.className = 'calendar-day-number';
      number.textContent = String(day.date.getDate());
      button.append(number);
      if (count) {
        const indicator = document.createElement('span');
        indicator.className = 'calendar-event-indicator';
        indicator.setAttribute('aria-hidden', 'true');
        indicator.textContent = String(count);
        button.append(indicator);
      }
      button.addEventListener('click', () => {
        selectedDay = day.date;
        visibleMonth = new Date(day.date.getFullYear(), day.date.getMonth(), 1);
        render();
        monthDays.querySelector(`[data-day="${day.key}"]`)?.focus();
      });
      cell.append(button);
      row.append(cell);
    }
    monthDays.append(row);
  }
}

function renderAgenda() {
  const selectedKey = localDayKey(selectedDay);
  selectedDateLabel.textContent = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(selectedDay);
  eventList.replaceChildren();
  const selectedEvents = events.filter((event) => eventDayKey(event) === selectedKey);
  if (!selectedEvents.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-placeholder';
    empty.textContent = 'No events on this day.';
    eventList.append(empty);
    return;
  }

  for (const event of selectedEvents) {
    const article = document.createElement('article');
    article.className = 'local-calendar-event';
    const details = document.createElement('div');
    const name = document.createElement('h3');
    name.textContent = event.title;
    const time = document.createElement('time');
    time.dateTime = event.start;
    time.textContent = timeLabel(event);
    details.append(name, time);
    if (event.description) {
      const description = document.createElement('p');
      description.textContent = event.description;
      details.append(description);
    }
    const actions = document.createElement('div');
    actions.className = 'socials-actions calendar-event-actions';
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'secondary';
    edit.textContent = 'Edit';
    edit.setAttribute('aria-label', `Edit ${event.title}`);
    edit.addEventListener('click', () => beginEdit(event));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'secondary danger-button';
    remove.textContent = 'Delete';
    remove.setAttribute('aria-label', `Delete ${event.title}`);
    remove.addEventListener('click', () => void deleteEvent(event));
    actions.append(edit, remove);
    article.append(details, actions);
    eventList.append(article);
  }
}

function render() {
  renderMonth();
  renderAgenda();
}

async function loadEvents() {
  refreshButton.disabled = true;
  try {
    events = (await request('/api/calendar/events')).events || [];
    render();
  } catch (error) {
    status.textContent = error.message;
    eventList.replaceChildren();
  } finally { refreshButton.disabled = false; }
}

function resetForm() {
  editingId = null;
  form.reset();
  const now = new Date();
  let start;
  if (localDayKey(selectedDay) === localDayKey(now)) {
    start = new Date(now);
    start.setMinutes(0, 0, 0);
    start.setHours(start.getHours() + 1);
  } else {
    start = new Date(selectedDay.getFullYear(), selectedDay.getMonth(), selectedDay.getDate(), 9);
  }
  const end = new Date(start.getTime() + 60 * 60_000);
  startInput.value = localValue(start);
  endInput.value = localValue(end);
  saveButton.textContent = 'Save event';
  cancelButton.hidden = true;
  document.querySelector('#calendar-form-heading').textContent = 'New event';
}

function beginCreate() {
  resetForm();
  status.textContent = '';
  titleInput.focus();
}

function beginEdit(event) {
  editingId = event.id;
  titleInput.value = event.title;
  descriptionInput.value = event.description;
  startInput.value = localValue(new Date(event.start));
  endInput.value = localValue(new Date(event.end));
  saveButton.textContent = 'Save changes';
  cancelButton.hidden = false;
  document.querySelector('#calendar-form-heading').textContent = 'Edit event';
  status.textContent = `Editing event in ${event.timeZone}. Times are shown in ${timeZone}.`;
  titleInput.focus();
}

function moveVisibleMonth(amount) {
  visibleMonth = shiftMonth(visibleMonth, amount);
  const dayOfMonth = Math.min(selectedDay.getDate(), new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() + 1, 0).getDate());
  selectedDay = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth(), dayOfMonth);
  render();
}

async function deleteEvent(event) {
  if (!confirm(`Delete “${event.title}”?`)) return;
  try {
    await request(`/api/calendar/events/${event.id}`, { method: 'DELETE' });
    status.textContent = 'Event deleted.';
    if (editingId === event.id) resetForm();
    await loadEvents();
  } catch (error) { status.textContent = error.message; }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!form.reportValidity()) return;
  saveButton.disabled = true;
  status.textContent = editingId ? 'Saving changes…' : 'Saving event…';
  try {
    const start = new Date(startInput.value);
    const body = {
      title: titleInput.value,
      description: descriptionInput.value,
      start: start.toISOString(),
      end: new Date(endInput.value).toISOString(),
      timeZone,
    };
    await request(editingId ? `/api/calendar/events/${editingId}` : '/api/calendar/events', {
      method: editingId ? 'PUT' : 'POST', body: JSON.stringify(body),
    });
    selectedDay = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    visibleMonth = new Date(selectedDay.getFullYear(), selectedDay.getMonth(), 1);
    status.textContent = editingId ? 'Event updated.' : 'Event created.';
    resetForm();
    await loadEvents();
  } catch (error) { status.textContent = error.message; }
  finally { saveButton.disabled = false; }
});

previousMonthButton.addEventListener('click', () => moveVisibleMonth(-1));
nextMonthButton.addEventListener('click', () => moveVisibleMonth(1));
todayButton.addEventListener('click', () => {
  selectedDay = new Date();
  visibleMonth = new Date(selectedDay.getFullYear(), selectedDay.getMonth(), 1);
  render();
});
mobileDateInput.addEventListener('change', () => {
  if (!mobileDateInput.value) return;
  selectedDay = parseLocalDayKey(mobileDateInput.value);
  visibleMonth = new Date(selectedDay.getFullYear(), selectedDay.getMonth(), 1);
  render();
});
addEventButton.addEventListener('click', beginCreate);
cancelButton.addEventListener('click', resetForm);
refreshButton.addEventListener('click', () => void loadEvents());
document.addEventListener('friday:feature-change', (event) => {
  if (event.detail === 'calendar') void loadEvents();
});
resetForm();
render();
void loadEvents();
