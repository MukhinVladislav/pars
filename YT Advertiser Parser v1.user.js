// ==UserScript==
// @name         YT Advertiser Parser v1
// @namespace    http://tampermonkey.net/
// @version      2026-04-02
// @description  Парсер рекламодателей с UI-панелью (очередь видео, история, счетчики).
// @match        https://www.youtube.com/*
// @grant        GM.xmlHttpRequest
// ==/UserScript==

(function () {
  'use strict';

  const CFG = {
    stateKey: 'yt_advertiser_parser_v1_state',
    apiKey: '',
    nextEndpoint: 'https://ci70535.tw1.ru/get_next_video.php',
    saveEndpoint: 'https://ci70535.tw1.ru/save_advertisers.php',
    channelProbeLimit: 10,
    idleSleepMs: 15000,
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const nowIso = () => new Date().toISOString();

  function defaultState() {
    return {
      running: false,
      startedAt: null,
      lastActionAt: null,
      currentVideo: '',
      stats: { processed: 0, found: 0, sent: 0, errors: 0, emptyQueue: 0 },
      history: [],
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

  function addHistory(state, line) {
    state.history.unshift(`[${new Date().toLocaleTimeString()}] ${line}`);
    if (state.history.length > 50) state.history.length = 50;
    saveState(state);
  }

  function gmJson(url, method = 'GET', body = null) {
    return new Promise((resolve) => {
      GM.xmlHttpRequest({
        method,
        url,
        data: body ? JSON.stringify(body) : null,
        headers: { 'Content-Type': 'application/json' },
        onload: (r) => {
          try { resolve(JSON.parse(r.responseText)); } catch { resolve({ ok: false }); }
        },
        onerror: () => resolve({ ok: false }),
      });
    });
  }

  async function fetchHtml(url) {
    const resp = await fetch(url, { credentials: 'include' });
    return await resp.text();
  }

  function parseDateToTs(html) {
    const m = html.match(/"dateText"\s*:\s*\{[^}]*"simpleText"\s*:\s*"([^"]+)"/);
    if (!m) return null;
    const d = Date.parse(m[1].replace(/г\./g, '').trim());
    return Number.isFinite(d) ? Math.floor(d / 1000) : null;
  }

  function extractAdvertisers(text) {
    const cleaned = String(text || '').replace(/\\n/g, ' ');
    const re = /\b(ООО|ИП|АО)\s+«?"?([А-Яа-яA-Za-z0-9\-\s\.]{2,120})"?/gi;
    const uniq = new Map();
    let m;
    while ((m = re.exec(cleaned))) {
      const type = m[1].toUpperCase();
      const name = `${type} ${m[2].trim().replace(/\s+/g, ' ')}`;
      if (!uniq.has(name)) uniq.set(name, { company_type: type, company_name: name });
    }
    return [...uniq.values()];
  }

  function extractDescription(html) {
    const m = html.match(/"shortDescription":"([\s\S]*?)"[,}]/);
    return m ? m[1].replace(/\\"/g, '"') : '';
  }

  function extractChannelVideos(html, limit = 10) {
    const ids = [...String(html).matchAll(/"videoId":"([a-zA-Z0-9_-]{11})"/g)].map((x) => x[1]);
    return [...new Set(ids)].slice(0, limit).map((id) => `https://www.youtube.com/watch?v=${id}`);
  }

  async function parseOneVideo(url) {
    const html = await fetchHtml(url);
    return {
      adv: extractAdvertisers(extractDescription(html)),
      dateTs: parseDateToTs(html),
      channelUrl: (() => {
        const rel = (html.match(/"canonicalBaseUrl":"([^"]+)"/) || [])[1] || '';
        return rel ? `https://www.youtube.com${rel}/videos` : '';
      })(),
    };
  }

  function mountPanel(state) {
    const id = 'yt_advertiser_parser_v1_panel';
    document.getElementById(id)?.remove();

    const panel = document.createElement('div');
    panel.id = id;
    panel.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:999999;background:#111827;color:#e5e7eb;border:1px solid #374151;border-radius:14px;padding:12px;width:380px;font:12px/1.4 Inter,Arial,sans-serif;box-shadow:0 12px 30px rgba(0,0,0,.35);';

    const btn = document.createElement('button');
    btn.style.cssText = 'width:100%;padding:8px 10px;border:0;border-radius:10px;background:#22c55e;color:#052e16;font-weight:700;cursor:pointer;margin-bottom:8px;';
    btn.textContent = state.running ? 'Стоп' : 'Старт';

    const clearBtn = document.createElement('button');
    clearBtn.style.cssText = 'width:100%;padding:7px 10px;border:1px solid #374151;border-radius:10px;background:#0b1220;color:#cbd5e1;cursor:pointer;margin-bottom:8px;';
    clearBtn.textContent = 'Очистить историю';

    const meta = document.createElement('div');
    const hist = document.createElement('pre');
    hist.style.cssText = 'margin:8px 0 0;max-height:170px;overflow:auto;white-space:pre-wrap;background:#020617;border:1px solid #1e293b;border-radius:8px;padding:8px;';

    const render = () => {
      const s = state.stats;
      meta.innerHTML = [
        `<div><b>Текущее видео:</b> ${state.currentVideo ? state.currentVideo.slice(0, 70) : '—'}</div>`,
        `<div><b>Processed:</b> ${s.processed} | <b>Found:</b> ${s.found} | <b>Sent:</b> ${s.sent}</div>`,
        `<div><b>Empty queue:</b> ${s.emptyQueue} | <b>Errors:</b> ${s.errors}</div>`
      ].join('');
      hist.textContent = state.history.join('\n');
    };

    btn.onclick = () => {
      state.running = !state.running;
      state.lastActionAt = nowIso();
      if (state.running && !state.startedAt) state.startedAt = nowIso();
      btn.textContent = state.running ? 'Стоп' : 'Старт';
      addHistory(state, state.running ? 'Запуск парсера' : 'Остановка');
      render();
      if (state.running) loop(state, { render, btn });
      saveState(state);
    };

    clearBtn.onclick = () => {
      state.history = [];
      addHistory(state, 'История очищена');
      render();
    };

    panel.appendChild(btn);
    panel.appendChild(clearBtn);
    panel.appendChild(meta);
    panel.appendChild(hist);
    document.body.appendChild(panel);
    render();

    return { render, btn };
  }

  async function loop(state, ui) {
    while (state.running) {
      try {
        const nextUrl = CFG.nextEndpoint + (CFG.apiKey ? `?key=${encodeURIComponent(CFG.apiKey)}` : '');
        const next = await gmJson(nextUrl, 'GET');

        if (!next?.ok || !next.video) {
          state.stats.emptyQueue++;
          addHistory(state, 'Очередь пустая, жду...');
          saveState(state);
          ui.render();
          await sleep(CFG.idleSleepMs);
          continue;
        }

        const baseVideo = next.video;
        state.currentVideo = baseVideo.video_url || '';
        state.stats.processed++;

        const parsed = await parseOneVideo(baseVideo.video_url);
        let found = parsed.adv;
        let videoDate = parsed.dateTs;

        if (found.length && parsed.channelUrl) {
          const channelHtml = await fetchHtml(parsed.channelUrl);
          const recent = extractChannelVideos(channelHtml, CFG.channelProbeLimit);
          for (const u of recent) {
            const extra = await parseOneVideo(u);
            found = found.concat(extra.adv);
            if (!videoDate && extra.dateTs) videoDate = extra.dateTs;
            await sleep(350);
          }
        }

        const dedup = [...new Map(found.map((x) => [x.company_name, x])).values()];
        state.stats.found += dedup.length;

        const saveUrl = CFG.saveEndpoint + (CFG.apiKey ? `?key=${encodeURIComponent(CFG.apiKey)}` : '');
        const res = await gmJson(saveUrl, 'POST', {
          video_db_id: baseVideo.id,
          video_url: baseVideo.video_url,
          video_date: videoDate,
          advertisers: dedup,
        });

        if (res?.ok) {
          state.stats.sent += dedup.length;
          addHistory(state, `OK: ${dedup.length} рекламодателей | ${baseVideo.video_url}`);
        } else {
          state.stats.errors++;
          addHistory(state, `ERR save: ${baseVideo.video_url}`);
        }

        saveState(state);
        ui.render();
        await sleep(1000);
      } catch (e) {
        state.stats.errors++;
        addHistory(state, `EX: ${String(e?.message || e)}`);
        saveState(state);
        ui.render();
        await sleep(1500);
      }
    }
    ui.btn.textContent = 'Старт';
    ui.render();
  }

  const state = loadState();
  const ui = mountPanel(state);
  if (state.running) loop(state, ui);
})();
