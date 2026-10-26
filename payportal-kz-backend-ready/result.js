'use strict';
const orderId = new URLSearchParams(window.location.search).get('order') || '';
const heading = document.getElementById('resultHeading');
const text = document.getElementById('resultText');
const label = document.getElementById('statusLabel');
const order = document.getElementById('orderId');
const mark = document.getElementById('resultMark');
order.textContent = orderId ? `Order ID: ${orderId}` : 'Тапсырыс нөмірі URL ішінде жоқ.';
let attempts = 0;
async function refreshStatus() {
  if (!orderId) {
    heading.textContent = 'Тапсырыс нөмірі жоқ';
    text.textContent = 'Нақты төлем мәртебесін тексеру үшін тапсырыс нөмірі қажет.';
    label.textContent = 'ORDER ID / MISSING';
    return;
  }
  try {
    const response = await fetch(`/api/status/${encodeURIComponent(orderId)}`, { headers: { Accept: 'application/json' }, cache: 'no-store' });
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) throw new Error('Төлем серверіне қолжетімсіз. Сайттың API backend-і іске қосылуы қажет.');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Статус табылмады');
    if (data.status === 'paid') {
      mark.textContent = '✓'; mark.classList.add('paid'); mark.classList.remove('failed');
      heading.textContent = 'Төлем расталды';
      text.textContent = 'Провайдердің серверлік жауабы тексерілді. Төменде осы тапсырыстың статусы көрсетілген.';
      label.textContent = `ТӨЛЕНДІ · ${Number(data.amount).toLocaleString('kk-KZ')} ₸`;
    } else if (data.status === 'failed') {
      mark.textContent = '!'; mark.classList.add('failed'); mark.classList.remove('paid');
      heading.textContent = 'Төлем расталмады';
      text.textContent = 'Провайдер төлемді сәтті деп растаған жоқ. Қайта төлем жасамас бұрын банк және провайдер тарихын тексеріңіз.';
      label.textContent = 'FAILED / ТӨЛЕНБЕДІ';
    } else {
      mark.textContent = '↻'; mark.classList.remove('paid', 'failed');
      heading.textContent = 'Төлем статусы күтілуде';
      text.textContent = 'Провайдердің серверлік жауабы әлі келмеген болуы мүмкін. Браузердің қайта оралуы төлемді өздігінен растамайды.';
      label.textContent = 'PENDING / КҮТІЛУДЕ';
      if (attempts < 12) setTimeout(refreshStatus, 2500);
    }
  } catch (error) {
    heading.textContent = 'Статусты алу мүмкін болмады';
    text.textContent = error.message;
    label.textContent = 'SERVER / NETWORK ERROR';
  }
  attempts += 1;
}
refreshStatus();
