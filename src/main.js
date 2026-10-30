const {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  Notification,
  safeStorage,
  screen,
  shell
} = require('electron');
const { existsSync } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');

let mainWindow;
let windowResizeTimer;
let accountAccessToken;
let accountTokenLoaded = false;
let accountUser;
let accountRefreshTimer;
const activeMonitors = new Map();
const activeNotifications = new Set();
const windowResizeEdges = new Set(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']);
const ACCOUNT_API_ORIGIN = 'https://autoparcer.ru';
const ACCOUNT_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const ACTIVE_ACCOUNT_REFRESH_INTERVAL_MS = 30 * 1000;
const AVITO_PAGE_LOAD_TIMEOUT_MS = 45 * 1000;
const AVITO_RESULTS_TIMEOUT_MS = 10 * 1000;
const AVITO_SCRIPT_TIMEOUT_MS = 15 * 1000;
const AVITO_SLOW_LOAD_NOTICE_MS = 10 * 1000;

const existingUserDataPath = app.getPath('userData');
const appDataPath = app.getPath('appData');
if (!existsSync(path.join(existingUserDataPath, 'Local Storage'))) {
  for (const legacyName of ['Avito Radar', 'avito-new-listings']) {
    const legacyPath = path.join(appDataPath, legacyName);
    if (existsSync(path.join(legacyPath, 'Local Storage'))) {
      app.setPath('userData', legacyPath);
      break;
    }
  }
}

function accountTokenPath() {
  return path.join(app.getPath('userData'), 'account-token.bin');
}

async function loadAccountToken() {
  if (accountTokenLoaded) return accountAccessToken || '';
  accountTokenLoaded = true;
  let encryptedToken;
  try {
    encryptedToken = await fs.readFile(accountTokenPath());
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw new Error(`Не удалось прочитать сохранённый вход: ${error.message}`);
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Защищённое хранилище Windows недоступно. Перезапустите приложение.');
  }
  try {
    accountAccessToken = safeStorage.decryptString(encryptedToken);
  } catch {
    throw new Error('Не удалось расшифровать сохранённый вход. Войдите в аккаунт заново.');
  }
  return accountAccessToken;
}

async function saveAccountToken(token) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Защищённое хранилище Windows недоступно. Вход не сохранён.');
  }
  const encryptedToken = safeStorage.encryptString(token);
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  await fs.writeFile(accountTokenPath(), encryptedToken, { mode: 0o600 });
}

async function removeAccountToken() {
  try {
    await fs.unlink(accountTokenPath());
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw new Error(`Не удалось удалить сохранённый вход: ${error.message}`);
    }
  }
}

async function requestAccountApi(route, { method = 'GET', body, token = '' } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  let response;
  try {
    response = await fetch(`${ACCOUNT_API_ORIGIN}${route}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15000)
    });
  } catch {
    throw new Error('Не удалось связаться с autoparcer.ru. Проверьте подключение к интернету.');
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error('Сервер Autoparcer вернул некорректный ответ.');
  }
  if (!response.ok) {
    const error = new Error(data.error || 'Не удалось проверить аккаунт Autoparcer.');
    error.status = response.status;
    error.code = data.code;
    throw error;
  }
  return data;
}

function hasActiveSubscription(user = accountUser) {
  const expiresAt = user && user.subscription && user.subscription.expiresAt;
  const expiration = expiresAt ? Date.parse(expiresAt) : NaN;
  return Boolean(user && user.subscription && user.subscription.active
    && Number.isFinite(expiration) && expiration > Date.now());
}

function sendAccountState(error = '') {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
  mainWindow.webContents.send('account:state', {
    authenticated: Boolean(accountAccessToken),
    user: accountUser || null,
    error
  });
}

function scheduleAccountRefresh() {
  clearTimeout(accountRefreshTimer);
  if (!accountAccessToken) return;
  const expiry = accountUser && accountUser.subscription
    ? Date.parse(accountUser.subscription.expiresAt)
    : NaN;
  const untilExpiry = Number.isFinite(expiry) ? expiry - Date.now() : Infinity;
  const refreshInterval = activeMonitors.size
    ? ACTIVE_ACCOUNT_REFRESH_INTERVAL_MS
    : ACCOUNT_REFRESH_INTERVAL_MS;
  const delay = untilExpiry > 0
    ? Math.max(1000, Math.min(refreshInterval, untilExpiry))
    : refreshInterval;
  accountRefreshTimer = setTimeout(async () => {
    try {
      await refreshAccountFromServer();
    } catch (error) {
      if (!hasActiveSubscription()) stopAllMonitors();
      sendAccountState(error.message);
    } finally {
      scheduleAccountRefresh();
    }
  }, delay);
}

async function refreshAccountFromServer() {
  const token = await loadAccountToken();
  if (!token) {
    accountUser = undefined;
    sendAccountState();
    return null;
  }

  let data;
  try {
    data = await requestAccountApi('/api/app/me', { token });
  } catch (error) {
    if (error.status === 401) {
      await removeAccountToken();
      accountAccessToken = undefined;
      accountUser = undefined;
      stopAllMonitors();
      clearTimeout(accountRefreshTimer);
      sendAccountState(error.code === 'session_replaced' ? error.message : '');
      return null;
    }
    throw error;
  }
  if (!data.user || !data.user.subscription) {
    throw new Error('Сервер Autoparcer вернул профиль без статуса подписки.');
  }
  accountUser = data.user;
  if (!hasActiveSubscription()) stopAllMonitors();
  sendAccountState();
  scheduleAccountRefresh();
  return accountUser;
}

async function requireActiveSubscription() {
  if (!await loadAccountToken()) {
    throw new Error('Войдите в профиль Autoparcer, чтобы запустить мониторинг.');
  }
  const user = await refreshAccountFromServer();
  if (!hasActiveSubscription(user)) {
    throw new Error('Подписка не активна или истекла. Оформите её на autoparcer.ru.');
  }
}

async function loginToAccount(event, credentials) {
  getMainWindowForEvent(event);
  if (typeof credentials.username !== 'string' || credentials.username.length > 254
    || typeof credentials.password !== 'string' || credentials.password.length > 128) {
    throw new Error('Введите логин и пароль.');
  }
  if (await loadAccountToken()) {
    throw new Error('Сначала выйдите из текущего аккаунта.');
  }
  const data = await requestAccountApi('/api/app/login', {
    method: 'POST',
    body: credentials
  });
  if (typeof data.accessToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(data.accessToken)
    || !data.user || !data.user.subscription) {
    throw new Error('Сервер Autoparcer вернул некорректный ответ входа.');
  }
  await saveAccountToken(data.accessToken);
  accountAccessToken = data.accessToken;
  accountUser = data.user;
  if (!hasActiveSubscription()) stopAllMonitors();
  sendAccountState();
  scheduleAccountRefresh();
  return { authenticated: true, user: accountUser };
}

async function logoutFromAccount(event) {
  getMainWindowForEvent(event);
  const token = await loadAccountToken();
  if (!token) return { authenticated: false, user: null };
  await requestAccountApi('/api/app/logout', { method: 'POST', token });
  await removeAccountToken();
  accountAccessToken = undefined;
  accountUser = undefined;
  clearTimeout(accountRefreshTimer);
  stopAllMonitors();
  sendAccountState();
  return { authenticated: false, user: null };
}

async function openAccountProfile(event) {
  getMainWindowForEvent(event);
  await shell.openExternal(`${ACCOUNT_API_ORIGIN}/profile.html`);
  return true;
}

if (process.platform === 'win32') {
  app.setAppUserModelId('ru.avito.newlistings');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    frame: false,
    transparent: true,
    roundedCorners: true,
    hasShadow: true,
    resizable: true,
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 650,
    backgroundColor: '#00000000',
    title: 'Autoparcer.ru',
    icon: path.join(__dirname, 'app-icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.on('closed', () => {
    stopWindowResize();
    mainWindow = undefined;
    stopAllMonitors();
  });
  mainWindow.on('blur', stopWindowResize);
  mainWindow.on('maximize', sendWindowState);
  mainWindow.on('unmaximize', sendWindowState);
  mainWindow.webContents.on('did-finish-load', sendWindowState);
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

function stopWindowResize() {
  if (!windowResizeTimer) return;
  clearInterval(windowResizeTimer);
  windowResizeTimer = undefined;
}

function beginWindowResize(window, edge) {
  if (!windowResizeEdges.has(edge)) throw new Error('Некорректное направление изменения размера окна.');
  stopWindowResize();
  if (window.isMaximized()) return false;

  const initialBounds = window.getBounds();
  const [minWidth, minHeight] = window.getMinimumSize();
  const initialCursor = screen.getCursorScreenPoint();
  windowResizeTimer = setInterval(() => {
    if (window.isDestroyed() || window.isMaximized()) {
      stopWindowResize();
      return;
    }

    const cursor = screen.getCursorScreenPoint();
    const deltaX = cursor.x - initialCursor.x;
    const deltaY = cursor.y - initialCursor.y;
    const bounds = { ...initialBounds };

    if (edge.includes('e')) bounds.width = Math.max(minWidth, initialBounds.width + deltaX);
    if (edge.includes('w')) {
      bounds.width = Math.max(minWidth, initialBounds.width - deltaX);
      bounds.x = initialBounds.x + initialBounds.width - bounds.width;
    }
    if (edge.includes('s')) bounds.height = Math.max(minHeight, initialBounds.height + deltaY);
    if (edge.includes('n')) {
      bounds.height = Math.max(minHeight, initialBounds.height - deltaY);
      bounds.y = initialBounds.y + initialBounds.height - bounds.height;
    }

    window.setBounds(bounds);
  }, 16);
  return true;
}

function sendWindowState() {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('window:state', mainWindow.isMaximized());
  }
}

function getMainWindowForEvent(event) {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
    throw new Error('Управление главным окном недоступно.');
  }
  return mainWindow;
}

function createAvitoWindow(pageName, monitor) {
  const window = new BrowserWindow({
    show: false,
    width: 1200,
    height: 900,
    minWidth: 900,
    minHeight: 650,
    title: `Autoparcer.ru — ${pageName}`,
    icon: path.join(__dirname, 'app-icon.ico'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  monitor.avitoWindow = window;
  window.on('closed', () => {
    if (monitor.avitoWindow === window) monitor.avitoWindow = undefined;
  });
  return window;
}

async function fetchListings(monitor) {
  const window = monitor.avitoWindow && !monitor.avitoWindow.isDestroyed()
    ? monitor.avitoWindow
    : createAvitoWindow(monitor.name, monitor);

  try {
    await loadAvitoPage(window, monitor.url);

    const pageUrl = window.webContents.getURL();
    if (new URL(pageUrl).hostname !== 'www.avito.ru') {
      throw new Error('Avito перенаправил запрос на другую страницу. Проверьте доступ к сайту.');
    }

    const pagePromise = window.webContents.executeJavaScript(`(async () => {
      const resultsDeadline = Date.now() + ${AVITO_RESULTS_TIMEOUT_MS};
      while (
        !document.querySelector('[data-marker="item"]')
        && !document.querySelector('[data-marker*="captcha"], iframe[src*="captcha"], input[name*="captcha"]')
        && Date.now() < resultsDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const results = new Map();
      document.querySelectorAll('[data-marker="item"]').forEach((card) => {
        const titleLink = card.querySelector('a[data-marker="item-title"]');
        const title = titleLink && titleLink.textContent.trim();
        const href = titleLink && titleLink.getAttribute('href');
        if (!title || !href) return;

        let listingUrl;
        try {
          listingUrl = new URL(href, location.href).toString();
        } catch {
          return;
        }

        const idMatch = listingUrl.match(/_(\\d{6,})(?:\\?|$)/);
        const id = idMatch ? idMatch[1] : listingUrl;
        const priceNode = card.querySelector('[data-marker="item-price"]');
        const imageNode = card.querySelector('img');
        const price = priceNode ? priceNode.textContent.replace(/\\s+/g, ' ').trim() : '';
        const image = imageNode ? (imageNode.currentSrc || imageNode.getAttribute('data-src') || imageNode.src) : '';
        results.set(id, {
          id,
          title,
          price: price || 'Цена не указана',
          url: listingUrl,
          image
        });
      });
      return {
        listings: [...results.values()],
        title: document.title,
        text: document.body ? document.body.innerText.slice(0, 4000) : '',
        hasCaptcha: Boolean(document.querySelector(
          '[data-marker*="captcha"], iframe[src*="captcha"], input[name*="captcha"]'
        )) || /captcha|капч|не робот|подтвердите.{0,40}человек|проверка безопасности/i.test(
          document.title + ' ' + (document.body ? document.body.innerText : '')
        )
      };
    })()`);
    let scriptTimeout;
    let page;
    try {
      page = await Promise.race([
        pagePromise,
        new Promise((_, reject) => {
          scriptTimeout = setTimeout(() => {
            const error = new Error('Страница Avito не ответила при поиске объявлений за 15 секунд.');
            error.code = 'AVITO_SCRIPT_TIMEOUT';
            reject(error);
          }, AVITO_SCRIPT_TIMEOUT_MS);
        })
      ]);
    } finally {
      clearTimeout(scriptTimeout);
    }

    if (page.hasCaptcha) {
      const error = new Error('Avito просит пройти CAPTCHA в открывшемся окне.');
      error.code = 'AVITO_CAPTCHA';
      throw error;
    }

    if (!page.listings.length) {
      const pageText = `${page.title}\n${page.text}`;
      if (/too many requests|http\s*429|\b429\b|слишком много запросов/i.test(pageText)) {
        const error = new Error('Avito ограничил частоту запросов (HTTP 429). Подождите и повторите проверку.');
        error.code = 'AVITO_RATE_LIMIT';
        throw error;
      }
      throw new Error('Не нашёл объявления на странице. Возможно, Avito показал CAPTCHA или изменил разметку.');
    }
    return page.listings;
  } catch (error) {
    if (
      (error.code === 'AVITO_TIMEOUT' || error.code === 'AVITO_SCRIPT_TIMEOUT')
      && monitor.avitoWindow === window
      && !window.isDestroyed()
    ) {
      window.destroy();
      monitor.avitoWindow = undefined;
    }
    if (error.message.includes('ERR_')) {
      throw new Error(`Не удалось загрузить Avito: ${error.message}`);
    }
    throw error;
  }
}

function loadAvitoPage(window, url) {
  const { webContents } = window;
  return new Promise((resolve, reject) => {
    let timeout;
    let abortedNavigationTimer;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timeout);
      clearTimeout(abortedNavigationTimer);
      webContents.removeListener('dom-ready', onDomReady);
      webContents.removeListener('did-fail-load', onFail);
      window.removeListener('closed', onClosed);
    };

    const settle = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };

    const onDomReady = () => {
      let loadedUrl;
      try {
        loadedUrl = new URL(webContents.getURL());
      } catch {
        settle(new Error('Не удалось определить загруженную страницу Avito.'));
        return;
      }
      if (loadedUrl.hostname !== 'www.avito.ru') {
        settle(new Error('Avito перенаправил запрос на другую страницу. Проверьте доступ к сайту.'));
        return;
      }
      settle();
    };

    const onFail = (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      if (errorCode === -3) {
        if (!webContents.isLoadingMainFrame()) {
          abortedNavigationTimer = setTimeout(() => {
            if (!webContents.isLoadingMainFrame()) onDomReady();
          }, 250);
        }
        return;
      }
      settle(new Error(formatLoadError(errorCode, errorDescription, validatedURL)));
    };

    const onClosed = () => settle(new Error('Окно Avito было закрыто.'));

    webContents.on('dom-ready', onDomReady);
    webContents.on('did-fail-load', onFail);
    window.once('closed', onClosed);
    timeout = setTimeout(() => {
      const error = new Error('Avito не ответил за 45 секунд.');
      error.code = 'AVITO_TIMEOUT';
      settle(error);
    }, AVITO_PAGE_LOAD_TIMEOUT_MS);

    webContents.loadURL(url, { extraHeaders: 'Cache-Control: no-cache\r\n' }).catch((error) => {
      if (!error.message.includes('ERR_ABORTED')) settle(error);
    });
  });
}

function sendStatus(
  pageId,
  message,
  kind = 'info',
  needsResume = false,
  resumeLabel = 'Продолжить',
  monitorOverride
) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    const monitor = monitorOverride || activeMonitors.get(pageId);
    mainWindow.webContents.send('monitor:status', {
      pageId,
      message,
      kind,
      needsResume,
      resumeLabel,
      lastSuccessfulCheckAt: monitor ? monitor.lastSuccessfulCheckAt : null,
      lastListingCount: monitor ? monitor.lastListingCount : null,
      at: new Date().toISOString()
    });
  }
}

function formatDelay(milliseconds) {
  const seconds = Math.ceil(milliseconds / 1000);
  if (seconds < 60) return `${seconds} сек.`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds ? `${minutes} мин ${remainingSeconds} сек.` : `${minutes} мин.`;
}

function formatLoadError(errorCode, errorDescription, failedUrl) {
  let host = 'Avito';
  try {
    host = new URL(failedUrl).hostname;
  } catch {
    host = 'Avito';
  }
  if (errorCode === -201) {
    return `HTTPS-сертификат ${host} имеет неверный срок действия (ERR_CERT_DATE_INVALID, -201). Проверьте дату Windows и HTTPS-фильтрацию VPN/антивируса.`;
  }
  if (errorCode === -100) {
    return `Соединение с ${host} было закрыто (ERR_CONNECTION_CLOSED, -100). Проверьте сеть, VPN, прокси или антивирус.`;
  }
  return `Загрузка ${host} не удалась: ${errorDescription} (${errorCode}).`;
}

function sendListings(pageId, listings) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('monitor:listings', { pageId, listings });
  }
}

function openAvitoUrl(url) {
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== 'https:' || parsedUrl.hostname !== 'www.avito.ru') {
    throw new Error('Разрешены только ссылки Avito.');
  }
  return shell.openExternal(parsedUrl.toString());
}

function notifyNewListings(pageId, pageName, listings) {
  if (!Notification.isSupported()) return false;

  const [firstListing] = listings;
  const title = listings.length === 1
    ? `Новое объявление — ${pageName}`
    : `Новых объявлений (${pageName}): ${listings.length}`;
  const body = listings.length === 1
    ? `${firstListing.title} — ${firstListing.price}`
    : `${firstListing.title} — ${firstListing.price} и ещё ${listings.length - 1}`;
  const notification = new Notification({ title, body });

  notification.on('click', () => {
    openAvitoUrl(firstListing.url).catch((error) => {
      sendStatus(pageId, error.message || 'Не удалось открыть объявление.', 'error');
    });
  });
  notification.on('close', () => activeNotifications.delete(notification));
  activeNotifications.add(notification);
  notification.show();
  return true;
}

function validateConfig({ pageId, pageName, url, intervalSeconds }) {
  if (typeof pageId !== 'string' || !pageId.trim()) {
    throw new Error('Не удалось определить страницу мониторинга.');
  }
  const name = typeof pageName === 'string' && pageName.trim()
    ? pageName.trim().slice(0, 60)
    : 'Страница Avito';
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error('Введите корректную ссылку на поиск Avito.');
  }
  if (parsedUrl.protocol !== 'https:' || parsedUrl.hostname !== 'www.avito.ru') {
    throw new Error('Поддерживаются только HTTPS-ссылки с www.avito.ru.');
  }
  const interval = Number(intervalSeconds);
  if (!Number.isInteger(interval) || interval < 5 || interval > 3600) {
    throw new Error('Интервал должен быть от 5 до 3600 секунд.');
  }
  return { pageId, name, url: parsedUrl.toString(), interval };
}

ipcMain.handle('monitor:start', async (event, config) => {
  getMainWindowForEvent(event);
  await requireActiveSubscription();
  const { pageId, name, url, interval } = validateConfig(config || {});
  const otherMonitor = activeMonitors.values().next().value;
  if (otherMonitor) {
    throw new Error(`Сначала остановите мониторинг страницы «${otherMonitor.name}».`);
  }
  if (activeMonitors.has(pageId)) {
    throw new Error('Мониторинг этой страницы уже запущен.');
  }
  const monitor = {
    pageId,
    name,
    url,
    interval,
    avitoWindow: undefined,
    pollTimer: undefined,
    pausedForUser: false,
    knownIds: new Set(),
    isFirstCheck: true,
    check: undefined,
    lastSuccessfulCheckAt: null,
    lastListingCount: null,
    consecutiveFailures: 0
  };
  createAvitoWindow(name, monitor);
  activeMonitors.set(pageId, monitor);
  scheduleAccountRefresh();
  sendStatus(pageId, 'Загружаю объявления с Avito…');

  const check = async () => {
    if (activeMonitors.get(pageId) !== monitor || monitor.pausedForUser) return;
    const checkStartedAt = Date.now();
    const slowLoadNoticeTimer = setTimeout(() => {
      if (activeMonitors.get(pageId) === monitor) {
        sendStatus(pageId, 'Avito загружается дольше обычного — ожидаю объявления.');
      }
    }, AVITO_SLOW_LOAD_NOTICE_MS);
    let nextDelay = interval * 1000;
    try {
      const listings = await fetchListings(monitor);
      monitor.lastSuccessfulCheckAt = new Date().toISOString();
      monitor.lastListingCount = listings.length;
      monitor.consecutiveFailures = 0;
      nextDelay = Math.max(0, interval * 1000 - (Date.now() - checkStartedAt));
      const newListings = listings.filter((listing) => !monitor.knownIds.has(listing.id));
      listings.forEach((listing) => monitor.knownIds.add(listing.id));

      if (monitor.isFirstCheck) {
        monitor.isFirstCheck = false;
        sendListings(pageId, listings.map((listing) => ({ ...listing, isNew: false })));
        sendStatus(pageId, `Показал ${listings.length} объявлений из выдачи. Жду новые.`);
      } else if (newListings.length) {
        sendListings(pageId, newListings.map((listing) => ({ ...listing, isNew: true })));
        const notificationShown = notifyNewListings(pageId, name, newListings);
        const notificationNote = notificationShown ? '' : ' Системные уведомления недоступны.';
        sendStatus(pageId, `Найдено новых объявлений: ${newListings.length}.${notificationNote}`, notificationShown ? 'success' : 'error');
      } else {
        sendStatus(pageId, `Проверено объявлений: ${listings.length}. Новых нет; следующая проверка через ${formatDelay(nextDelay)}.`);
      }
    } catch (error) {
      if (activeMonitors.get(pageId) === monitor
        && error.code === 'AVITO_CAPTCHA') {
        monitor.pausedForUser = true;
        if (monitor.avitoWindow && !monitor.avitoWindow.isDestroyed()) {
          monitor.avitoWindow.show();
          monitor.avitoWindow.focus();
        }
        sendStatus(pageId, error.message, 'error', true, 'Я прошёл CAPTCHA');
      } else if (activeMonitors.get(pageId) === monitor) {
        monitor.consecutiveFailures += 1;
        const multiplier = 2 ** Math.min(monitor.consecutiveFailures - 1, 8);
        const baseDelay = error.code === 'AVITO_RATE_LIMIT'
          ? Math.max(interval * 1000, 120000)
          : interval * 1000;
        nextDelay = Math.min(baseDelay * multiplier, 15 * 60 * 1000);
        const retryMessage = error.code === 'AVITO_RATE_LIMIT'
          ? `Avito ограничил частоту запросов. Повторю через ${formatDelay(nextDelay)}.`
          : `${error.message || 'Не удалось проверить страницу.'} Повторю через ${formatDelay(nextDelay)}.`;
        sendStatus(pageId, retryMessage, 'error');
      }
    } finally {
      clearTimeout(slowLoadNoticeTimer);
      if (activeMonitors.get(pageId) === monitor && !monitor.pausedForUser) {
        monitor.pollTimer = setTimeout(check, nextDelay);
      }
    }
  };

  monitor.check = check;
  check();
  return { started: true, pageId };
});

ipcMain.handle('monitor:resume', async (event, pageId) => {
  getMainWindowForEvent(event);
  await requireActiveSubscription();
  const monitor = activeMonitors.get(pageId);
  if (!monitor || !monitor.pausedForUser || !monitor.check) {
    throw new Error('Мониторинг не ожидает подтверждения.');
  }
  const window = monitor.avitoWindow && !monitor.avitoWindow.isDestroyed()
    ? monitor.avitoWindow
    : createAvitoWindow(monitor.name, monitor);
  window.hide();
  monitor.pausedForUser = false;
  sendStatus(pageId, 'Повторно проверяю страницу…');
  monitor.check();
  return { resumed: true };
});

function stopMonitor(pageId) {
  const monitor = activeMonitors.get(pageId);
  if (!monitor) return false;
  clearTimeout(monitor.pollTimer);
  sendStatus(pageId, 'Мониторинг остановлен.', 'info', false, 'Продолжить', monitor);
  activeMonitors.delete(pageId);
  if (monitor.avitoWindow && !monitor.avitoWindow.isDestroyed()) monitor.avitoWindow.destroy();
  monitor.avitoWindow = undefined;
  scheduleAccountRefresh();
  return true;
}

function stopAllMonitors() {
  for (const pageId of activeMonitors.keys()) stopMonitor(pageId);
}

ipcMain.handle('monitor:stop', (event, pageId) => {
  getMainWindowForEvent(event);
  stopMonitor(pageId);
  return { stopped: true };
});

ipcMain.handle('account:get', async (event) => {
  getMainWindowForEvent(event);
  try {
    await loadAccountToken();
    const user = await refreshAccountFromServer();
    return { authenticated: Boolean(accountAccessToken), user };
  } catch (error) {
    sendAccountState(error.message);
    return {
      authenticated: Boolean(accountAccessToken),
      user: accountUser || null,
      error: error.message
    };
  }
});

ipcMain.handle('account:refresh', async (event) => {
  getMainWindowForEvent(event);
  const user = await refreshAccountFromServer();
  return { authenticated: Boolean(accountAccessToken), user };
});

ipcMain.handle('account:login', loginToAccount);
ipcMain.handle('account:logout', logoutFromAccount);
ipcMain.handle('account:open-profile', openAccountProfile);

ipcMain.handle('shell:openExternal', async (_event, url) => {
  try {
    await openAvitoUrl(url);
  } catch (error) {
    throw new Error(error.message || 'Не удалось открыть ссылку.');
  }
});

ipcMain.handle('window:minimize', (event) => {
  getMainWindowForEvent(event).minimize();
  return true;
});

ipcMain.handle('window:toggle-maximize', (event) => {
  const window = getMainWindowForEvent(event);
  if (window.isMaximized()) window.unmaximize();
  else window.maximize();
  return window.isMaximized();
});

ipcMain.handle('window:close', (event) => {
  getMainWindowForEvent(event).close();
  return true;
});

ipcMain.handle('window:resize-start', (event, edge) => {
  return beginWindowResize(getMainWindowForEvent(event), edge);
});

ipcMain.handle('window:resize-end', (event) => {
  getMainWindowForEvent(event);
  stopWindowResize();
  return true;
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
