'use strict';

const PAGE_SIZE = 50;
const searchForm = document.getElementById('admin-search');
const searchInput = document.getElementById('admin-query');
const usersBody = document.getElementById('admin-users');
const notice = document.getElementById('admin-notice');
const resultCount = document.getElementById('admin-result-count');
const pageLabel = document.getElementById('admin-page-label');
const previousButton = document.getElementById('admin-previous');
const nextButton = document.getElementById('admin-next');
let offset = 0;
let total = 0;

async function request(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers
    }
  });
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error('Сервер вернул некорректный ответ.');
  }
  if (!response.ok) throw new Error(data.error || 'Не удалось выполнить запрос.');
  return data;
}

function showNotice(message, kind = 'error') {
  notice.textContent = message;
  notice.className = `admin-notice ${kind}`;
  notice.hidden = false;
}

function formatDate(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium' }).format(new Date(value));
}

function actionButton(label, className, onClick, disabled = false) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `admin-action${className ? ` ${className}` : ''}`;
  button.textContent = label;
  button.disabled = disabled;
  button.addEventListener('click', onClick);
  return button;
}

async function runAction(action) {
  notice.hidden = true;
  try {
    await action();
    await loadUsers();
    showNotice('Изменения сохранены.', 'success');
  } catch (error) {
    showNotice(error.message);
  }
}

function renderUser(user) {
  const row = document.createElement('tr');
  const accountCell = document.createElement('td');
  const username = document.createElement('span');
  username.className = 'admin-username';
  username.textContent = user.username;
  accountCell.append(username);
  if (user.admin) {
    const badge = document.createElement('span');
    badge.className = 'admin-badge';
    badge.textContent = 'Администратор';
    accountCell.append(badge);
  }

  const createdCell = document.createElement('td');
  createdCell.textContent = formatDate(user.createdAt);

  const subscriptionCell = document.createElement('td');
  const subscription = document.createElement('span');
  subscription.className = user.subscription.active
    ? 'admin-status-active'
    : user.subscription.expiresAt ? 'admin-status-expired' : 'admin-status-none';
  subscription.textContent = user.subscription.active
    ? `Активна до ${formatDate(user.subscription.expiresAt)}`
    : user.subscription.expiresAt
      ? `Истекла ${formatDate(user.subscription.expiresAt)}`
      : 'Нет подписки';
  subscriptionCell.append(subscription);

  const actionsCell = document.createElement('td');
  const actions = document.createElement('div');
  actions.className = 'admin-actions';
  const days = document.createElement('select');
  days.className = 'admin-days';
  days.setAttribute('aria-label', `Срок подписки для ${user.username}`);
  for (const value of [30, 90, 365]) {
    const option = document.createElement('option');
    option.value = String(value);
    option.textContent = `${value} дней`;
    days.append(option);
  }
  actions.append(days);
  actions.append(actionButton('Выдать', '', () => runAction(async () => {
    await request(`/api/admin/users/${user.id}/subscription`, {
      method: 'POST',
      body: JSON.stringify({ days: Number(days.value) })
    });
  })));
  actions.append(actionButton('Отозвать', '', () => {
    if (!window.confirm(`Отозвать подписку у аккаунта «${user.username}»?`)) return;
    return runAction(() => request(`/api/admin/users/${user.id}/subscription/revoke`, { method: 'POST' }));
  }, !user.subscription.active));
  if (!user.admin) {
    actions.append(actionButton('Удалить', 'danger', () => {
      if (!window.confirm(`Удалить аккаунт «${user.username}»? Платёжные записи останутся обезличенными.`)) return;
      return runAction(() => request(`/api/admin/users/${user.id}`, { method: 'DELETE' }));
    }));
  }
  actionsCell.append(actions);
  row.append(accountCell, createdCell, subscriptionCell, actionsCell);
  return row;
}

async function loadUsers() {
  const query = new URLSearchParams({
    q: searchInput.value.trim(),
    limit: String(PAGE_SIZE),
    offset: String(offset)
  });
  const data = await request(`/api/admin/users?${query}`);
  total = data.total;
  usersBody.replaceChildren();
  if (data.users.length) {
    usersBody.append(...data.users.map(renderUser));
  } else {
    const emptyRow = document.createElement('tr');
    const emptyCell = document.createElement('td');
    emptyCell.className = 'admin-empty';
    emptyCell.colSpan = 4;
    emptyCell.textContent = 'Аккаунты не найдены.';
    emptyRow.append(emptyCell);
    usersBody.append(emptyRow);
  }
  resultCount.textContent = `Найдено: ${total}`;
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  pageLabel.textContent = `Страница ${currentPage} из ${pages}`;
  previousButton.disabled = offset === 0;
  nextButton.disabled = offset + PAGE_SIZE >= total;
}

searchForm.addEventListener('submit', (event) => {
  event.preventDefault();
  offset = 0;
  loadUsers().catch((error) => showNotice(error.message));
});

document.getElementById('admin-refresh').addEventListener('click', () => {
  loadUsers().catch((error) => showNotice(error.message));
});

previousButton.addEventListener('click', () => {
  offset = Math.max(0, offset - PAGE_SIZE);
  loadUsers().catch((error) => showNotice(error.message));
});

nextButton.addEventListener('click', () => {
  if (offset + PAGE_SIZE < total) offset += PAGE_SIZE;
  loadUsers().catch((error) => showNotice(error.message));
});

document.getElementById('admin-logout').addEventListener('click', async () => {
  try {
    await request('/api/logout', { method: 'POST' });
    window.location.assign('/');
  } catch (error) {
    showNotice(error.message);
  }
});

loadUsers().catch((error) => showNotice(error.message));
