'use strict';

const profileUsername = document.getElementById('profile-username');
const profileLogout = document.getElementById('profile-logout');
const profileContent = document.getElementById('profile-content');
const profileLoading = document.getElementById('profile-loading');
const profileStatus = document.getElementById('profile-subscription-status');
const profilePlan = document.getElementById('profile-subscription-plan');
const profileDownload = document.getElementById('profile-download');
const profileDownloadNote = document.getElementById('profile-download-note');
const profileNotice = document.getElementById('profile-notice');
const monthlyCheckout = document.getElementById('monthly-checkout');
const annualCheckout = document.getElementById('annual-checkout');
const receiptEmail = document.getElementById('receipt-email');
const passwordChangeForm = document.getElementById('password-change-form');
const passwordChangeError = document.getElementById('password-change-error');
const passwordChangeSubmit = passwordChangeForm.querySelector('button[type="submit"]');
const CHECKOUT_EXPIRY_KEY = 'autoparcer_subscription_before_checkout';

let config;
let account;

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

function rubles(amount) {
  return `${amount.toLocaleString('ru-RU')} ₽`;
}

function showNotice(message, kind = 'info') {
  profileNotice.textContent = message;
  profileNotice.className = `site-notice ${kind}`;
  profileNotice.hidden = false;
}

function renderConfiguration() {
  document.getElementById('monthly-price').textContent = rubles(config.priceRub);
  document.getElementById('annual-price').textContent = rubles(config.annualPriceRub);
  document.getElementById('annual-old-price').textContent = rubles(config.priceRub * config.annualMonths);
  document.getElementById('annual-savings').textContent = rubles(config.priceRub * config.annualMonths - config.annualPriceRub);
  document.getElementById('annual-monthly-price').textContent = rubles(Math.round(config.annualPriceRub / config.annualMonths));
  document.getElementById('annual-discount').textContent = `−${config.annualDiscountPercent}%`;
}

function renderAccount() {
  profileUsername.textContent = account.username;
  profileLogout.hidden = false;
  const subscription = account.subscription;

  if (subscription.active && subscription.expiresAt) {
    const expires = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'long' })
      .format(new Date(subscription.expiresAt));
    profileStatus.textContent = `Активна до ${expires}`;
    profileStatus.className = 'profile-status active';
    profilePlan.textContent = subscription.plan === 'annual'
      ? 'Текущий тариф: 12 месяцев'
      : (subscription.plan === 'monthly' ? 'Текущий тариф: 1 месяц' : 'Текущий тариф');
    profileDownload.hidden = !config.downloadAvailable;
    profileDownloadNote.hidden = config.downloadAvailable;
  } else {
    profileStatus.textContent = 'Не активна';
    profileStatus.className = 'profile-status inactive';
    profilePlan.textContent = 'Выберите период, чтобы получить доступ.';
    profileDownload.hidden = true;
    profileDownloadNote.hidden = false;
  }

  profileDownloadNote.textContent = config.downloadAvailable
    ? 'Скачивание станет доступно после оформления подписки.'
    : 'Ссылка на приложение появится после его публикации.';
  profileDownload.href = '/download';
  profileLoading.hidden = true;
  profileContent.hidden = false;
}

async function loadAccount() {
  const response = await apiRequest('/api/me');
  if (!response.user) {
    window.location.replace('/?login=1');
    return false;
  }
  account = response.user;
  return true;
}

async function startCheckout(planCode, button) {
  if (!receiptEmail.reportValidity()) return;
  const originalText = button.textContent;
  button.disabled = true;
  monthlyCheckout.disabled = true;
  annualCheckout.disabled = true;
  button.textContent = 'Переходим к оплате…';
  try {
    sessionStorage.setItem(CHECKOUT_EXPIRY_KEY, account.subscription.expiresAt || '');
    const result = await apiRequest('/api/checkout', {
      method: 'POST',
      body: JSON.stringify({ plan: planCode, receiptEmail: receiptEmail.value.trim() })
    });
    const confirmationUrl = new URL(result.confirmationUrl);
    if (confirmationUrl.protocol !== 'https:') {
      throw new Error('Платёжный сервис вернул небезопасную ссылку.');
    }
    window.location.assign(confirmationUrl.href);
  } catch (error) {
    showNotice(error.message, 'error');
    button.disabled = false;
    monthlyCheckout.disabled = false;
    annualCheckout.disabled = false;
    button.textContent = originalText;
  }
}

async function handlePaymentReturn(previousExpiration) {
  const url = new URL(window.location.href);
  if (url.searchParams.get('payment') !== 'return') return;
  url.searchParams.delete('payment');
  window.history.replaceState({}, '', url.pathname + url.search + url.hash);
  if (previousExpiration === null) {
    showNotice('Не удалось найти информацию о начатом платеже. Обновите страницу и проверьте статус подписки.', 'info');
    return;
  }
  showNotice('Платёж обрабатывается. Проверяем статус подписки…');

  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, 3000));
    const authenticated = await loadAccount();
    if (!authenticated) return;
    renderAccount();
    if (account.subscription.expiresAt !== previousExpiration && account.subscription.active) {
      showNotice('Оплата подтверждена — подписка продлена.', 'success');
      return;
    }
  }
  showNotice('Платёж пока не подтверждён. Обновите страницу позже или напишите в поддержку.', 'info');
}

monthlyCheckout.addEventListener('click', () => startCheckout('monthly', monthlyCheckout));
annualCheckout.addEventListener('click', () => startCheckout('annual', annualCheckout));

passwordChangeForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  passwordChangeError.hidden = true;
  const formData = new FormData(passwordChangeForm);
  const newPassword = formData.get('newPassword');
  if (newPassword !== formData.get('confirmPassword')) {
    passwordChangeError.textContent = 'Новые пароли не совпадают.';
    passwordChangeError.hidden = false;
    return;
  }

  passwordChangeSubmit.disabled = true;
  try {
    await apiRequest('/api/password', {
      method: 'POST',
      body: JSON.stringify({
        currentPassword: formData.get('currentPassword'),
        newPassword
      })
    });
    passwordChangeForm.reset();
    showNotice('Пароль успешно изменён. В других сеансах потребуется войти снова.', 'success');
  } catch (error) {
    passwordChangeError.textContent = error.message;
    passwordChangeError.hidden = false;
  } finally {
    passwordChangeSubmit.disabled = false;
  }
});

profileLogout.addEventListener('click', async () => {
  profileLogout.disabled = true;
  try {
    await apiRequest('/api/logout', { method: 'POST', body: JSON.stringify({}) });
    window.location.assign('/');
  } catch (error) {
    showNotice(error.message, 'error');
    profileLogout.disabled = false;
  }
});

async function startProfile() {
  try {
    const isPaymentReturn = new URL(window.location.href).searchParams.get('payment') === 'return';
    const previousExpiration = isPaymentReturn
      ? sessionStorage.getItem(CHECKOUT_EXPIRY_KEY)
      : null;
    if (isPaymentReturn) sessionStorage.removeItem(CHECKOUT_EXPIRY_KEY);
    const [configuration] = await Promise.all([
      apiRequest('/api/config'),
      loadAccount()
    ]);
    if (!account) return;
    config = configuration;
    renderConfiguration();
    renderAccount();
    await handlePaymentReturn(isPaymentReturn ? previousExpiration : null);
  } catch (error) {
    profileLoading.textContent = error.message;
    showNotice(error.message, 'error');
  }
}

startProfile();
