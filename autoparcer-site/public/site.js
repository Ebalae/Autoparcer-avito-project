'use strict';

const authDialog = document.getElementById('auth-dialog');
const authForm = document.getElementById('auth-form');
const authTitle = document.getElementById('auth-title');
const authDescription = document.getElementById('auth-description');
const authUsername = document.getElementById('auth-username');
const authPassword = document.getElementById('auth-password');
const authError = document.getElementById('auth-error');
const authSubmit = document.getElementById('auth-submit');
const authSwitch = document.getElementById('auth-switch');
const authSwitchPrompt = document.getElementById('auth-switch-prompt');
const registrationConsents = document.getElementById('registration-consents');
const siteNotice = document.getElementById('site-notice');
const priceAmount = document.getElementById('price-amount');
const loginTrigger = document.getElementById('login-trigger');
const signupTrigger = document.getElementById('signup-trigger');
const accountTrigger = document.getElementById('account-trigger');

let authMode = 'register';
let config = {
  priceRub: 990,
  subscriptionDays: 30,
  annualPriceRub: 8316,
  annualMonths: 12,
  annualDiscountPercent: 30,
  downloadAvailable: false
};
let currentUser = null;
let continueWithDownload = false;

async function apiRequest(path, options = {}) {
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

function showNotice(message, kind = 'info') {
  siteNotice.textContent = message;
  siteNotice.className = `site-notice ${kind}`;
  siteNotice.hidden = false;
}

function openAuth(mode) {
  setAuthMode(mode);
  authError.hidden = true;
  authForm.reset();
  if (!authDialog.open) authDialog.showModal();
  authUsername.focus();
}

function setAuthMode(mode) {
  authMode = mode;
  const registering = mode === 'register';
  authTitle.textContent = registering ? 'Создайте аккаунт' : 'С возвращением';
  authDescription.textContent = registering
    ? 'Создайте аккаунт для управления подпиской.'
    : 'Войдите, чтобы проверить подписку и продолжить.';
  authUsername.minLength = registering ? 3 : 1;
  authUsername.maxLength = registering ? 32 : 254;
  if (registering) {
    authUsername.pattern = '[A-Za-zА-Яа-яЁё0-9][A-Za-zА-Яа-яЁё0-9._-]{2,31}';
  } else {
    authUsername.removeAttribute('pattern');
  }
  authPassword.autocomplete = registering ? 'new-password' : 'current-password';
  authPassword.placeholder = registering ? 'Не менее 10 символов' : 'Введите пароль';
  authPassword.minLength = registering ? 10 : 1;
  authSubmit.textContent = registering ? 'Зарегистрироваться' : 'Войти';
  authSwitchPrompt.textContent = registering ? 'Уже есть аккаунт?' : 'Впервые на Autoparcer?';
  authSwitch.textContent = registering ? 'Войти' : 'Создать аккаунт';
  registrationConsents.hidden = !registering;
  registrationConsents.querySelectorAll('input[type="checkbox"]').forEach((checkbox) => {
    checkbox.required = registering;
    if (!registering) checkbox.checked = false;
  });
}

function renderAccount() {
  const signedIn = Boolean(currentUser);
  loginTrigger.hidden = signedIn;
  signupTrigger.hidden = signedIn;
  accountTrigger.hidden = !signedIn;

  if (!signedIn) return;
  accountTrigger.textContent = 'Личный кабинет';
}

async function loadAccount() {
  const response = await apiRequest('/api/me');
  currentUser = response.user;
  renderAccount();
}

async function loadConfiguration() {
  config = await apiRequest('/api/config');
  priceAmount.textContent = `${config.priceRub.toLocaleString('ru-RU')} ₽`;
  renderAccount();
}

function openProfile() {
  if (!currentUser) {
    openAuth('register');
    return;
  }
  window.location.assign('/profile.html');
}

authForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const submittedMode = authMode;
  authSubmit.disabled = true;
  authSwitch.disabled = true;
  authError.hidden = true;
  const formData = new FormData(authForm);
  const endpoint = submittedMode === 'register' ? '/api/register' : '/api/login';
  try {
    const response = await apiRequest(endpoint, {
      method: 'POST',
      body: JSON.stringify({
        username: formData.get('username'),
        password: formData.get('password'),
        acceptedTerms: formData.get('acceptedTerms') === 'on',
        personalDataConsent: formData.get('personalDataConsent') === 'on'
      })
    });
    const shouldDownload = continueWithDownload
      && response.user.subscription.active
      && config.downloadAvailable;
    continueWithDownload = false;
    authDialog.close();
    currentUser = response.user;
    window.location.assign(shouldDownload ? '/download' : '/profile.html');
  } catch (error) {
    authError.textContent = error.message;
    authError.hidden = false;
  } finally {
    authSubmit.disabled = false;
    authSwitch.disabled = false;
  }
});

document.getElementById('auth-close').addEventListener('click', () => authDialog.close());
authDialog.addEventListener('close', () => {
  continueWithDownload = false;
});
authSwitch.addEventListener('click', () => setAuthMode(authMode === 'register' ? 'login' : 'register'));
authDialog.addEventListener('click', (event) => {
  if (event.target === authDialog) authDialog.close();
});

loginTrigger.addEventListener('click', () => openAuth('login'));
signupTrigger.addEventListener('click', () => openAuth('register'));
document.getElementById('pricing-buy').addEventListener('click', openProfile);

Promise.all([loadConfiguration(), loadAccount()])
  .then(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get('login') !== '1') return;
    continueWithDownload = url.searchParams.get('next') === 'download';
    url.searchParams.delete('login');
    url.searchParams.delete('next');
    window.history.replaceState({}, '', url.pathname + url.search + url.hash);
    openAuth('login');
  })
  .catch((error) => showNotice(error.message, 'error'));
