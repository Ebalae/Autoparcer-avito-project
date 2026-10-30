const STORAGE_KEY = 'avito-radar.pages.v1';
const THEME_STORAGE_KEY = 'avito-radar.theme.v1';

const form = document.getElementById('monitor-form');
const pageNav = document.getElementById('page-nav');
const pageHeading = document.getElementById('page-heading');
const pageNameInput = document.getElementById('page-name');
const urlInput = document.getElementById('search-url');
const intervalInput = document.getElementById('interval');
const addPageButton = document.getElementById('add-page-button');
const saveButton = document.getElementById('save-button');
const startButton = document.getElementById('start-button');
const stopButton = document.getElementById('stop-button');
const resumeButton = document.getElementById('resume-button');
const deletePageButton = document.getElementById('delete-page-button');
const feed = document.getElementById('feed');
const emptyState = document.getElementById('empty-state');
const count = document.getElementById('listing-count');
const feedDescription = document.getElementById('feed-description');
const lastCheck = document.getElementById('last-check');
const statusMessage = document.getElementById('status-message');
const statusTime = document.getElementById('status-time');
const activity = document.querySelector('.activity');
const monitorLabel = document.getElementById('monitor-label');
const liveChip = document.querySelector('.live-chip');
const settingsButton = document.getElementById('settings-button');
const settingsDialog = document.getElementById('settings-dialog');
const closeSettingsButton = document.getElementById('close-settings-button');
const deleteConfirmDialog = document.getElementById('delete-confirm-dialog');
const deleteConfirmMessage = document.getElementById('delete-confirm-message');
const cancelDeleteButton = document.getElementById('cancel-delete-button');
const confirmDeleteButton = document.getElementById('confirm-delete-button');
const themeToggle = document.getElementById('theme-toggle');
const windowMinimizeButton = document.getElementById('window-minimize');
const windowMaximizeButton = document.getElementById('window-maximize');
const windowCloseButton = document.getElementById('window-close');
const windowResizeHandles = document.querySelectorAll('.window-resize-handle');
const accountName = document.getElementById('account-name');
const subscriptionStatus = document.getElementById('subscription-status');
const accountError = document.getElementById('account-error');
const accountLoginButton = document.getElementById('account-login-button');
const accountRefreshButton = document.getElementById('account-refresh-button');
const accountSubscribeButton = document.getElementById('account-subscribe-button');
const accountLogoutButton = document.getElementById('account-logout-button');
const accountDialog = document.getElementById('account-dialog');
const accountLoginForm = document.getElementById('account-login-form');
const accountLoginError = document.getElementById('account-login-error');
const accountLoginSubmit = document.getElementById('account-login-submit');
const accountDialogClose = document.getElementById('account-dialog-close');
const accountOpenProfile = document.getElementById('account-open-profile');

let pages = [];
let selectedPageId;
let isDirty = false;
let isWindowResizing = false;
let accountState = { loading: true, authenticated: false, user: null, error: '' };
const runningPages = new Set();
const pausedPages = new Set();
const listingsByPage = new Map();
const statusByPage = new Map();
const animatedListingIds = new Set();
const closingDialogs = new WeakSet();
let deleteConfirmationResolver;

function hasActiveSubscription() {
  const subscription = accountState.user && accountState.user.subscription;
  const expiresAt = subscription && subscription.expiresAt
    ? Date.parse(subscription.expiresAt)
    : NaN;
  return Boolean(accountState.authenticated && subscription && subscription.active
    && Number.isFinite(expiresAt) && expiresAt > Date.now());
}

function renderAccountState(state) {
  accountState = { ...state, loading: false };
  const user = accountState.user;
  const subscription = user && user.subscription;
  const active = hasActiveSubscription();
  accountName.textContent = user ? user.username : 'Профиль Autoparcer';
  subscriptionStatus.className = `subscription-status${active ? ' active' : (accountState.authenticated ? ' expired' : '')}`;
  if (accountState.loading) {
    subscriptionStatus.textContent = 'Проверяем подписку…';
  } else if (accountState.error) {
    subscriptionStatus.textContent = accountState.authenticated
      ? 'Не удалось обновить статус подписки.'
      : 'Не удалось проверить профиль.';
  } else if (!accountState.authenticated) {
    subscriptionStatus.textContent = 'Войдите, чтобы проверить подписку.';
  } else if (active) {
    const expires = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'long' })
      .format(new Date(subscription.expiresAt));
    subscriptionStatus.textContent = `Подписка активна до ${expires}`;
  } else if (subscription.expiresAt) {
    const expires = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'long' })
      .format(new Date(subscription.expiresAt));
    subscriptionStatus.textContent = `Подписка истекла ${expires}`;
  } else {
    subscriptionStatus.textContent = 'Подписка не оформлена.';
  }

  accountError.textContent = accountState.error || '';
  accountError.hidden = !accountState.error;
  accountLoginButton.hidden = Boolean(accountState.authenticated);
  accountRefreshButton.hidden = !accountState.authenticated;
  accountSubscribeButton.hidden = !accountState.authenticated || active;
  accountLogoutButton.hidden = !accountState.authenticated;
  renderControls();
}

async function initializeAccount() {
  try {
    const state = await window.avitoRadar.getAccount();
    renderAccountState(state);
    if (!state.authenticated && !accountDialog.open) accountDialog.showModal();
  } catch (error) {
    renderAccountState({ authenticated: false, user: null, error: error.message });
    if (!accountDialog.open) accountDialog.showModal();
  }
}

function applyTheme(theme) {
  const isDark = theme === 'dark';
  document.documentElement.dataset.theme = isDark ? 'dark' : 'light';
  const label = isDark ? 'Включить светлую тему' : 'Включить тёмную тему';
  themeToggle.setAttribute('aria-label', label);
  themeToggle.setAttribute('aria-pressed', String(isDark));
  themeToggle.title = label;
}

function closeDialogAnimated(dialog, returnValue = '') {
  if (!dialog.open || closingDialogs.has(dialog)) return;
  closingDialogs.add(dialog);
  dialog.classList.add('dialog-closing');
  const finishClose = (event) => {
    if (event.target !== dialog || event.animationName !== 'dialog-out') return;
    dialog.removeEventListener('animationend', finishClose);
    dialog.classList.remove('dialog-closing');
    closingDialogs.delete(dialog);
    if (dialog.open) dialog.close(returnValue);
  };
  dialog.addEventListener('animationend', finishClose);
}

function setWindowMaximized(isMaximized) {
  document.documentElement.classList.toggle('window-maximized', isMaximized);
  const label = isMaximized ? 'Восстановить' : 'Развернуть';
  windowMaximizeButton.setAttribute('aria-label', label);
  windowMaximizeButton.title = label;
}

function startWindowResize(event) {
  if (event.button !== 0 || document.documentElement.classList.contains('window-maximized')) return;
  event.preventDefault();
  event.currentTarget.setPointerCapture(event.pointerId);
  isWindowResizing = true;
  window.avitoRadar.startWindowResize(event.currentTarget.dataset.edge).catch((error) => {
    isWindowResizing = false;
    setLocalStatus(error.message || 'Не удалось изменить размер окна.', 'error');
  });
}

function endWindowResize() {
  if (!isWindowResizing) return;
  isWindowResizing = false;
  window.avitoRadar.endWindowResize().catch((error) => {
    setLocalStatus(error.message || 'Не удалось завершить изменение размера окна.', 'error');
  });
}

function createPage(name) {
  return {
    id: crypto.randomUUID(),
    name,
    url: '',
    intervalSeconds: 60
  };
}

function validatePageUrl(url) {
  if (!url) return;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Введите корректную ссылку на поиск Avito.');
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'www.avito.ru') {
    throw new Error('Поддерживаются только HTTPS-ссылки с www.avito.ru.');
  }
}

function persistPages(nextPages) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(nextPages));
  } catch (error) {
    throw new Error(`Не удалось сохранить настройки страниц: ${error.message}`);
  }
}

function loadPages() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === null) {
    const initialPage = createPage('Страница 1');
    persistPages([initialPage]);
    return [initialPage];
  }

  let parsed;
  try {
    parsed = JSON.parse(saved);
  } catch {
    throw new Error('Не удалось прочитать сохранённые страницы Avito. Очистите данные приложения и запустите его снова.');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('Файл настроек страниц Avito имеет неверный формат.');
  }

  const ids = new Set();
  const loadedPages = parsed.map((page, index) => {
    if (!page || typeof page.id !== 'string' || !page.id || ids.has(page.id)) {
      throw new Error('В настройках найдена страница с неверным или повторяющимся ID.');
    }
    ids.add(page.id);
    const name = typeof page.name === 'string' && page.name.trim()
      ? page.name.trim().slice(0, 60)
      : `Страница ${index + 1}`;
    const url = typeof page.url === 'string' ? page.url.trim() : '';
    const intervalSeconds = Number(page.intervalSeconds);
    if (!Number.isInteger(intervalSeconds) || intervalSeconds < 5 || intervalSeconds > 3600) {
      throw new Error(`У страницы «${name}» некорректный интервал проверки.`);
    }
    validatePageUrl(url);
    return { id: page.id, name, url, intervalSeconds };
  });

  if (loadedPages.length) return loadedPages;
  const initialPage = createPage('Страница 1');
  persistPages([initialPage]);
  return [initialPage];
}

function getSelectedPage() {
  return pages.find((page) => page.id === selectedPageId);
}

function setLocalStatus(message, kind = 'info') {
  if (!selectedPageId) {
    statusMessage.textContent = message;
    statusTime.textContent = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    activity.classList.toggle('success', kind === 'success');
    activity.classList.toggle('error', kind === 'error');
    return;
  }
  const previous = statusByPage.get(selectedPageId) || {};
  statusByPage.set(selectedPageId, {
    ...previous,
    message,
    kind,
    at: new Date().toISOString(),
    needsResume: false
  });
  renderStatus();
}

function renderPageNav() {
  pageNav.replaceChildren();
  pages.forEach((page) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `page-nav-item${page.id === selectedPageId ? ' selected' : ''}`;
    const dot = document.createElement('span');
    dot.className = `page-state-dot${pausedPages.has(page.id) ? ' paused' : runningPages.has(page.id) ? ' running' : ''}`;
    const name = document.createElement('span');
    name.className = 'page-nav-name';
    name.textContent = page.name;
    button.append(dot, name);
    button.addEventListener('click', () => {
      selectPage(page.id).catch((error) => setLocalStatus(error.message, 'error'));
    });
    pageNav.append(button);
  });
}

function renderStatus() {
  const status = statusByPage.get(selectedPageId);
  lastCheck.textContent = status && status.lastSuccessfulCheckAt
    ? `Последняя успешная проверка: ${new Date(status.lastSuccessfulCheckAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })} · карточек: ${status.lastListingCount}`
    : 'Успешной проверки ещё не было';
  const anotherPageRunning = [...runningPages].some((pageId) => pageId !== selectedPageId);
  statusMessage.textContent = status
    ? status.message
    : anotherPageRunning
      ? 'Остановите другую страницу перед запуском этой.'
      : 'Готов к работе';
  statusTime.textContent = status
    ? new Date(status.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    : '';
  activity.classList.toggle('success', Boolean(status && status.kind === 'success'));
  activity.classList.toggle('error', Boolean(status && status.kind === 'error'));

  if (pausedPages.has(selectedPageId)) {
    monitorLabel.textContent = 'Ожидает проверки';
    liveChip.classList.remove('active');
    resumeButton.hidden = false;
    resumeButton.textContent = status && status.resumeLabel ? status.resumeLabel : 'Продолжить';
  } else if (runningPages.has(selectedPageId)) {
    monitorLabel.textContent = 'Мониторинг активен';
    liveChip.classList.add('active');
    resumeButton.hidden = true;
  } else if (anotherPageRunning) {
    monitorLabel.textContent = 'Активна другая страница';
    liveChip.classList.add('active');
    resumeButton.hidden = true;
  } else {
    monitorLabel.textContent = 'Не запущен';
    liveChip.classList.remove('active');
    resumeButton.hidden = true;
  }
  resumeButton.disabled = !hasActiveSubscription();
}

function createImagePlaceholder() {
  const placeholder = document.createElement('div');
  placeholder.className = 'listing-image listing-placeholder';
  placeholder.textContent = '◇';
  return placeholder;
}

function createListingRow(listing) {
  const row = document.createElement('article');
  row.className = listing.isNew ? 'listing listing-new' : 'listing';
  const animationKey = `${selectedPageId}:${listing.id}`;
  if (listing.isNew && !animatedListingIds.has(animationKey)) {
    animatedListingIds.add(animationKey);
    row.classList.add('listing-enter');
  }

  if (listing.image) {
    const image = document.createElement('img');
    image.className = 'listing-image';
    image.alt = '';
    image.src = listing.image;
    image.referrerPolicy = 'no-referrer';
    image.addEventListener('error', () => image.replaceWith(createImagePlaceholder()), { once: true });
    row.append(image);
  } else {
    row.append(createImagePlaceholder());
  }

  const content = document.createElement('div');
  content.className = 'listing-content';
  const title = document.createElement('a');
  title.className = 'listing-title';
  title.href = listing.url;
  title.textContent = listing.title;
  title.addEventListener('click', async (event) => {
    event.preventDefault();
    try {
      await window.avitoRadar.openExternal(listing.url);
    } catch (error) {
      setLocalStatus(error.message, 'error');
    }
  });
  const tag = document.createElement('span');
  tag.className = listing.isNew ? 'new-tag' : 'old-tag';
  tag.textContent = listing.isNew ? 'новое' : 'в выдаче';
  title.append(tag);

  const price = document.createElement('div');
  price.className = 'listing-price';
  price.textContent = listing.price;
  const meta = document.createElement('div');
  meta.className = 'listing-meta';
  meta.textContent = listing.isNew
    ? `Найдено ${new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`
    : 'Уже было в выдаче при запуске';

  content.append(title, price, meta);
  row.append(content);
  return row;
}

function renderFeed(scrollToBottom = false) {
  const listings = listingsByPage.get(selectedPageId);
  feed.replaceChildren();
  const newCount = listings
    ? [...listings.values()].filter((listing) => listing.isNew).length
    : 0;
  count.textContent = String(newCount);
  if (!listings || listings.size === 0) {
    emptyState.hidden = false;
    feed.append(emptyState);
    return;
  }

  emptyState.hidden = true;
  feed.append(emptyState);
  [...listings.values()].forEach((listing) => feed.append(createListingRow(listing)));
  if (scrollToBottom) {
    requestAnimationFrame(() => {
      feed.scrollTo({ top: feed.scrollHeight, behavior: 'smooth' });
    });
  }
}

function isFeedNearBottom() {
  return feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
}

function renderControls() {
  const page = getSelectedPage();
  const exists = Boolean(page);
  const running = exists && runningPages.has(page.id);
  const anotherPageRunning = exists && [...runningPages].some((pageId) => pageId !== page.id);
  pageNameInput.disabled = !exists || running;
  urlInput.disabled = !exists || running;
  intervalInput.disabled = !exists || running;
  saveButton.disabled = !exists || running || !isDirty;
  const subscriptionActive = hasActiveSubscription();
  startButton.disabled = !exists || running || anotherPageRunning || !subscriptionActive;
  startButton.hidden = running;
  stopButton.disabled = !exists || !running;
  stopButton.hidden = !running;
  deletePageButton.disabled = !exists || pages.length <= 1 || running;
  addPageButton.disabled = false;
  form.querySelectorAll('label').forEach((label) => {
    label.classList.toggle('disabled-label', !exists || running);
  });
  renderStatus();
}

function renderSelectedPage() {
  const page = getSelectedPage();
  if (!page) return;
  pageHeading.textContent = page.name;
  pageNameInput.value = page.name;
  urlInput.value = page.url;
  intervalInput.value = String(page.intervalSeconds);
  feedDescription.textContent = 'Новые объявления появляются внизу ленты';
  isDirty = false;
  renderPageNav();
  renderControls();
  renderFeed(true);
}

async function saveCurrentPage() {
  const current = getSelectedPage();
  if (!current) throw new Error('Сначала создайте страницу мониторинга.');
  if (runningPages.has(current.id)) throw new Error('Остановите мониторинг, чтобы изменить настройки страницы.');

  const name = pageNameInput.value.trim();
  const url = urlInput.value.trim();
  const intervalSeconds = Number(intervalInput.value);
  if (!name) throw new Error('Введите название страницы.');
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 5 || intervalSeconds > 3600) {
    throw new Error('Интервал должен быть от 5 до 3600 секунд.');
  }
  validatePageUrl(url);

  const updated = { ...current, name, url, intervalSeconds };
  const nextPages = pages.map((page) => page.id === current.id ? updated : page);
  persistPages(nextPages);
  pages = nextPages;
  isDirty = false;
  pageHeading.textContent = name;
  feedDescription.textContent = 'Новые объявления появляются внизу ленты';
  renderPageNav();
  renderControls();
  setLocalStatus('Настройки страницы сохранены.');
  return updated;
}

async function selectPage(pageId) {
  if (pageId === selectedPageId) return;
  if (isDirty) await saveCurrentPage();
  if (!pages.some((page) => page.id === pageId)) return;
  selectedPageId = pageId;
  renderSelectedPage();
}

function markDirty() {
  if (!getSelectedPage()) return;
  isDirty = true;
  pageHeading.textContent = pageNameInput.value.trim() || 'Новая страница';
  saveButton.disabled = runningPages.has(selectedPageId);
}

async function addPage() {
  if (isDirty) await saveCurrentPage();
  const page = createPage(`Страница ${pages.length + 1}`);
  const nextPages = [...pages, page];
  persistPages(nextPages);
  pages = nextPages;
  selectedPageId = page.id;
  renderSelectedPage();
  if (!settingsDialog.open) settingsDialog.showModal();
  setLocalStatus('Страница добавлена. Введите ссылку и сохраните настройки.');
}

async function deleteSelectedPage() {
  const page = getSelectedPage();
  if (!page) return;
  if (pages.length <= 1) throw new Error('Нужно оставить хотя бы одну страницу.');
  if (runningPages.has(page.id)) throw new Error('Сначала остановите мониторинг этой страницы.');
  if (!await confirmDeletePage(page.name)) return;

  const nextPages = pages.filter((entry) => entry.id !== page.id);
  persistPages(nextPages);
  pages = nextPages;
  listingsByPage.delete(page.id);
  statusByPage.delete(page.id);
  pausedPages.delete(page.id);
  selectedPageId = nextPages[0].id;
  renderSelectedPage();
}

function confirmDeletePage(pageName) {
  if (deleteConfirmDialog.open || deleteConfirmationResolver) {
    throw new Error('Окно подтверждения уже открыто.');
  }
  deleteConfirmMessage.textContent = `Страница «${pageName}» и её настройки будут удалены.`;
  return new Promise((resolve, reject) => {
    deleteConfirmationResolver = resolve;
    try {
      deleteConfirmDialog.showModal();
    } catch (error) {
      deleteConfirmationResolver = undefined;
      reject(error);
    }
  });
}

async function startSelectedPage(event) {
  event.preventDefault();
  if (!hasActiveSubscription()) {
    setLocalStatus('Войдите в аккаунт с активной подпиской, чтобы запустить мониторинг.', 'error');
    if (!accountState.authenticated && !accountDialog.open) accountDialog.showModal();
    return;
  }
  const currentPage = getSelectedPage();
  if (!settingsDialog.open && (isDirty || !currentPage || !currentPage.url)) {
    settingsDialog.showModal();
  }
  const pageId = selectedPageId;
  try {
    const otherRunningPage = pages.find((page) => page.id !== pageId && runningPages.has(page.id));
    if (otherRunningPage) {
      throw new Error(`Сначала остановите мониторинг страницы «${otherRunningPage.name}».`);
    }
    const page = await saveCurrentPage();
    if (!page.url) throw new Error('Введите ссылку на поиск Avito.');
    runningPages.add(pageId);
    pausedPages.delete(pageId);
    renderPageNav();
    renderControls();
    setLocalStatus('Запускаю мониторинг…');
    await window.avitoRadar.start({
      pageId: page.id,
      pageName: page.name,
      url: page.url,
      intervalSeconds: page.intervalSeconds
    });
    closeDialogAnimated(settingsDialog);
  } catch (error) {
    runningPages.delete(pageId);
    pausedPages.delete(pageId);
    renderPageNav();
    renderControls();
    setLocalStatus(error.message || 'Не удалось запустить мониторинг.', 'error');
  }
}

async function stopSelectedPage() {
  const pageId = selectedPageId;
  try {
    await window.avitoRadar.stop(pageId);
    runningPages.delete(pageId);
    pausedPages.delete(pageId);
    renderPageNav();
    renderControls();
    closeDialogAnimated(settingsDialog);
  } catch (error) {
    setLocalStatus(error.message || 'Не удалось остановить мониторинг.', 'error');
  }
}

async function resumeSelectedPage() {
  if (!hasActiveSubscription()) {
    setLocalStatus('Подписка не активна. Проверьте аккаунт или продлите доступ на autoparcer.ru.', 'error');
    return;
  }
  const pageId = selectedPageId;
  resumeButton.disabled = true;
  try {
    await window.avitoRadar.resume(pageId);
    closeDialogAnimated(settingsDialog);
  } catch (error) {
    setLocalStatus(error.message || 'Не удалось продолжить мониторинг.', 'error');
  }
}

function handleStatus(status) {
  const { pageId, ...state } = status;
  if (!pages.some((page) => page.id === pageId)) return;
  statusByPage.set(pageId, state);
  if (state.needsResume) pausedPages.add(pageId);
  else pausedPages.delete(pageId);
  renderPageNav();
  if (pageId === selectedPageId) renderControls();
}

function handleListings({ pageId, listings }) {
  if (!pages.some((page) => page.id === pageId)) return;
  let pageListings = listingsByPage.get(pageId);
  const shouldScrollToBottom = pageId === selectedPageId
    && (!pageListings || pageListings.size === 0 || isFeedNearBottom());
  if (!pageListings) {
    pageListings = new Map();
    listingsByPage.set(pageId, pageListings);
  }
  listings.slice().reverse().forEach((listing) => {
    if (!pageListings.has(listing.id)) pageListings.set(listing.id, listing);
  });
  if (pageId === selectedPageId) renderFeed(shouldScrollToBottom);
}

async function submitAccountLogin(event) {
  event.preventDefault();
  accountLoginError.hidden = true;
  accountLoginSubmit.disabled = true;
  const credentials = Object.fromEntries(new FormData(accountLoginForm));
  try {
    const state = await window.avitoRadar.login(credentials);
    accountLoginForm.reset();
    renderAccountState(state);
    if (accountDialog.open) accountDialog.close();
    setLocalStatus(hasActiveSubscription()
      ? 'Вход выполнен. Подписка активна.'
      : 'Вход выполнен, но активной подписки нет.', hasActiveSubscription() ? 'success' : 'info');
  } catch (error) {
    accountLoginError.textContent = error.message || 'Не удалось войти в аккаунт.';
    accountLoginError.hidden = false;
  } finally {
    accountLoginSubmit.disabled = false;
  }
}

async function refreshAccount() {
  accountRefreshButton.disabled = true;
  accountError.hidden = true;
  try {
    const state = await window.avitoRadar.refreshAccount();
    renderAccountState(state);
    if (!state.authenticated && !accountDialog.open) accountDialog.showModal();
    setLocalStatus(hasActiveSubscription()
      ? 'Статус подписки обновлён.'
      : 'Подписка не активна или истекла.', hasActiveSubscription() ? 'success' : 'error');
  } catch (error) {
    renderAccountState({
      authenticated: accountState.authenticated,
      user: accountState.user,
      error: error.message
    });
    setLocalStatus(error.message, 'error');
  } finally {
    accountRefreshButton.disabled = false;
  }
}

async function logoutFromAccount() {
  accountLogoutButton.disabled = true;
  try {
    const state = await window.avitoRadar.logout();
    renderAccountState(state);
    setLocalStatus('Вы вышли из аккаунта.', 'info');
    if (!accountDialog.open) accountDialog.showModal();
  } catch (error) {
    accountError.textContent = error.message;
    accountError.hidden = false;
    setLocalStatus(error.message, 'error');
  } finally {
    accountLogoutButton.disabled = false;
  }
}

async function openAccountProfile() {
  try {
    await window.avitoRadar.openAccountProfile();
  } catch (error) {
    setLocalStatus(error.message || 'Не удалось открыть autoparcer.ru.', 'error');
  }
}

form.addEventListener('submit', startSelectedPage);
accountLoginForm.addEventListener('submit', submitAccountLogin);
accountLoginButton.addEventListener('click', () => accountDialog.showModal());
accountRefreshButton.addEventListener('click', refreshAccount);
accountSubscribeButton.addEventListener('click', openAccountProfile);
accountLogoutButton.addEventListener('click', logoutFromAccount);
accountDialogClose.addEventListener('click', () => closeDialogAnimated(accountDialog));
accountOpenProfile.addEventListener('click', openAccountProfile);
settingsButton.addEventListener('click', () => settingsDialog.showModal());
closeSettingsButton.addEventListener('click', () => closeDialogAnimated(settingsDialog));
settingsDialog.addEventListener('click', (event) => {
  if (event.target === settingsDialog) closeDialogAnimated(settingsDialog);
});
settingsDialog.addEventListener('cancel', (event) => {
  event.preventDefault();
  closeDialogAnimated(settingsDialog);
});
deleteConfirmDialog.addEventListener('click', (event) => {
  if (event.target === deleteConfirmDialog) closeDialogAnimated(deleteConfirmDialog, 'cancel');
});
deleteConfirmDialog.addEventListener('cancel', (event) => {
  event.preventDefault();
  closeDialogAnimated(deleteConfirmDialog, 'cancel');
});
deleteConfirmDialog.addEventListener('close', () => {
  if (!deleteConfirmationResolver) return;
  const resolve = deleteConfirmationResolver;
  deleteConfirmationResolver = undefined;
  resolve(deleteConfirmDialog.returnValue === 'confirm');
});
cancelDeleteButton.addEventListener('click', () => closeDialogAnimated(deleteConfirmDialog, 'cancel'));
confirmDeleteButton.addEventListener('click', () => closeDialogAnimated(deleteConfirmDialog, 'confirm'));
addPageButton.addEventListener('click', () => {
  addPage().catch((error) => setLocalStatus(error.message, 'error'));
});
saveButton.addEventListener('click', () => {
  saveCurrentPage()
    .then(() => closeDialogAnimated(settingsDialog))
    .catch((error) => setLocalStatus(error.message, 'error'));
});
deletePageButton.addEventListener('click', () => {
  deleteSelectedPage().catch((error) => setLocalStatus(error.message, 'error'));
});
stopButton.addEventListener('click', stopSelectedPage);
resumeButton.addEventListener('click', resumeSelectedPage);
windowMinimizeButton.addEventListener('click', () => {
  window.avitoRadar.minimizeWindow().catch((error) => {
    setLocalStatus(error.message || 'Не удалось свернуть окно.', 'error');
  });
});
windowMaximizeButton.addEventListener('click', async () => {
  try {
    setWindowMaximized(await window.avitoRadar.toggleMaximizeWindow());
  } catch (error) {
    setLocalStatus(error.message || 'Не удалось изменить размер окна.', 'error');
  }
});
windowCloseButton.addEventListener('click', () => {
  window.avitoRadar.closeWindow().catch((error) => {
    setLocalStatus(error.message || 'Не удалось закрыть окно.', 'error');
  });
});
windowResizeHandles.forEach((handle) => handle.addEventListener('pointerdown', startWindowResize));
window.addEventListener('pointerup', endWindowResize);
window.addEventListener('pointercancel', endWindowResize);
window.addEventListener('blur', endWindowResize);
themeToggle.addEventListener('click', () => {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(theme);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch (error) {
    setLocalStatus(`Тема изменена, но её не удалось сохранить: ${error.message}`, 'error');
  }
});
pageNameInput.addEventListener('input', markDirty);
urlInput.addEventListener('input', markDirty);
intervalInput.addEventListener('input', markDirty);

window.avitoRadar.onStatus(handleStatus);
window.avitoRadar.onListings(handleListings);
window.avitoRadar.onWindowState(setWindowMaximized);
window.avitoRadar.onAccountState(renderAccountState);

try {
  pages = loadPages();
  selectedPageId = pages[0].id;
  applyTheme(localStorage.getItem(THEME_STORAGE_KEY) === 'dark' ? 'dark' : 'light');
  renderSelectedPage();
} catch (error) {
  renderPageNav();
  renderControls();
  renderFeed();
  setLocalStatus(error.message || 'Не удалось загрузить настройки.', 'error');
}

initializeAccount();
