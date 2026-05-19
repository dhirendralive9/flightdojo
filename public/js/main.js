(function() {
  const root = document.documentElement;
  const stored = localStorage.getItem('fd-theme');
  root.setAttribute('data-theme', (stored === 'dark' || stored === 'light') ? stored : 'light');
})();

let __fdTurnstileWidgetId = null;
let __fdTurnstileToken = null;

window.fdTurnstileLoad = function fdTurnstileLoad() {
  renderTurnstile();
};

function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

function renderTurnstile() {
  const wrap = document.getElementById('turnstileWidget');
  if (!wrap || !window.turnstile || !window.FD_TURNSTILE_SITEKEY) return;

  if (__fdTurnstileWidgetId !== null) {
    try { window.turnstile.remove(__fdTurnstileWidgetId); } catch (e) {}
    __fdTurnstileWidgetId = null;
  }

  wrap.innerHTML = '';
  __fdTurnstileToken = null;
  updateSubmitState();

  try {
    __fdTurnstileWidgetId = window.turnstile.render(wrap, {
      sitekey: window.FD_TURNSTILE_SITEKEY,
      theme: currentTheme(),
      size: 'flexible',
      appearance: 'always',
      action: 'flight-search',
      callback: (token) => {
        __fdTurnstileToken = token;
        updateSubmitState();
      },
      'expired-callback': () => {
        __fdTurnstileToken = null;
        updateSubmitState();
      },
      'error-callback': () => {
        __fdTurnstileToken = null;
        updateSubmitState();
      }
    });
  } catch (err) {
    console.error('Turnstile render error:', err);
  }
}

function updateSubmitState() {
  const btn = document.getElementById('searchSubmit');
  if (!btn) return;
  btn.disabled = !__fdTurnstileToken;
}

document.addEventListener('DOMContentLoaded', () => {
  if (window.lucide) lucide.createIcons();

  const toggle = document.getElementById('themeToggle');
  if (toggle) {
    toggle.addEventListener('click', () => {
      const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('fd-theme', next);
      if (window.turnstile && document.getElementById('turnstileWidget')) {
        renderTurnstile();
      }
    });
  }

  const hamburger = document.getElementById('hamburger');
  const mobileMenu = document.getElementById('mobileMenu');
  if (hamburger && mobileMenu) {
    hamburger.addEventListener('click', () => {
      mobileMenu.classList.toggle('open');
      const open = mobileMenu.classList.contains('open');
      hamburger.innerHTML = `<i data-lucide="${open ? 'x' : 'menu'}" style="width:22px;height:22px;"></i>`;
      if (window.lucide) lucide.createIcons();
    });
  }

  document.querySelectorAll('.s-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      if (tab.disabled) return;
      tab.closest('.search-tabs').querySelectorAll('.s-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const trip = tab.dataset.trip;
      const returnField = document.getElementById('returnField');
      const returnInput = document.getElementById('returnInput');
      if (returnField && returnInput) {
        if (trip === 'oneway') {
          returnField.style.opacity = '0.4';
          returnField.style.pointerEvents = 'none';
          returnInput.value = '';
          returnInput.disabled = true;
        } else {
          returnField.style.opacity = '1';
          returnField.style.pointerEvents = 'auto';
          returnInput.disabled = false;
        }
      }
    });
  });

  const paxNum = document.getElementById('paxNum');
  const paxInput = document.getElementById('paxInput');
  if (paxNum) {
    let pax = parseInt(paxInput?.value || '1', 10);
    document.querySelectorAll('[data-pax]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const d = parseInt(btn.dataset.pax, 10);
        pax = Math.max(1, Math.min(9, pax + d));
        paxNum.textContent = pax;
        if (paxInput) paxInput.value = pax;
      });
    });
  }

  setupAutocomplete('originInput', 'originSuggest', 'originHint');
  setupAutocomplete('destInput', 'destSuggest', 'destHint');

  const swapBtn = document.getElementById('swapBtn');
  if (swapBtn) {
    swapBtn.addEventListener('click', () => {
      const o = document.getElementById('originInput');
      const d = document.getElementById('destInput');
      const oh = document.getElementById('originHint');
      const dh = document.getElementById('destHint');
      if (o && d) {
        [o.value, d.value] = [d.value, o.value];
        if (oh && dh) [oh.textContent, dh.textContent] = [dh.textContent, oh.textContent];
      }
    });
  }

  const heroSearchBtn = document.getElementById('heroSearchBtn');
  if (heroSearchBtn) {
    heroSearchBtn.addEventListener('click', () => {
      const card = document.querySelector('.search-card');
      if (card) {
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        const originIn = document.getElementById('originInput');
        if (originIn) setTimeout(() => originIn.focus(), 400);
      }
    });
  }

  const sortBtns = document.querySelectorAll('.sort-btn');
  const offersList = document.getElementById('offersList');
  if (sortBtns.length && offersList) {
    sortBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        sortBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const sort = btn.dataset.sort;
        const cards = Array.from(offersList.querySelectorAll('.offer-card'));
        cards.sort((a, b) => {
          if (sort === 'price') {
            return parseFloat(a.dataset.price) - parseFloat(b.dataset.price);
          } else if (sort === 'duration') {
            return durationToMinutes(a.dataset.duration) - durationToMinutes(b.dataset.duration);
          } else if (sort === 'depart') {
            return new Date(a.dataset.depart) - new Date(b.dataset.depart);
          }
          return 0;
        });
        cards.forEach(c => offersList.appendChild(c));
      });
    });
  }

  const obs = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if (e.isIntersecting) {
        e.target.classList.add('visible');
        obs.unobserve(e.target);
      }
    });
  }, { threshold: 0.12 });
  document.querySelectorAll('.reveal, .stagger').forEach(el => obs.observe(el));

  const searchForm = document.getElementById('searchForm');
  if (searchForm) {
    searchForm.addEventListener('submit', (e) => {
      if (!__fdTurnstileToken) {
        e.preventDefault();
        return;
      }
      const btn = searchForm.querySelector('.btn-search-full');
      if (btn) {
        btn.innerHTML = '<span class="spinner"></span> Searching airlines…';
        btn.style.opacity = '0.85';
        btn.disabled = true;
      }
    });
  }
});

function setupAutocomplete(inputId, suggestId, hintId) {
  const input = document.getElementById(inputId);
  const suggest = document.getElementById(suggestId);
  const hint = document.getElementById(hintId);
  if (!input || !suggest) return;

  let activeIdx = -1;
  let items = [];
  let debounceTimer = null;

  async function fetchSuggestions(q) {
    try {
      const res = await fetch('/api/airports/search?q=' + encodeURIComponent(q));
      const data = await res.json();
      items = data.results || [];
      render();
    } catch (err) {
      items = [];
      render();
    }
  }

  function render() {
    if (!items.length) {
      suggest.classList.remove('open');
      suggest.innerHTML = '';
      return;
    }
    suggest.innerHTML = items.map((a, i) => `
      <div class="s-sug-item${i === activeIdx ? ' active' : ''}" data-iata="${a.iata}" data-name="${a.name}">
        <span class="s-sug-iata">${a.iata}</span>
        <div class="s-sug-info">
          <div class="s-sug-name">${a.city} · ${a.name}</div>
          <div class="s-sug-country">${a.country}</div>
        </div>
      </div>
    `).join('');
    suggest.classList.add('open');
    suggest.querySelectorAll('.s-sug-item').forEach(el => {
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        choose(el.dataset.iata, el.dataset.name);
      });
    });
  }

  function choose(iata, name) {
    input.value = iata;
    if (hint) hint.textContent = name;
    suggest.classList.remove('open');
    activeIdx = -1;
  }

  input.addEventListener('input', () => {
    const v = input.value.trim();
    input.value = v.toUpperCase();
    clearTimeout(debounceTimer);
    if (!v) {
      items = []; render(); return;
    }
    debounceTimer = setTimeout(() => fetchSuggestions(v), 120);
  });

  input.addEventListener('focus', () => {
    if (input.value) fetchSuggestions(input.value);
  });

  input.addEventListener('blur', () => {
    setTimeout(() => suggest.classList.remove('open'), 150);
  });

  input.addEventListener('keydown', (e) => {
    if (!items.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIdx = Math.min(items.length - 1, activeIdx + 1);
      render();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIdx = Math.max(-1, activeIdx - 1);
      render();
    } else if (e.key === 'Enter' && activeIdx >= 0) {
      e.preventDefault();
      const a = items[activeIdx];
      choose(a.iata, a.name);
    } else if (e.key === 'Escape') {
      suggest.classList.remove('open');
    }
  });
}

function durationToMinutes(iso) {
  if (!iso) return 9999;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  if (!m) return 9999;
  return (parseInt(m[1] || 0, 10) * 60) + parseInt(m[2] || 0, 10);
}
