// ==UserScript==
// @name         YT Channel Collector v2 (debug + tolerant)
// @namespace    http://tampermonkey.net/
// @version      2026-01-31
// @description  Collect channel links from YouTube search results with safer parsing, dedupe, throttling, UI + debug.
// @author       You
// @match        https://www.youtube.com/results?search_query=*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=youtube.com
// @grant        GM.xmlHttpRequest
// @require      https://greasyfork.org/scripts/470000/code/GM%20Requests.js
// ==/UserScript==

(function () {
  'use strict';

  // --------------------
  // Config
  // --------------------
  const CFG = {
    stateKey: 'yt_parser_v2_state',
    endpoint: 'https://ci70535.tw1.ru/yt.php',
    queryEndpoint: 'https://ci70535.tw1.ru/get_next_query.php',
    // ИСПРАВЛЕНО: Теперь используется ваш ngrok адрес
    aiGenerateEndpoint: 'https://porchless-volcanically-isreal.ngrok-free.dev/run_query_learning',
    apiKey: '',

    autoRefillRetries: 15,
    autoRefillPauseMinMs: 3000,
    autoRefillPauseMaxMs: 6000,
    aiGenerateTimeoutMs: 90000,

    // Broad filter by default (can be strict, but tolerant mode will still collect when views are missing)
    minViews: 90_000,
    maxViews: 1_000_000,

    // Safety / speed balance
    maxItemsToScan: 1200,
    idleRoundsToStop: 6,
    scrollStepPx: 1200,
    tickMsMin: 650,
    tickMsMax: 1400,

    // Send in chunks to avoid huge payloads
    postChunkSize: 60,

    // Search parameter you used
    sp: 'CAASBAgEEAE%253D',
  };

  // --------------------
  // Debug (console)
  // --------------------
  const DEBUG = true;        // выключи, когда всё ок
  const DEBUG_LIMIT = 30;    // сколько элементов распечатать
  let debugCount = 0;

  // --------------------
  // Utils
  // --------------------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const randInt = (a, b) => Math.floor(a + Math.random() * (b - a + 1));

  function nowIso() {
    return new Date().toISOString();
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(CFG.stateKey);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function saveState(state) {
    localStorage.setItem(CFG.stateKey, JSON.stringify(state));
  }

  function defaultState() {
    return {
      v: 2,
      running: false,
      mode: 'manual', // 'manual' | 'auto'
      wordIndex: 0,
      autoQuery: null,
      runFound: 0,
      startedAt: null,
      lastActionAt: null,
      seenChannels: {}, // map channelKey -> 1
      stats: {
        scannedItems: 0,
        collected: 0,
        sent: 0,
        skippedByViews: 0,
        skippedNoViews: 0,
        skippedNoChannel: 0,
        errors: 0,
        skippedNonRuTitle: 0,
      },
    };
  }

  function channelKeyFromUrl(url) {
    try {
      const u = new URL(url, location.origin);
      const p = u.pathname.replace(/\/+$/, '');
      return p.toLowerCase();
    } catch {
      return String(url || '').trim().toLowerCase();
    }
  }

  function parseViewsAny(text) {
      if (!text) return null;

      let t = String(text)
      .toLowerCase()
      .replace(/\u00a0/g, ' ') // nbsp
      .replace(/•/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

      // убираем слова, но оставляем единицы
      t = t.replace(/просмотров|просмотра|просмотр|views?/g, '').trim();

      // 1) СНАЧАЛА: тыс/млн/k/m
      // ВАЖНО: вместо \b используем (?=\s|$), потому что \b не работает с кириллицей как надо
      let m = t.match(/(\d+(?:[.,]\d+)?)\s*(тыс\.?|млн\.?|k|m)(?=\s|$)/i);
      if (m) {
          const num = parseFloat(m[1].replace(',', '.'));
          if (!isFinite(num)) return null;

          const unit = m[2].toLowerCase();
          if (unit.startsWith('тыс') || unit === 'k') return Math.round(num * 1_000);
          if (unit.startsWith('млн') || unit === 'm') return Math.round(num * 1_000_000);
      }

      // 2) Потом: числа с пробелами "12 345"
      m = t.match(/(\d[\d\s]{2,})/);
      if (m) {
          const num = parseInt(m[1].replace(/\s+/g, ''), 10);
          return isFinite(num) ? num : null;
      }

      // 3) В конце: просто число
      m = t.match(/\d+/);
      if (m) {
          const num = parseInt(m[0], 10);
          return isFinite(num) ? num : null;
      }

      return null;
  }

  window.__yt_parseViewsAny = parseViewsAny;

// -----------------------------
// RU TITLE FILTER
// -----------------------------
function hasRuLetters(s) {
  return /[а-яё]/i.test(String(s || ''));
}

function getVideoTitleFromItem(it) {
  // Prefer visible title
  const t = it.querySelector('#video-title')?.textContent?.trim();
  if (t) return t;
  // Fallback: aria-label usually starts with title
  const aria = it.querySelector('#video-title')?.getAttribute('aria-label') || '';
  return String(aria || '').trim();
}

function getViewsFromSearchItem(item) {
    // 1) Most reliable: #metadata-line spans where one is "views"/"просмотров"
    const spans = item.querySelectorAll('#metadata-line span');
    for (const sp of spans) {
      const tx = (sp.textContent || '').trim();
      if (!tx) continue;

      // if it contains views markers or unit markers
      if (/просмотр|views?/i.test(tx) || /(тыс\.?|млн\.?|\b[km]\b)/i.test(tx)) {
        const v = parseViewsAny(tx);
        if (v !== null) return v;
      }
    }

    // 2) aria-label often contains "... 90 тыс. просмотров ..."
    const aria = item.querySelector('#video-title')?.getAttribute('aria-label') || '';
    const vA = parseViewsAny(aria);
    if (vA !== null) return vA;

    // 3) fallback: full metadata line (noisy)
    const md = item.querySelector('#metadata-line')?.textContent || '';
    const v2 = parseViewsAny(md);
    return v2;
  }

  function getChannelUrlFromItem(item) {
    // Try known anchors
    const a1 = item.querySelector('a#channel-thumbnail');
    if (a1?.href) return a1.href;

    const a2 = item.querySelector('ytd-channel-name a');
    if (a2?.href) return a2.href;

    const a3 = item.querySelector('a[href^="/channel/"], a[href^="/@"], a[href^="/c/"], a[href^="/user/"]');
    if (a3?.href) return a3.href;

    return null;
  }

  function postLinksChunk(links) {
    return new Promise((resolve) => {
      const currentQuery = new URL(location.href).searchParams.get('search_query') || '';
      const q = decodeURIComponentSafe(currentQuery);
      const parts = [];
      parts.push('links=' + encodeURIComponent(links.join(',')));
      if (q) parts.push('q=' + encodeURIComponent(q));
      if (CFG.apiKey) parts.push('key=' + encodeURIComponent(CFG.apiKey));
      const data = parts.join('&');
      GM.xmlHttpRequest({
        method: 'POST',
        url: CFG.endpoint,
        data,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        onload: (resp) => resolve({ ok: true, status: resp.status, text: resp.responseText }),
        onerror: (err) => resolve({ ok: false, err }),
        ontimeout: () => resolve({ ok: false, timeout: true }),
      });
    });
  }

// ИСПРАВЛЕНИЕ: Добавлен анти-кэш параметр (_t=Date.now()), чтобы браузер не отдавал старый пустой ответ
function fetchNextQuery() {
  return new Promise((resolve) => {
    const cacheBuster = `_t=${Date.now()}`;
    let url = CFG.queryEndpoint;
    url += (url.includes('?') ? '&' : '?') + cacheBuster;
    if (CFG.apiKey) url += '&key=' + encodeURIComponent(CFG.apiKey);

    GM.xmlHttpRequest({
      method: 'GET',
      url,
      onload: (resp) => {
        const t = String(resp.responseText || '').trim();
        if (resp.status >= 200 && resp.status < 300 && t && t !== 'error') return resolve(t);
        resolve(null);
      },
      onerror: () => resolve(null),
      ontimeout: () => resolve(null),
    });
  });
}


function triggerQueryGeneration(target = 15) {
  return new Promise((resolve) => {
    const url = CFG.aiGenerateEndpoint + (CFG.apiKey ? ('?key=' + encodeURIComponent(CFG.apiKey)) : '');
    GM.xmlHttpRequest({
      method: 'POST',
      url,
      timeout: CFG.aiGenerateTimeoutMs,
      data: JSON.stringify({ target }),
      headers: {
        'Content-Type': 'application/json',
        'ngrok-skip-browser-warning': 'true' // ДОБАВЛЕНО: обходит страницу предупреждения ngrok
      },
      onload: (resp) => {
        let j = null;
        try { j = JSON.parse(resp.responseText || '{}'); } catch {}
        resolve({
          ok: resp.status >= 200 && resp.status < 300,
          status: resp.status,
          json: j,
          text: String(resp.responseText || '').slice(0, 300),
          errorType: null,
        });
      },
      onerror: (err) => resolve({
        ok: false,
        status: 0,
        json: null,
        text: '',
        errorType: 'network_error',
        error: err,
      }),
      ontimeout: () => resolve({
        ok: false,
        status: 0,
        json: null,
        text: '',
        errorType: 'timeout',
      }),
    });
  });
}

function explainGeneratorResult(gen) {
  if (!gen) return 'unknown';
  if (gen.ok) {
    const s = gen?.json?.status;
    if (s === 'busy') return 'busy';
    const inserted = gen?.json?.upsert_result?.inserted_queries;
    const generated = gen?.json?.generated_queries;
    if (typeof inserted === 'number') return `ok, inserted=${inserted}`;
    if (typeof generated === 'number') return `ok, generated=${generated}`;
    return `ok, http=${gen.status}`;
  }
  if (gen.errorType === 'timeout') return `timeout>${CFG.aiGenerateTimeoutMs}ms`;
  if (gen.errorType === 'network_error') return 'network_error';
  if (gen.status) return `http_${gen.status}`;
  return 'unreachable';
}

async function ensureNextQuery(ui) {
  let q = await fetchNextQuery();
  if (q) return q;

  ui.pushLog('AUTO: запросов нет, жду автогенерацию/пополнение...');

  // 1. Стандартный цикл быстрой автогенерации (как было)
  for (let attempt = 1; attempt <= CFG.autoRefillRetries; attempt++) {
    if (CFG.aiGenerateEndpoint) {
      const gen = await triggerQueryGeneration(15);
      const reason = explainGeneratorResult(gen);
      ui.pushLog(`AUTO: генерация ${reason}, попытка ${attempt}/${CFG.autoRefillRetries}`);
    }

    const pauseMs = randInt(CFG.autoRefillPauseMinMs, CFG.autoRefillPauseMaxMs);
    ui.pushLog(`AUTO: жду ${Math.round(pauseMs / 1000)}с перед повторной проверкой очереди...`);
    await sleep(pauseMs);

    q = await fetchNextQuery();
    if (q) return q;
  }

  // 2. Если всё еще пусто — ждем 3 минуты и пробуем снова (2 раза)
  for (let longWait = 1; longWait <= 2; longWait++) {
    ui.pushLog(`AUTO: Запросы всё ещё не найдены. Долгое ожидание 3 минуты (Попытка ${longWait}/2)...`);

    await sleep(180000); // пауза 3 минуты

    ui.pushLog(`AUTO: Проверка запросов после долгого ожидания...`);
    q = await fetchNextQuery();
    if (q) return q;
  }

  return null;
}


  // --------------------
  // UI
  // --------------------
  function mountPanel(state) {
    const panelId = 'yt_parser_v2_panel';
    let panel = document.getElementById(panelId);
    if (panel) panel.remove();

    panel = document.createElement('div');
    panel.id = panelId;
    panel.style.cssText = [
      'position:fixed',
      'right:16px',
      'bottom:16px',
      'z-index:999999',
      'background:rgba(20,20,20,0.92)',
      'color:#fff',
      'padding:12px 12px 10px',
      'border-radius:12px',
      'width:320px',
      'font:12px/1.35 system-ui,-apple-system,Segoe UI,Roboto,Arial',
      'box-shadow:0 10px 30px rgba(0,0,0,0.35)',
    ].join(';');

    const btn = document.createElement('button');
    btn.id = 'yt_parser_v2_toggle';
    btn.textContent = state.running ? 'Стоп' : 'Старт';
    btn.style.cssText = [
      'width:100%',
      'padding:10px 12px',
      'border-radius:10px',
      'border:0',
      'cursor:pointer',
      'font-weight:700',
      'margin-bottom:10px',
    ].join(';');

    const small = document.createElement('div');
    small.id = 'yt_parser_v2_meta';

    const log = document.createElement('div');
    log.id = 'yt_parser_v2_log';
    log.style.cssText = 'margin-top:8px; max-height:90px; overflow:auto; opacity:0.9;';

    panel.appendChild(btn);
    const controlsRow = document.createElement('div');
controlsRow.style.cssText = 'display:flex; gap:8px; margin-bottom:10px;';

const modeSel = document.createElement('select');
modeSel.style.cssText = 'flex:1; padding:8px 10px; border-radius:10px; border:0; font-weight:800;';
// Trusted Types safe: build options without innerHTML
(function(){
  const optManual = document.createElement('option');
  optManual.value = 'manual';
  optManual.textContent = 'Ручной';
  const optAuto = document.createElement('option');
  optAuto.value = 'auto';
  optAuto.textContent = 'Авто';
  modeSel.appendChild(optManual);
  modeSel.appendChild(optAuto);
})();
modeSel.value = state.mode || 'manual';

const resetBtn = document.createElement('button');
resetBtn.textContent = 'Сброс';
resetBtn.style.cssText = 'flex:1; padding:8px 10px; border-radius:10px; border:0; cursor:pointer; font-weight:800; opacity:0.95;';

controlsRow.appendChild(modeSel);
controlsRow.appendChild(resetBtn);

    panel.appendChild(controlsRow);
    panel.appendChild(small);
    panel.appendChild(log);

    document.body.appendChild(panel);

    function writeMeta() {
      const w = state.wordIndex ?? 0;
      const q = new URL(location.href).searchParams.get('search_query') || '';
      const s = state.stats || {};

      while (small.firstChild) small.removeChild(small.firstChild);

      const row1 = document.createElement('div');
      row1.style.cssText = 'display:flex; gap:10px; flex-wrap:wrap;';
      const k = document.createElement('div');
      const kB = document.createElement('b');
      kB.textContent = 'Ключ:';
      const kTxt = document.createElement('span');
      kTxt.textContent = ' ' + q.slice(0, 36);
      k.appendChild(kB);
      k.appendChild(kTxt);

      const idx = document.createElement('div');
      const idxB = document.createElement('b');
      idxB.textContent = 'Index:';
      const idxTxt = document.createElement('span');
      idxTxt.textContent = ' ' + String(w);
      idx.appendChild(idxB);
      idx.appendChild(idxTxt);

      row1.appendChild(k);
      row1.appendChild(idx);

      const mode = document.createElement('div');
      // Trusted Types safe: label without innerHTML
(function() {
  const b = document.createElement('b');
  b.textContent = 'Режим:';
  mode.appendChild(b);
  mode.appendChild(document.createTextNode(' ' + String((state.mode || 'manual'))));
})();
      row1.appendChild(mode);

      const rf = document.createElement('div');
      // Trusted Types safe: label without innerHTML
(function() {
  const b = document.createElement('b');
  b.textContent = 'Найдено(run):';
  rf.appendChild(b);
  rf.appendChild(document.createTextNode(' ' + String(String(state.runFound || 0))));
})();
      row1.appendChild(rf);

      const grid = document.createElement('div');
      grid.style.cssText = 'margin-top:6px; display:grid; grid-template-columns: 1fr 1fr; gap:6px;';

      const mk = (label, val) => {
        const d = document.createElement('div');
        const b = document.createElement('b');
        b.textContent = String(val);
        d.appendChild(document.createTextNode(label + ': '));
        d.appendChild(b);
        return d;
      };

      grid.appendChild(mk('Проскан', s.scannedItems || 0));
      grid.appendChild(mk('Собрано', s.collected || 0));
      grid.appendChild(mk('Отправл', s.sent || 0));
      grid.appendChild(mk('Ошибок', s.errors || 0));
      grid.appendChild(mk('Skip views', s.skippedByViews || 0));
      grid.appendChild(mk('Skip noViews', s.skippedNoViews || 0));
      grid.appendChild(mk('Skip noCh', s.skippedNoChannel || 0));
      grid.appendChild(mk('Skip nonRU', s.skippedNonRuTitle || 0));

      const filt = document.createElement('div');
      filt.style.cssText = 'margin-top:6px; opacity:.85;';
      filt.textContent = `Фильтр: ${Math.round(CFG.minViews / 1000)}k–${Math.round(CFG.maxViews / 1000)}k (tolerant: collect if noViews)`;

      small.appendChild(row1);
      small.appendChild(grid);
      small.appendChild(filt);
    }

    function pushLog(line) {
      const el = document.createElement('div');
      el.textContent = `[${nowIso().slice(11, 19)}] ${line}`;
      log.prepend(el);
      while (log.childNodes.length > 18) log.removeChild(log.lastChild);
    }

    btn.onclick = () => {
      state.running = !state.running;
      state.lastActionAt = nowIso();
      if (state.running && !state.startedAt) state.startedAt = nowIso();
      saveState(state);
      btn.textContent = state.running ? 'Стоп' : 'Старт';
      pushLog(state.running ? 'Запуск парсера' : 'Остановка парсера');
      if (state.running) runCollector(state, { pushLog, writeMeta });
    };
modeSel.onchange = () => {
  state.mode = modeSel.value === 'auto' ? 'auto' : 'manual';
  // reset navigation pointers on mode change
  if (state.mode === 'manual') {
    state.autoQuery = null;
  } else {
    state.wordIndex = 0;
  }
  state.lastActionAt = nowIso();
  saveState(state);
  pushLog('Режим: ' + state.mode);
  writeMeta();
};

resetBtn.onclick = async () => {
  if (state.mode === 'manual') {
    // full reset and go to the first word
    state.wordIndex = 0;
    state.seenChannels = {};
    state.runFound = 0;
    state.stats = { scannedItems: 0, collected: 0, sent: 0, skippedByViews: 0, skippedNoViews: 0, skippedNoChannel: 0, errors: 0, skippedNonRuTitle: 0 };
    state.lastActionAt = nowIso();
    saveState(state);
    pushLog('Сброс (ручной): начинаю с первого слова');
    const words = getWords();
    if (words.length) navigateToQuery(words[0]);
  } else {
    // AUTO mode reset: only VISUAL reset.
    // Do NOT touch server-side queue and do NOT force a new query.
    // Users expect this button to reset local counters ("собрано/отправлено") only.
    state.runFound = 0;
    state.stats = { scannedItems: 0, collected: 0, sent: 0, skippedByViews: 0, skippedNoViews: 0, skippedNoChannel: 0, errors: 0, skippedNonRuTitle: 0 };
    state.lastActionAt = nowIso();
    saveState(state);
    pushLog('Сброс (авто): сбросил только счетчики (запрос/очередь не трогал)');
    writeMeta();
  }
};



    writeMeta();
    return { pushLog, writeMeta };
  }

  // --------------------
  // Main logic
  // --------------------
  async function runCollector(state, ui) {
    if (!state.running) return;

    const words = getWords();
const currentQueryRaw = new URL(location.href).searchParams.get('search_query') || '';
const currentQuery = decodeURIComponentSafe(currentQueryRaw);

if (state.mode === 'manual') {
  if (!words.length) return;
  const expected = words[state.wordIndex] ?? words[0];
  if (currentQuery !== expected) {
    ui.pushLog(`Переход к ключу: ${expected}`);
    navigateToQuery(expected);
    return;
  }
} else {
  // AUTO mode: use server-provided query
  if (!state.autoQuery) {
    ui.pushLog('AUTO: получаю следующий запрос с сервера...');
    const q = await ensureNextQuery(ui);
    if (!q) {
      ui.pushLog('AUTO: после ожидания/генерации запросы не появились, останавливаюсь');
      state.running = false;
      saveState(state);
      ui.writeMeta();
      return;
    }
    state.autoQuery = q;
    saveState(state);
    ui.pushLog(`AUTO: запрос: ${q}`);
    navigateToQuery(q);
    return;
  }

  if (currentQuery !== state.autoQuery) {
    ui.pushLog(`AUTO: переход к запросу: ${state.autoQuery}`);
    navigateToQuery(state.autoQuery);
    return;
  }
}

    ui.pushLog('Сбор элементов выдачи...');

    const pending = [];
    const seenThisPage = new Set();

    let lastCount = 0;
    let idleRounds = 0;

    const pickItems = () => document.querySelectorAll('ytd-video-renderer.style-scope.ytd-item-section-renderer');

    let mo = null;
    const waitForMutations = () =>
      new Promise((resolve) => {
        let done = false;
        const timer = setTimeout(() => {
          if (done) return;
          done = true;
          try { mo && mo.disconnect(); } catch {}
          resolve(false);
        }, 1500);

        mo = new MutationObserver(() => {
          if (done) return;
          const cnt = pickItems().length;
          if (cnt > lastCount) {
            done = true;
            clearTimeout(timer);
            try { mo.disconnect(); } catch {}
            resolve(true);
          }
        });

        const target = document.querySelector('ytd-page-manager') || document.body;
        mo.observe(target, { childList: true, subtree: true });
      });

    while (state.running) {
      const items = pickItems();
      state.stats.scannedItems = items.length;

      for (let i = 0; i < items.length && i < CFG.maxItemsToScan; i++) {
        const it = items[i];

        const chUrl = getChannelUrlFromItem(it);
        if (!chUrl) {
          state.stats.skippedNoChannel++;
          continue;
        }

        const key = channelKeyFromUrl(chUrl);
        if (state.seenChannels[key] || seenThisPage.has(key)) continue;

        // Skip channels whose video title has NO Russian letters at all
        const vTitle = getVideoTitleFromItem(it);
        if (!hasRuLetters(vTitle)) {
          state.stats.skippedNonRuTitle = (state.stats.skippedNonRuTitle || 0) + 1;
          seenThisPage.add(key);
          state.seenChannels[key] = 1; // treat as permanently skipped
          continue;
        }

        const v = getViewsFromSearchItem(it);

        if (v === null) {
          // tolerant mode: if views cannot be parsed, still collect the channel
          state.stats.skippedNoViews++;
          pending.push(chUrl);
          seenThisPage.add(key);
          state.seenChannels[key] = 1;
          state.stats.collected++;
          state.runFound = (state.runFound || 0) + 1;
          continue;
        }

        if (v < CFG.minViews || v > CFG.maxViews) {
          state.stats.skippedByViews++;
          seenThisPage.add(key);
          continue;
        }

        pending.push(chUrl);
        seenThisPage.add(key);
        state.seenChannels[key] = 1;
        state.stats.collected++;
          state.runFound = (state.runFound || 0) + 1;
      }

      ui.writeMeta();
      saveState(state);

      while (pending.length >= CFG.postChunkSize) {
        const chunk = pending.splice(0, CFG.postChunkSize);
        ui.pushLog(`Отправка ${chunk.length} каналов...`);
        const res = await postLinksChunk(chunk);
        if (res.ok) {
          state.stats.sent += chunk.length;
          ui.pushLog(`OK (${chunk.length}), status=${res.status}`);
        } else {
          state.stats.errors++;
          ui.pushLog('Ошибка отправки, вернул chunk обратно в очередь');
          pending.unshift(...chunk);
          await sleep(randInt(1800, 3200));
          break;
        }
        ui.writeMeta();
        saveState(state);
        await sleep(randInt(550, 1100));
      }

      if (items.length === lastCount) idleRounds++;
      else idleRounds = 0;
      lastCount = items.length;

      if (items.length >= CFG.maxItemsToScan || idleRounds >= CFG.idleRoundsToStop) {
        ui.pushLog('Похоже, выдача закончилась. Финальная отправка + следующий ключ.');

        if (pending.length) {
          for (let i = 0; i < pending.length; i += CFG.postChunkSize) {
            const chunk = pending.slice(i, i + CFG.postChunkSize);
            const res = await postLinksChunk(chunk);
            if (res.ok) {
              state.stats.sent += chunk.length;
            } else {
              state.stats.errors++;
              ui.pushLog('Ошибка финальной отправки (часть каналов могла не уйти).');
              break;
            }
            await sleep(randInt(450, 900));
          }
          pending.length = 0;
        }

        if (state.mode === 'manual') {
          if (words[state.wordIndex + 1] == null) {
            ui.pushLog('Готово: ключи закончились');
            state.running = false;
            saveState(state);
            ui.writeMeta();
            return;
          }
          state.wordIndex++;
          saveState(state);
          navigateToQuery(words[state.wordIndex]);
          return;
        } else {
          ui.pushLog('AUTO: беру следующий запрос...');
          state.autoQuery = null;
          saveState(state);
          const q = await ensureNextQuery(ui);
          if (!q) {
            ui.pushLog('AUTO: после автодогенерации запросов всё ещё нет, останавливаюсь');
            state.running = false;
            saveState(state);
            ui.writeMeta();
            return;
          }
          state.autoQuery = q;
          saveState(state);
          navigateToQuery(q);
          return;
        }
      }

      window.scrollBy(0, CFG.scrollStepPx + randInt(-200, 300));
      await Promise.race([waitForMutations(), sleep(randInt(CFG.tickMsMin, CFG.tickMsMax))]);
    }
  }

  function decodeURIComponentSafe(s) {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  }

  function navigateToQuery(q) {
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&sp=${CFG.sp}`;
    location.href = url;
  }

  function getWords() {
    return [
      "стендап","комедия","юмор","шутки","монолог","импровизация","сарказм","ирония","панчлайн","комик",
      "юморист","скетч","пародия","наблюдения","абсурд","черный юмор","самоирония","остроумие","выступление","open mic",
      "научпоп","наука","физика","космос","астрономия","биология","химия","математика","эксперимент","гипотеза",
      "факты","объяснение","теория","популяризация","технологии","инженерия","роботы","искусственный интеллект","нейросети","будущее",
      "история науки","психология","нейробиология","медицина","эволюция","климат","экология","квантовый","исследование","данные",
      "бизнес","предпринимательство","стартап","инвестиции","деньги","финансы","маркетинг","продажи","бренд","личный бренд",
      "менеджмент","управление","стратегия","аналитика","кейсы","интервью","мотивация","успех","карьера","нетворкинг",
      "экономика","рынки","акции","криптовалюта","венчур","масштабирование","продукт","бизнес-мышление","переговоры","лидерство",
      "лайвстайл","жизнь","рутина","влоги","повседневность","привычки","саморазвитие","продуктивность","тайм-менеджмент","баланс",
      "здоровье","спорт","фитнес","питание","осознанность","медитация","путешествия","город","дом","уют",
      "мода","стиль","уход","минимализм","мотивация","утро","вечер","работа","отдых","хобби",
      "игры","видеоигры","геймплей","прохождение","стрим","летсплей","обзор","рецензия","инди","AAA",
      "шутер","RPG","стратегия","симулятор","MMO","киберспорт","турнир","скорость","скилл","тактика",
      "прохождение","боссы","lore","сюжет","механики","патч","обновление","мод","ретро","консоль",
      "развлечения","шоу","реалити","челлендж","пранк","реакции","реакция","обзор","тренды","вирусное",
      "ток-шоу","интервью","подкаст","влог","эксперименты","форматы","креатив","юмор","развлекательный","лайт",
      "ютуб","видео","канал","автор","инфлюенсер","блогер","контент","алгоритмы","просмотры","подписчики",
      "монетизация","коллаборация","реклама","продакшн","монтаж","сценарий","формат","идея","креатор","креативщик",
      "подкасты","стриминг","shorts","reels","тикток","платформы","соцсети","комьюнити","аудитория","фидбек",
      "культура","поп-культура","мемы","интернет","тренд","фандом","обсуждение","дискуссия","обзор новостей","дайджест",
      "технологии","гаджеты","смартфоны","обзоры техники","приложения","софт","апдейты","девайсы","UX","UI",
      "обучение","образование","курсы","самообучение","навыки","разборы","гайд","туториал","объясняю","простыми словами",
      "истории","сторителлинг","личный опыт","фейлы","успехи","путь","закулисье","бэкстейдж","честно","без цензуры",
      "разговоры","мнения","точка зрения","аналитика","разбор","критика","рефлексия","наблюдения","мысли",
      "вдохновение","цели","достижения","рост","мышление","привычки успеха","дисциплина","фокус","энергия",
      "юмористические","развлекательные форматы","шоу-формат","онлайн-шоу","реакшн","баттл","соревнование","игровое шоу","викторина",
      "научные видео","популярная наука","объяснялки","научные факты","мифы","разоблачение","что если","как это работает","почему","ответы",
      "бизнес-контент","разбор бизнеса","предприниматели","инвесторы","финансовая грамотность","пассивный доход","ошибки","фейлы бизнеса","рост компании","управление командой",
    ];
  }

  // --------------------
  // Boot
  // --------------------
  let state = loadState() || defaultState();

  if (localStorage.getItem('start') === '1' && !state.running) {
    state.running = true;
    if (!state.startedAt) state.startedAt = nowIso();
    localStorage.removeItem('start');

    const oldIndex = localStorage.getItem('index');
    if (oldIndex != null && !Number.isNaN(parseInt(oldIndex, 10))) state.wordIndex = parseInt(oldIndex, 10);
    localStorage.removeItem('index');

    saveState(state);
  }

  const ui = mountPanel(state);
  if (state.running) runCollector(state, ui);
})();