'use strict';
const paymentForm = document.getElementById('paymentForm');
const payButton = document.getElementById('payButton');
const paymentMessage = document.getElementById('paymentMessage');
const modePill = document.getElementById('modePill');
const modeText = document.getElementById('modeText');
const apiStatusTitle = document.getElementById('apiStatusTitle');
const apiStatusDescription = document.getElementById('apiStatusDescription');
const menuToggle = document.getElementById('menuToggle');
const mainNav = document.getElementById('mainNav');

function showMessage(text, kind = '') {
  if (!paymentMessage) return;
  paymentMessage.hidden = false;
  paymentMessage.className = `message ${kind}`.trim();
  paymentMessage.textContent = text;
}
function setApiState(kind, label, title, description) {
  if (modeText) modeText.textContent = label;
  if (modePill) modePill.classList.toggle('error', kind === 'error');
  if (apiStatusTitle) apiStatusTitle.textContent = title;
  if (apiStatusDescription) apiStatusDescription.textContent = description;
}
async function loadConfig() {
  try {
    const response = await fetch('/api/config', { headers: { Accept: 'application/json' }, cache: 'no-store' });
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) throw new Error('Backend unavailable');
    const config = await response.json();
    if (!response.ok) throw new Error(config.error || 'API unavailable');
    if (!config.configured) {
      setApiState('error', 'API ОРНАТЫЛМАҒАН', 'Сервер бар, бірақ API дайын емес', config.message || 'Freedom Pay мерчант кілттері қосылмаған. Нақты төлем сұрауы жасалмайды.');
    } else if (config.mode === 'test') {
      setApiState('error', 'TEST MODE', 'Провайдердің тест режимі', 'Интеграция бапталған. Төлемдер провайдердің тест ортасында өңделеді, бұл live ақша аударымы емес.');
    } else {
      setApiState('', 'LIVE API ҚОСЫЛҒАН', 'Провайдер баптауы бар', 'Сұрау сервер арқылы провайдерге жіберіледі. Нақты мәртебе тек серверлік callback тексерілгеннен кейін расталады.');
    }
  } catch {
    setApiState('error', 'СЕРВЕР ҚОСЫЛМАҒАН', 'Backend қолжетімсіз', 'Қазір бет дизайны ғана ашылып тұр. Төлем функциясы іске қосылуы үшін осы жобаның Node.js серверін де жариялау керек.');
  }
}
if (paymentForm && payButton) {
  paymentForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    paymentMessage.hidden = true;
    payButton.disabled = true;
    const label = payButton.querySelector('span');
    const oldLabel = label.textContent;
    label.textContent = 'Сервер тексеріліп жатыр…';
    const amount = Number(document.getElementById('amount').value);
    const description = document.getElementById('description').value.trim();
    try {
      const response = await fetch('/api/payments', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ amount, description })
      });
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) throw new Error('Төлем сервері қосылмаған. Бұл сайтта ақша алынған жоқ. Node.js backend-ті жариялау керек.');
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Төлем сұрауын жасау мүмкін болмады.');
      showMessage(`Тапсырыс ${data.orderId} серверде құрылды. Қауіпсіз төлем бетіне бағыттаймыз.`, '');
      window.location.assign(data.redirectUrl);
    } catch (error) {
      showMessage(error.message || 'Сервермен байланыс болмады. Төлем жасалған жоқ.', 'error');
      payButton.disabled = false;
      label.textContent = oldLabel;
    }
  });
}
if (menuToggle && mainNav) {
  menuToggle.addEventListener('click', () => {
    const open = mainNav.classList.toggle('open');
    menuToggle.setAttribute('aria-expanded', String(open));
  });
  mainNav.querySelectorAll('a').forEach((link) => link.addEventListener('click', () => {
    mainNav.classList.remove('open'); menuToggle.setAttribute('aria-expanded', 'false');
  }));
}
const year = document.getElementById('year');
if (year) year.textContent = String(new Date().getFullYear());
loadConfig();
