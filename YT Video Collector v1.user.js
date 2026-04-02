// ==UserScript==
// @name         YT Video Collector v1
// @namespace    http://tampermonkey.net/
// @version      2026-04-02
// @description  Быстрый сбор видео из YouTube Search с UI-панелью, фильтрами и отправкой в БД.
// @match        https://www.youtube.com/results?search_query=*
// @grant        GM.xmlHttpRequest
// ==/UserScript==

(function () {
  'use strict';

  const CFG = {
    stateKey: 'yt_video_collector_v1_state',
    apiKey: '',
    queryEndpoint: 'https://ci70535.tw1.ru/get_next_query.php',
    saveEndpoint: 'https://ci70535.tw1.ru/upsert_videos.php',
    minViews: 65000,
    maxViews: null,
    minRuShare: 0.6,
    maxItems: 1200,
    postChunkSize: 80,
    tickMinMs: 650,
    tickMaxMs: 1350,
    scrollStepPx: 1400,
    idleRoundsToNextQuery: 5,
    sp: 'CAASBAgEEAE%253D',
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const randInt = (a, b) => Math.floor(a + Math.random() * (b - a + 1));
  const nowIso = () => new Date().toISOString();

  function defaultState() {
    return {
      v: 1,
      running: false,
      startedAt: null,
      lastActionAt: null,
      currentQuery: '',
      sentMap: {},
      idleRounds: 0,
      stats: {
        scanned: 0,
        matched: 0,
        sent: 0,
        skippedNoViews: 0,
        skippedByViews: 0,
        skippedByRu: 0,
        errors: 0,
      },
      log: [],
    };
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(CFG.stateKey);
      if (!raw) return defaultState();
      return { ...defaultState(), ...JSON.parse(raw) };
    } catch {
      return defaultState();
    }
  }

  function saveState(state) {
    localStorage.setItem(CFG.stateKey, JSON.stringify(state));
  }

  function addLog(state, msg) {
    const item = `[${new Date().toLocaleTimeString()}] ${msg}`;
    state.log.unshift(item);
    if (state.log.length > 20) state.log.length = 20;
    saveState(state);
  }

  function ruShare(text) {
    const letters = String(text || '').match(/[A-Za-zА-Яа-яЁё]/g) || [];
    if (!letters.length) return 0;
    const ru = letters.filter((ch) => /[А-Яа-яЁё]/.test(ch)).length;
    return ru / letters.length;
  }

  function parseViewsAny(text) {
    const t = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
    let m = t.match(/(\d+(?:[.,]\d+)?)\s*(тыс|млн|k|m)/i);
    if (m) {
      const num = parseFloat(m[1].replace(',', '.'));
      const unit = m[2].toLowerCase();
      if (unit === 'тыс' || unit === 'k') return Math.round(num * 1000);
      if (unit === 'млн' || unit === 'm') return Math.round(num * 1000000);
    }
    m = t.match(/(\d[\d\s]+)/);
    if (m) return parseInt(m[1].replace(/\s+/g, ''), 10);
    return null;
  }

  function gmJson(url, method = 'GET', payload = null) {
    return new Promise((resolve) => {
      GM.xmlHttpRequest({
        method,
        url,
        data: payload ? JSON.stringify(payload) : null,
        headers: { 'Content-Type': 'application/json' },
        onload: (r) => {
          try { resolve(JSON.parse(r.responseText)); } catch { resolve({ ok: false }); }
        },
        onerror: () => resolve({ ok: false }),
        timeout: 20000,
      });
    });
  }

  async function getNextQuery() {
    const u = CFG.queryEndpoint + (CFG.apiKey ? `?key=${encodeURIComponent(CFG.apiKey)}` : '');
    const res = await gmJson(u, 'GET');
    return String(res?.query || '').trim();
  }

  function currentSearchQuery() {
    return decodeURIComponent(new URL(location.href).searchParams.get('search_query') || '').trim();
  }

  function navigateToQuery(query) {
    const target = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=${CFG.sp}`;
    location.href = target;
  }

  function getItems() {
    return Array.from(document.querySelectorAll('ytd-video-renderer')).slice(0, CFG.maxItems);
  }

  function parseItem(item, state) {
    const a = item.querySelector('a#video-title');
    const href = a?.href || '';
    if (!href.includes('/watch?v=')) return null;

    const u = new URL(href, location.origin);
    const videoId = u.searchParams.get('v') || '';
    if (!videoId || state.sentMap[videoId]) return null;

    const title = (a?.textContent || '').trim();
    if (ruShare(title) < CFG.minRuShare) {
      state.stats.skippedByRu++;
      return null;
    }

    const channelUrl = item.querySelector('ytd-channel-name a')?.href || '';
    const viewsText = Array.from(item.querySelectorAll('#metadata-line span')).map((x) => x.textContent || '').join(' ');
    const views = parseViewsAny(viewsText);
    if (views === null) {
      state.stats.skippedNoViews++;
      return null;
    }
    if (views < CFG.minViews || (CFG.maxViews !== null && views > CFG.maxViews)) {
      state.stats.skippedByViews++;
      return null;
    }

    return {
      video_id: videoId,
      video_url: `https://www.youtube.com/watch?v=${videoId}`,
      title,
      channel_url: channelUrl,
      query: state.currentQuery,
    };
  }

  function mountPanel(state) {
    const id = 'yt_video_collector_v1_panel';
    document.getElementById(id)?.remove();

    const panel = document.createElement('div');
    panel.id = id;
    panel.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:999999;background:#0f172a;color:#e5e7eb;border:1px solid #334155;border-radius:14px;padding:12px;width:360px;font:12px/1.4 Inter,Arial,sans-serif;box-shadow:0 12px 30px rgba(0,0,0,.35);';

    const btn = document.createElement('button');
    btn.style.cssText = 'width:100%;padding:8px 10px;border:0;border-radius:10px;background:#22c55e;color:#06230f;font-weight:700;cursor:pointer;margin-bottom:8px;';
    btn.textContent = state.running ? 'Стоп' : 'Старт';

    const resetBtn = document.createElement('button');
    resetBtn.style.cssText = 'width:100%;padding:7px 10px;border:1px solid #334155;border-radius:10px;background:#111827;color:#cbd5e1;cursor:pointer;margin-bottom:8px;';
    resetBtn.textContent = 'Сброс статистики';

    const meta = document.createElement('div');
    const log = document.createElement('pre');
    log.style.cssText = 'margin:8px 0 0;max-height:170px;overflow:auto;white-space:pre-wrap;background:#020617;border:1px solid #1e293b;border-radius:8px;padding:8px;';

    const render = () => {
      const s = state.stats;
      meta.innerHTML = [
        `<div><b>Запрос:</b> ${state.currentQuery || '—'}</div>`,
        `<div><b>Scanned:</b> ${s.scanned} | <b>Matched:</b> ${s.matched} | <b>Sent:</b> ${s.sent}</div>`,
        `<div><b>Skip noViews:</b> ${s.skippedNoViews} | <b>Skip views:</b> ${s.skippedByViews}</div>`,
        `<div><b>Skip RU:</b> ${s.skippedByRu} | <b>Errors:</b> ${s.errors}</div>`,
        `<div style="opacity:.8"><b>Фильтры:</b> >=65k views, RU>=60%</div>`
      ].join('');
      log.textContent = state.log.join('\n');
    };

    btn.onclick = () => {
      state.running = !state.running;
      state.lastActionAt = nowIso();
      if (state.running && !state.startedAt) state.startedAt = nowIso();
      btn.textContent = state.running ? 'Стоп' : 'Старт';
      addLog(state, state.running ? 'Запуск коллектора' : 'Остановка');
      render();
      if (state.running) loop(state, { render, btn });
      saveState(state);
    };

    resetBtn.onclick = () => {
      state.stats = defaultState().stats;
      state.sentMap = {};
      state.idleRounds = 0;
      addLog(state, 'Локальная статистика сброшена');
      render();
    };

    panel.appendChild(btn);
    panel.appendChild(resetBtn);
    panel.appendChild(meta);
    panel.appendChild(log);
    document.body.appendChild(panel);
    render();
    return { render, btn };
  }

  async function ensureQuery(state) {
    const cur = currentSearchQuery();
    if (cur) {
      state.currentQuery = cur;
      return true;
    }
    const q = await getNextQuery();
    if (!q) return false;
    addLog(state, `Переход к запросу: ${q}`);
    navigateToQuery(q);
    return false;
  }

  async function sendBatch(videos, state) {
    const u = CFG.saveEndpoint + (CFG.apiKey ? `?key=${encodeURIComponent(CFG.apiKey)}` : '');
    for (let i = 0; i < videos.length; i += CFG.postChunkSize) {
      const chunk = videos.slice(i, i + CFG.postChunkSize);
      const res = await gmJson(u, 'POST', { videos: chunk });
      if (res?.ok) {
        state.stats.sent += chunk.length;
      } else {
        state.stats.errors++;
      }
      chunk.forEach((x) => { state.sentMap[x.video_id] = 1; });
      saveState(state);
    }
  }

  async function loop(state, ui) {
    while (state.running) {
      try {
        const ok = await ensureQuery(state);
        if (!ok) return;

        const items = getItems();
        state.stats.scanned = items.length;

        const found = [];
        for (const item of items) {
          const v = parseItem(item, state);
          if (v) found.push(v);
        }

        state.stats.matched += found.length;
        if (found.length > 0) {
          state.idleRounds = 0;
          await sendBatch(found, state);
          addLog(state, `Найдено ${found.length}, отправлено в БД`);
        } else {
          state.idleRounds++;
          addLog(state, `Новых видео нет (${state.idleRounds}/${CFG.idleRoundsToNextQuery})`);
        }

        if (state.idleRounds >= CFG.idleRoundsToNextQuery) {
          state.idleRounds = 0;
          const q = await getNextQuery();
          if (q) {
            addLog(state, `Следующий запрос: ${q}`);
            navigateToQuery(q);
            return;
          }
        }

        window.scrollBy(0, CFG.scrollStepPx);
        saveState(state);
        ui.render();
        await sleep(randInt(CFG.tickMinMs, CFG.tickMaxMs));
      } catch (e) {
        state.stats.errors++;
        addLog(state, `Ошибка: ${String(e?.message || e)}`);
        saveState(state);
        ui.render();
        await sleep(1200);
      }
    }
    ui.btn.textContent = 'Старт';
    ui.render();
  }

  const state = loadState();
  const ui = mountPanel(state);
  if (state.running) loop(state, ui);
})();
