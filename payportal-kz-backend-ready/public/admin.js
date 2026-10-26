'use strict';

const loginPanel = document.getElementById('loginPanel');
const dashboard = document.getElementById('dashboard');
const loginForm = document.getElementById('loginForm');
const setupPanel = document.getElementById('setupPanel');
const setupForm = document.getElementById('setupForm');
const setupMessage = document.getElementById('setupMessage');
const loginMessage = document.getElementById('loginMessage');
const payoutForm = document.getElementById('payoutForm');
const payoutMessage = document.getElementById('payoutMessage');
const adminMode = document.getElementById('adminMode');
let csrfToken = '';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}
function fmtMoney(amount) { return `${Number(amount || 0).toLocaleString('kk-KZ')} ₸`; }
function fmtDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
}
function statusLabel(status) {
  const labels = { pending: 'Күтілуде', paid: 'Төленді', failed: 'Қате', creating: 'Жасалуда', awaiting_recipient: 'Карта енгізіледі', processing: 'Өңделуде' };
  return labels[status] || status || 'Белгісіз';
}
function statusClass(status) {
  return ['pending', 'paid', 'failed', 'creating', 'awaiting_recipient', 'processing'].includes(status) ? status : 'pending';
}
function showLoginMessage(text, isError = true) {
  loginMessage.hidden = false;
  loginMessage.className = `message ${isError ? 'error' : ''}`.trim();
  loginMessage.textContent = text;
}
function showPayoutMessage(text, isError = true) {
  payoutMessage.hidden = false;
  payoutMessage.className = `message ${isError ? 'error' : ''}`.trim();
  payoutMessage.textContent = text;
}
async function api(path, options = {}) {
  const headers = { Accept: 'application/json', ...(options.headers || {}) };
  if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  if (options.method === 'POST' && csrfToken) headers['X-CSRF-Token'] = csrfToken;
  const response = await fetch(path, { credentials: 'same-origin', ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && path !== '/api/admin/login') showLogin();
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data;
}
function showLogin() {
  dashboard.classList.add('hidden');
  loginPanel.classList.remove('hidden');
  adminMode.querySelector('b').textContent = 'Кіру қажет';
  adminMode.classList.add('error');
}
function showDashboard() {
  loginPanel.classList.add('hidden');
  dashboard.classList.remove('hidden');
  adminMode.querySelector('b').textContent = 'Әкімші сессиясы белсенді';
  adminMode.classList.remove('error');
}
function tableRows(items) {
  if (!items.length) return '<tr><td colspan="5"><div class="empty-state">Әзірге жазба жоқ</div></td></tr>';
  return items.map((item) => {
    const providerId = item.provider_payment_id ? escapeHtml(item.provider_payment_id) : '—';
    return `<tr><td>${escapeHtml(fmtDate(item.created_at))}</td><td><span class="order-code">${escapeHtml(item.order_id)}</span><br><span class="small-muted">${escapeHtml(item.description)}</span></td><td>${escapeHtml(fmtMoney(item.amount_kzt))}</td><td><span class="status ${statusClass(item.status)}">${escapeHtml(statusLabel(item.status))}</span></td><td class="order-code">${providerId}</td></tr>`;
  }).join('');
}
async function refreshData() {
  try {
    const [me, data] = await Promise.all([api('/api/admin/me'), api('/api/admin/data')]);
    csrfToken = me.csrfToken;
    showDashboard();
    document.getElementById('paidTotal').textContent = fmtMoney(data.stats.paid_total);
    document.getElementById('totalCount').textContent = Number(data.stats.total_count || 0).toLocaleString('ru-RU');
    document.getElementById('pendingCount').textContent = Number(data.stats.pending_count || 0).toLocaleString('ru-RU');
    document.getElementById('paymentsTable').innerHTML = tableRows(data.payments || []);
    document.getElementById('payoutsTable').innerHTML = tableRows(data.payouts || []);
    const canPayout = Boolean(data.payoutsEnabled);
    document.getElementById('payoutStatusPill').textContent = canPayout ? 'ENABLED' : 'LOCKED';
    document.getElementById('payoutButton').disabled = !canPayout;
    adminMode.querySelector('b').textContent = data.mode === 'test' ? 'Провайдер: TEST MODE' : 'Провайдер: LIVE MODE';
    adminMode.classList.toggle('error', !canPayout && data.mode === 'live');
  } catch (error) {
    if (error.message.includes('Sign in') || error.message.includes('401')) showLogin();
    else showLoginMessage(error.message, true);
  }
}

async function initializeAdminAuth() {
  try {
    const response = await fetch('/api/admin/setup-status', { headers: { Accept: 'application/json' }, cache: 'no-store' });
    const status = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(status.error || `HTTP ${response.status}`);
    if (!status.persistentStorage) {
      showLoginMessage('Бұл Netlify нұсқасында тұрақты дерекқор қосылмаған. Төлемдер мен әкімші журналы өшірілген; алдымен тұрақты дерекқор қосу керек.', true);
      return;
    }
    if (status.setupRequired && status.setupTokenRequired && !status.setupTokenConfigured) {
      loginForm.hidden = true;
      setupPanel.hidden = false;
      setupForm.hidden = true;
      setupMessage.hidden = false;
      setupMessage.className = 'message error';
      setupMessage.textContent = 'Қоғамға ашық серверде бөтен адамның әкімші аккаунтын иемденуіне жол бермеу үшін .env ішіне кемінде 32 таңбалы ADMIN_SETUP_TOKEN қосып, серверді қайта іске қос. Содан кейін осы бетте құпиясөзді қоя аласың.';
      return;
    }
    if (status.setupRequired && status.canSetupHere) {
      loginForm.hidden = true;
      setupPanel.hidden = false;
      setupForm.hidden = false;
      const tokenWrap = document.getElementById('setupTokenWrap');
      const tokenInput = document.getElementById('setupToken');
      tokenWrap.hidden = !status.setupTokenRequired;
      tokenInput.required = Boolean(status.setupTokenRequired);
      const note = document.querySelector('.aside-note');
      if (note) note.hidden = true;
      setupMessage.hidden = false;
      setupMessage.className = 'message';
      setupMessage.textContent = 'Алғашқы іске қосу: өз әкімші логинің мен құпиясөзіңді жаса.';
      showLogin();
      return;
    }
    if (status.setupRequired && !status.canSetupHere) {
      showLoginMessage('Әкімші әлі бапталмаған. ADMIN_PASSWORD_HASH және SESSION_SECRET Environment variables ретінде орнатылуы керек.', true);
      return;
    }
    await refreshData();
  } catch (error) {
    showLoginMessage(`API-ге қосыла алмады (${error.message}). Сайтқа серверлік API қосылғанын және хостинг конфигурациясын тексер.`, true);
  }
}

setupForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = document.getElementById('setupButton');
  button.disabled = true;
  setupMessage.hidden = true;
  try {
    const username = document.getElementById('setupUsername').value.trim();
    const data = await api('/api/admin/setup', {
      method: 'POST',
      body: JSON.stringify({
        username,
        setupToken: document.getElementById('setupToken').value,
        password: document.getElementById('setupPassword').value,
        confirmPassword: document.getElementById('setupConfirm').value
      })
    });
    setupMessage.hidden = false;
    setupMessage.className = 'message';
    setupMessage.textContent = data.message || 'Әкімші аккаунты жасалды. Енді кір.';
    setupForm.hidden = true;
    loginForm.hidden = false;
    document.getElementById('username').value = username;
    document.getElementById('password').focus();
    document.getElementById('setupPassword').value = '';
    document.getElementById('setupConfirm').value = '';
    document.getElementById('setupToken').value = '';
  } catch (error) {
    setupMessage.hidden = false;
    setupMessage.className = 'message error';
    setupMessage.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = document.getElementById('loginButton');
  button.disabled = true;
  showLoginMessage('Тексерілуде…', false);
  try {
    const data = await api('/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ username: document.getElementById('username').value.trim(), password: document.getElementById('password').value })
    });
    csrfToken = data.csrfToken;
    document.getElementById('password').value = '';
    await refreshData();
  } catch (error) {
    showLoginMessage(error.message, true);
  } finally {
    button.disabled = false;
  }
});

document.getElementById('refreshButton').addEventListener('click', refreshData);
document.getElementById('logoutButton').addEventListener('click', async () => {
  try { await api('/api/admin/logout', { method: 'POST', body: JSON.stringify({ csrfToken }) }); } catch { /* The session may already have expired. */ }
  csrfToken = '';
  showLogin();
});

payoutForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  payoutMessage.hidden = true;
  const button = document.getElementById('payoutButton');
  button.disabled = true;
  try {
    const data = await api('/api/admin/payouts', {
      method: 'POST',
      body: JSON.stringify({ amount: Number(document.getElementById('payoutAmount').value), description: document.getElementById('payoutDescription').value.trim(), csrfToken })
    });
    showPayoutMessage(`Payout сұрауы ${data.orderId} құрылды. Алушы картасын Freedom Pay бетінен енгізу керек.`, false);
    window.location.assign(data.redirectUrl);
  } catch (error) {
    showPayoutMessage(error.message, true);
  } finally {
    button.disabled = !csrfToken || document.getElementById('payoutStatusPill').textContent !== 'ENABLED';
  }
});

initializeAdminAuth();
