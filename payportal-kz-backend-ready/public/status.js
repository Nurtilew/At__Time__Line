'use strict';
const statusForm = document.getElementById('statusForm');
const orderInput = document.getElementById('orderInput');
const statusOutput = document.getElementById('statusOutput');
const statusButton = document.getElementById('statusButton');
function showStatus(text, ok = false) {
  statusOutput.textContent = text;
  statusOutput.style.borderColor = ok ? '#49633b' : '#3a4030';
}
statusForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const orderId = orderInput.value.trim();
  if (!orderId) return;
  statusButton.disabled = true;
  statusButton.querySelector('span').textContent = '…';
  showStatus('Сервер деректері тексеріліп жатыр…');
  try {
    const response = await fetch(`/api/status/${encodeURIComponent(orderId)}`, { headers: { Accept: 'application/json' }, cache: 'no-store' });
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) throw new Error('Backend қосылмаған. Тек сайттың статикалық беті ашық тұр; нақты статус қолжетімсіз.');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Тапсырыс табылмады.');
    const labels = { paid: 'ТӨЛЕНДІ', pending: 'КҮТІЛУДЕ', failed: 'ТӨЛЕМ РАСТАЛМАҒАН' };
    const amount = Number(data.amount).toLocaleString('kk-KZ');
    const created = data.createdAt ? new Date(data.createdAt).toLocaleString('kk-KZ') : '—';
    showStatus(`${labels[data.status] || String(data.status).toUpperCase()}\nТапсырыс: ${data.orderId}\nСома: ${amount} ₸\nҚызмет: ${data.description}\nҚұрылған уақыты: ${created}`, data.status === 'paid');
  } catch (error) { showStatus(error.message || 'Серверден жауап алынбады.'); }
  finally { statusButton.disabled = false; statusButton.querySelector('span').textContent = '↗'; }
});
const queryOrder = new URLSearchParams(window.location.search).get('order');
if (queryOrder) { orderInput.value = queryOrder; statusForm.requestSubmit(); }
