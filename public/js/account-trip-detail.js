// ─── COPY PNR ───
(function() {
  const btn = document.getElementById('bpCopyBtn');
  const pnrEl = document.getElementById('bpPnr');
  if (!btn || !pnrEl) return;
  btn.addEventListener('click', function() {
    const pnr = pnrEl.textContent.trim();
    navigator.clipboard.writeText(pnr).then(function() {
      var txt = document.getElementById('bpCopyText');
      if (txt) { txt.textContent = 'Copied!'; setTimeout(function() { txt.textContent = 'Copy'; }, 1500); }
    }).catch(function() {});
  });
})();

(function() {
  // ─── TRAVEL-DAY COMPANION ───
  const block = document.getElementById('travelDayBlock');
  if (!block) return;
  const reference = block.dataset.reference;
  if (!reference) return;

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function countdownLabel(hours) {
    if (hours < 0) return `Departed ${Math.abs(hours)}h ago`;
    if (hours < 1) return 'Departing within the hour';
    if (hours < 24) return `Departing in ${hours}h`;
    const days = Math.floor(hours / 24);
    const remH = hours % 24;
    return `Departing in ${days}d${remH > 0 ? ' ' + remH + 'h' : ''}`;
  }

  function checklistStorageKey() {
    return `flightdojo:checklist:${reference}`;
  }

  function loadChecked() {
    try {
      const raw = localStorage.getItem(checklistStorageKey());
      return raw ? new Set(JSON.parse(raw)) : new Set();
    } catch (e) { return new Set(); }
  }

  function saveChecked(set) {
    try {
      localStorage.setItem(checklistStorageKey(), JSON.stringify([...set]));
    } catch (e) {}
  }

  async function load() {
    let data;
    try {
      const res = await fetch(`/api/account/bookings/${encodeURIComponent(reference)}/travel-day`);
      data = await res.json();
    } catch (err) { return; }
    if (!data.show) return;

    block.style.display = 'block';
    const checked = loadChecked();

    const weatherHtml = data.weather ? `
      <div class="travel-day-weather">
        <img src="https://openweathermap.org/img/wn/${escapeHtml(data.weather.icon)}@2x.png" alt="" class="travel-day-weather-icon"/>
        <div>
          <div class="travel-day-weather-temp">${data.weather.temp_c}°C</div>
          <div class="travel-day-weather-cond">${escapeHtml(data.weather.description || data.weather.conditions)}</div>
          <div class="travel-day-weather-meta">
            <span>Feels like ${data.weather.feels_like_c}°C</span>
            <span>· Humidity ${data.weather.humidity}%</span>
            <span>· Wind ${data.weather.wind_kph} km/h</span>
          </div>
        </div>
      </div>
    ` : '';

    const checklistHtml = data.checklist.map(item => `
      <label class="travel-day-item ${item.critical ? 'critical' : ''}" data-id="${escapeHtml(item.id)}">
        <input type="checkbox" ${checked.has(item.id) ? 'checked' : ''}/>
        <span class="travel-day-item-label">${escapeHtml(item.label)}</span>
        ${item.critical ? '<span class="travel-day-critical">Critical</span>' : ''}
      </label>
    `).join('');

    block.innerHTML = `
      <div class="travel-day-header">
        <div>
          <div class="travel-day-eyebrow">Travel day companion</div>
          <h2 class="travel-day-countdown">${escapeHtml(countdownLabel(data.hours_until))}</h2>
          ${data.destination_name ? `<p class="travel-day-sub">Heading to <strong>${escapeHtml(data.destination_name)}</strong> (${escapeHtml(data.destination)})</p>` : ''}
        </div>
      </div>
      ${weatherHtml}
      <div class="travel-day-checklist-section">
        <div class="travel-day-checklist-title">Don't forget</div>
        <div class="travel-day-checklist">${checklistHtml}</div>
      </div>
    `;

    block.querySelectorAll('.travel-day-item input').forEach(input => {
      input.addEventListener('change', () => {
        const id = input.closest('.travel-day-item').dataset.id;
        const set = loadChecked();
        if (input.checked) set.add(id); else set.delete(id);
        saveChecked(set);
      });
    });
  }

  load();
})();
