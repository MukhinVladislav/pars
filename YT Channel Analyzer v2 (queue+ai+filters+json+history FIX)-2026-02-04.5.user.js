// ==UserScript==
// @name         YT Channel Analyzer v2 (queue+ai+filters+json+history FIX)
// @namespace    http://tampermonkey.net/
// @version      2026-02-04.5
// @description  Pull channel from server, analyze /videos, send metrics. Fixed white screen hangs and timeouts.
// @author       You
// @match        https://www.youtube.com/*
// @exclude      https://www.youtube.com/results?search_query=*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=youtube.com
// @grant        GM.xmlHttpRequest
// ==/UserScript==

(function () {
  'use strict';

  // --------------------
  // Config
  // --------------------
  const CFG = {
    stateKey: 'yt_analyzer_v2_state',

    getEndpoint: 'https://ci70535.tw1.ru/get_random_video.php',
    setEndpoint: 'https://ci70535.tw1.ru/set_data.php',

    apiKey: '',

    maxVideosToAnalyze: 60,
    maxScrollRounds: 10,
    scrollPauseMinMs: 650,
    scrollPauseMaxMs: 1400,

    activityDays: 30,

    titlesSampleLimit: 60,
    titlesSampleMaxChars: 18000,

    // LOCAL filters
    maxLastUploadDays: 45,
    maxUploads30d: 30,
    maxShortsPercent: 70,
    autoSkipLangEn: true,

    // Safety (Снижено с 240с до 40с для быстрого выхода из зависания)
    hardReloadHomeAfterMs: 40_000,

    // History limits
    historyMax: 120,

    uiVersion: '2026-02-04.5',
  };

  // --------------------
  // Utils
  // --------------------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const randInt = (a, b) => Math.floor(a + Math.random() * (b - a + 1));
  const nowIso = () => new Date().toISOString();
  const nowHms = () => nowIso().slice(11, 19);

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
      startedAt: null,
      lastActionAt: null,
      currentChannel: null,
      stats: { ok: 0, err: 0, skipped: 0 },
      workerId: null,
      history: [],
    };
  }

  function ensureHistory(state) {
    if (!Array.isArray(state.history)) state.history = [];
    return state;
  }

  function addHistory(state, entry) {
    try {
      ensureHistory(state);
      state.uiHideHistory = false;
      state.history.unshift(entry);
      if (state.history.length > CFG.historyMax) state.history.length = CFG.historyMax;
      saveState(state);
    } catch (e) {}
  }

  function safeJsonParse(text) {
    try { return JSON.parse(text); } catch { return null; }
  }

  function gmPost(url, dataObj) {
    return new Promise((resolve) => {
      const form = {
        key: CFG.apiKey,
        temp: JSON.stringify(dataObj),
      };

      const data = Object.keys(form)
        .filter((k) => form[k] !== undefined && form[k] !== null && String(form[k]) !== '')
        .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(String(form[k])))
        .join('&');

      GM.xmlHttpRequest({
        method: 'POST',
        url,
        data,
        timeout: 15000, // <--- ДОБАВЛЕН ТАЙМАУТ (15 сек), чтобы не ждать вечно
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        onload: (resp) => resolve({ ok: true, status: resp.status, text: resp.responseText }),
        onerror: (err) => resolve({ ok: false, err }),
        ontimeout: () => resolve({ ok: false, timeout: true }),
      });
    });
  }

  // --------------------
  // Parsing helpers
  // --------------------
  function parseNumberAny(text) {
    if (!text) return null;
    const t0 = String(text).toLowerCase().replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

    let m = t0.match(/(\d+(?:[.,]\d+)?)\s*(тыс\.?|k|млн\.?|m)(?=\s|$)/i);
    if (m) {
      const num = parseFloat(m[1].replace(',', '.'));
      if (!isFinite(num)) return null;
      const unit = m[2].toLowerCase();
      if (unit.startsWith('тыс') || unit === 'k') return Math.round(num * 1_000);
      if (unit.startsWith('млн') || unit === 'm') return Math.round(num * 1_000_000);
    }

    m = t0.match(/(\d[\d\s]{2,})/);
    if (m) {
      const num = parseInt(m[1].replace(/\s+/g, ''), 10);
      return isFinite(num) ? num : null;
    }

    m = t0.match(/\d+/);
    if (m) {
      const num = parseInt(m[0], 10);
      return isFinite(num) ? num : null;
    }
    return null;
  }

  function parseDurationSeconds(text) {
    if (!text) return null;
    const t = String(text).trim();
    const parts = t.split(':').map((x) => x.trim());
    if (parts.length < 2 || parts.length > 3) return null;
    const nums = parts.map((p) => parseInt(p, 10));
    if (nums.some((n) => !isFinite(n))) return null;
    if (nums.length === 2) return nums[0] * 60 + nums[1];
    return nums[0] * 3600 + nums[1] * 60 + nums[2];
  }

  function median(arr) {
    const a = arr.filter((x) => typeof x === 'number' && isFinite(x)).slice().sort((x, y) => x - y);
    if (!a.length) return null;
    const mid = Math.floor(a.length / 2);
    return a.length % 2 ? a[mid] : Math.round((a[mid - 1] + a[mid]) / 2);
  }

  function percent(n, d) {
    if (!d) return 0;
    return Math.round((n / d) * 100);
  }

  function channelUrlNormalize(url) {
    try {
      const u = new URL(url, location.origin);
      return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
    } catch {
      return url;
    }
  }

  function looksRussian(s) {
    return /[а-яё]/i.test(String(s || ''));
  }

  function parseRelativeDateToDays(text) {
    if (!text) return null;
    const t = String(text).toLowerCase().replace(/\u00a0/g, ' ').trim();

    let m = t.match(/(\d+)\s*(minute|hour|day|week|month|year)s?\s*ago/);
    if (m) {
      const n = parseInt(m[1], 10);
      const unit = m[2];
      if (unit === 'minute' || unit === 'hour') return 0;
      if (unit === 'day') return n;
      if (unit === 'week') return n * 7;
      if (unit === 'month') return n * 30;
      if (unit === 'year') return n * 365;
    }

    m = t.match(/(\d+)\s*(минута|минуты|минут|мин\.|час|часа|часов|день|дня|дней|дн\.|неделя|недели|недель|неделю|нед\.|месяц|месяца|месяцев|мес\.|год|года|лет)\s*назад/);
    if (m) {
      const n = parseInt(m[1], 10);
      const unit = m[2];
      if (unit.startsWith('мин') || unit.startsWith('час')) return 0;
      if (unit.startsWith('д')) return n;
      if (unit.startsWith('нед')) return n * 7;
      if (unit.startsWith('меся') || unit.startsWith('мес')) return n * 30;
      if (unit.startsWith('г') || unit.startsWith('лет')) return n * 365;
    }

    return null;
  }

  // --------------------
  // Lang/topic helpers
  // --------------------
  function cyrillicShare(text) {
    const s = String(text || '');
    const letters = s.replace(/[^A-Za-zА-Яа-яЁё]/g, '');
    if (!letters) return 0;
    const cyr = (letters.match(/[А-Яа-яЁё]/g) || []).length;
    return cyr / letters.length;
  }

  function detectLangFromTitles(titles) {
    if (!titles.length) return { lang: '', confidence: 0, ruPercent: 0, enPercent: 0 };
    const shares = titles.map(cyrillicShare);
    const avg = shares.reduce((a, b) => a + b, 0) / shares.length; // 0..1
    const ru = Math.round(avg * 100);
    const en = Math.max(0, 100 - ru);

    const conf = Math.abs(ru - 50) * 2; // 0..100
    if (ru >= 70) return { lang: 'ru', confidence: Math.round(conf), ruPercent: ru, enPercent: en };
    if (ru <= 20) return { lang: 'en', confidence: Math.round(conf), ruPercent: ru, enPercent: en };
    return { lang: 'mix', confidence: Math.round(conf), ruPercent: ru, enPercent: en };
  }

  function detectTopicFromTitles(titles) {
    const dict = [
      { topic: 'business',  w: ['бизнес','маркет','продаж','инвест','финанс','деньги','стартап','предприним'] },
      { topic: 'science',   w: ['наука','физик','хим','биолог','космос','астрон','матем','нейро','исслед'] },
      { topic: 'humor',     w: ['стендап','юмор','шутк','комед','парод','скетч'] },
      { topic: 'gaming',    w: ['игр','гейм','летспле','стрим','прохожд','ps5','xbox','steam','minecraft','cs'] },
      { topic: 'lifestyle', w: ['влог','рутина','жизн','путеше','еда','уют','дом','спорт','фитнес','здоров'] },
      { topic: 'tech',      w: ['техн','гаджет','смартфон','обзор','прилож','софт','ai','нейросет'] },
    ];
    const t = titles.join(' ').toLowerCase();
    let best = { topic: 'other', score: 0 };
    for (const d of dict) {
      let s = 0;
      for (const k of d.w) if (t.includes(k)) s++;
      if (s > best.score) best = { topic: d.topic, score: s };
    }
    return best.topic;
  }

  // --------------------
  // Score v2
  // --------------------
  function computeScoreV2(metrics) {
    const subs = metrics.subs || 0;
    const med = metrics.medianViews || 0;
    const avg = metrics.avgViews || 0;
    const maxV = metrics.maxViews || 0;

    const medianVsSubs = subs > 0 ? Math.min(2.0, med / subs) : 0;
    const effScore = Math.round(50 * medianVsSubs);

    const activityScore = Math.min(100, metrics.uploads30d * 8);
    const longFormScore = metrics.percentLonger5m;
    const lowShortsScore = Math.max(0, 100 - metrics.percentShorts);

    const ratio = med > 0 ? (avg / med) : 0;
    const stabilityScore = ratio > 0 ? Math.max(0, Math.min(100, Math.round(100 - Math.abs(1 - ratio) * 120))) : 0;

    const oneHit = (med > 0) ? (maxV / med) : 0;
    const oneHitPenalty = oneHit >= 10 ? 40 : oneHit >= 6 ? 25 : oneHit >= 3 ? 10 : 0;

    const deadPenalty = (metrics.lastUploadDays >= 180 && metrics.uploads30d === 0) ? 35 : 0;

    const score = Math.max(0, Math.min(100,
      Math.round(
        0.28 * effScore +
        0.20 * activityScore +
        0.14 * longFormScore +
        0.12 * lowShortsScore +
        0.18 * stabilityScore
      ) - oneHitPenalty - deadPenalty
    ));

    return {
      score,
      parts: { effScore, activityScore, longFormScore, lowShortsScore, stabilityScore, oneHit, oneHitPenalty, deadPenalty }
    };
  }

  // --------------------
  // Unified result logger (persistent history)
  // --------------------
  function logResult(state, ui, { result, reason, payload = {}, server = null }) {
    const entry = {
      time: nowHms(),
      url: state.currentChannel || payload.chanel || '',
      name: payload.name || '',
      result,
      reason: reason || '',
      server_reason: server && (server.reason || server.error || '') ? String(server.reason || server.error) : '',
      lang: payload.lang || '',
      uploads30d: payload.uploads_30d ?? payload.uploads30d ?? null,
      shorts: payload.shorts_ratio ?? payload.percent_shorts ?? payload.shorts ?? null,
      score: payload.score ?? null,
    };

    addHistory(state, entry);

    if (result === 'OK') state.stats.ok++;
    else if (result === 'ERROR') state.stats.err++;
    else state.stats.skipped++;

    saveState(state);

    ui.pushLog(`${result}: ${reason || entry.server_reason || '-'}`);
    ui.writeMeta();
    ui.renderHistory();
  }

  // --------------------
  // UI
  // --------------------
  function mountPanel(state) {
    const panelId = 'yt_analyzer_v2_panel';
    let panel = document.getElementById(panelId);
    if (panel) panel.remove();

    panel = document.createElement('div');
    panel.id = panelId;
    panel.style.cssText = [
      'position:fixed','right:16px','top:16px','z-index:999999',
      'background:rgba(20,20,20,0.92)','color:#fff',
      'padding:12px 12px 10px','border-radius:12px','width:380px',
      'font:12px/1.35 system-ui,-apple-system,Segoe UI,Roboto,Arial',
      'box-shadow:0 10px 30px rgba(0,0,0,0.35)',
    ].join(';');

    const btn = document.createElement('button');
    btn.textContent = state.running ? 'Стоп' : 'Старт';
    btn.style.cssText = [
      'width:100%','padding:10px 12px','border-radius:10px',
      'border:0','cursor:pointer','font-weight:800','margin-bottom:10px',
    ].join(';');

    const actionsRow = document.createElement('div');
    actionsRow.style.cssText = 'display:flex; gap:8px; margin-bottom:10px;';

    const resetBtn = document.createElement('button');
    resetBtn.textContent = 'Обнуление';
    resetBtn.style.cssText = [
      'flex:1','padding:8px 10px','border-radius:10px',
      'border:0','cursor:pointer','font-weight:800','opacity:0.95',
    ].join(';');

    const clearHistBtn = document.createElement('button');
    clearHistBtn.textContent = 'Сброс истории';
    clearHistBtn.style.cssText = [
      'flex:1','padding:8px 10px','border-radius:10px',
      'border:0','cursor:pointer','font-weight:800','opacity:0.95',
    ].join(';');

    actionsRow.appendChild(resetBtn);
    actionsRow.appendChild(clearHistBtn);

    const meta = document.createElement('div');

    const log = document.createElement('div');
    log.style.cssText = 'margin-top:8px; max-height:130px; overflow:auto; opacity:0.9;';

    const histBox = document.createElement('div');
    histBox.style.cssText =
      'margin-top:10px; max-height:220px; overflow:auto;' +
      'background:rgba(255,255,255,0.06); border-radius:10px; padding:8px;';

    panel.appendChild(btn);
    panel.appendChild(actionsRow);
    panel.appendChild(meta);
    panel.appendChild(log);
    panel.appendChild(histBox);
    document.body.appendChild(panel);

    const pushLog = (line) => {
      const el = document.createElement('div');
      el.textContent = `[${nowHms()}] ${line}`;
      log.prepend(el);
      while (log.childNodes.length > 30) log.removeChild(log.lastChild);
    };

    const renderHistory = () => {
      while (histBox.firstChild) histBox.removeChild(histBox.firstChild);

      const h = Array.isArray(state.history) ? state.history : [];

      if (state.uiHideHistory) {
        const e = document.createElement('div');
        e.style.cssText = 'opacity:.75';
        e.textContent = 'История: скрыта (нажми Старт — новые появятся)';
        histBox.appendChild(e);
        return;
      }

      if (!h.length) {
        const e = document.createElement('div');
        e.style.cssText = 'opacity:.75';
        e.textContent = 'История: пусто';
        histBox.appendChild(e);
        return;
      }

      for (const it of h) {
        const row = document.createElement('div');
        row.style.cssText = 'padding:6px 0; border-bottom:1px solid rgba(255,255,255,0.08);';

        const top = document.createElement('div');
        top.style.cssText = 'display:flex; justify-content:space-between; gap:10px;';

        const left = document.createElement('div');
        left.style.cssText = 'max-width:260px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
        left.textContent = it.name ? it.name : (it.url || '');

        const right = document.createElement('div');
        right.style.cssText = 'font-weight:900;';
        right.textContent = it.result || '';

        top.appendChild(left);
        top.appendChild(right);

        const bot = document.createElement('div');
        bot.style.cssText = 'opacity:.85; font-size:11px;';
        bot.textContent =
          `${it.time || ''} | reason=${it.reason || '-'}${it.server_reason ? ' | srv=' + it.server_reason : ''}` +
          ` | score=${it.score ?? '-'}` +
          ` | lang=${it.lang || '-'}` +
          ` | up30=${it.uploads30d ?? '-'}` +
          ` | shorts%=${it.shorts ?? '-'}`;

        row.appendChild(top);
        row.appendChild(bot);
        histBox.appendChild(row);
      }
    };

    const writeMeta = () => {
      while (meta.firstChild) meta.removeChild(meta.firstChild);

      const row = document.createElement('div');
      row.style.cssText = 'display:flex; gap:10px; flex-wrap:wrap;';

      const mk = (label, value) => {
        const d = document.createElement('div');
        const b = document.createElement('b');
        b.textContent = label;
        d.appendChild(b);
        d.appendChild(document.createTextNode(' ' + String(value)));
        return d;
      };

      row.appendChild(mk('OK:', state.stats.ok));
      row.appendChild(mk('ERR:', state.stats.err));
      row.appendChild(mk('SKIP:', state.stats.skipped));
      row.appendChild(mk('ver:', CFG.uiVersion));

      const cur = document.createElement('div');
      cur.style.cssText = 'margin-top:6px; opacity:.9;';
      const curB = document.createElement('b');
      curB.textContent = 'Текущий:';
      cur.appendChild(curB);
      cur.appendChild(document.createTextNode(' ' + (state.currentChannel ? String(state.currentChannel).slice(0, 70) : '—')));

      const wid = document.createElement('div');
      wid.style.cssText = 'margin-top:6px; opacity:.75;';
      wid.textContent = 'worker_id: ' + String(state.workerId || '—');

      meta.appendChild(row);
      meta.appendChild(cur);
      meta.appendChild(wid);

      renderHistory();
    };

    btn.onclick = () => {
      state.running = !state.running;
      state.lastActionAt = nowIso();
      if (state.running && !state.startedAt) state.startedAt = nowIso();
      saveState(state);
      btn.textContent = state.running ? 'Стоп' : 'Старт';
      pushLog(state.running ? 'Запуск анализа' : 'Остановка');
      writeMeta();
      if (state.running) loop(state, { pushLog, writeMeta, renderHistory });
    };

    resetBtn.onclick = () => {
      state.stats = { ok: 0, err: 0, skipped: 0 };
      state.currentChannel = null;
      state.startedAt = state.running ? nowIso() : null;
      state.lastActionAt = nowIso();
      saveState(state);
      pushLog('Обнуление: счетчики сброшены');
      writeMeta();
    };

    clearHistBtn.onclick = () => {
      state.uiHideHistory = true;
      state.lastActionAt = nowIso();
      saveState(state);
      pushLog('Сброс истории: история очищена');
      renderHistory();
      writeMeta();
    };

    writeMeta();
    return { pushLog, writeMeta, renderHistory };
  }

  // --------------------
  // Channel header parsing
  // --------------------
  function getChannelHeader() {
    const name =
      document.querySelector('#page-header h1 span')?.textContent?.trim() ||
      document.querySelector('ytd-channel-name #text')?.textContent?.trim() ||
      '';

    let subsText = '';
    const candidates = document.querySelectorAll('#page-header yt-content-metadata-view-model span, #page-header span');
    for (const el of candidates) {
      const tx = (el.textContent || '').trim();
      if (!tx) continue;
      if (/подписчик|subscribers?/i.test(tx) || /\bsubs\b/i.test(tx)) { subsText = tx; break; }
    }
    subsText = subsText || document.querySelector('#subscriber-count')?.textContent?.trim() || '';
    const subs = parseNumberAny(subsText) || 0;

    let totalViewsText = '';
    for (const el of candidates) {
      const tx = (el.textContent || '').trim();
      if (/просмотр|views?/i.test(tx)) { totalViewsText = tx; break; }
    }
    const totalViews = parseNumberAny(totalViewsText) || 0;

    return { name, subs, totalViews };
  }

  // --------------------
  // Videos parsing
  // --------------------
  function pickVideoCards() {
    const nodes = document.querySelectorAll('ytd-rich-item-renderer, ytd-grid-video-renderer');
    return Array.from(nodes);
  }

  function getVideoData(card) {
    const title = card.querySelector('#video-title')?.textContent?.trim() || '';

    let durText =
      card.querySelector('#time-status #text')?.textContent?.trim() ||
      card.querySelector('ytd-thumbnail-overlay-time-status-renderer #text')?.textContent?.trim() ||
      '';
    durText = durText.replace(/\s+/g, ' ').trim();
    const durationSec = parseDurationSeconds(durText);

    const spans = card.querySelectorAll('#metadata-line span');
    let viewsText = '';
    let ageText = '';
    for (const sp of spans) {
      const tx = (sp.textContent || '').trim();
      if (!tx) continue;
      if (!viewsText && /просмотр|views?/i.test(tx)) { viewsText = tx; continue; }
      if (!ageText && (/назад|ago/i.test(tx))) ageText = tx;
    }

    const views = parseNumberAny(viewsText) || 0;
    const daysAgo = parseRelativeDateToDays(ageText);

    const isShort =
      (durationSec !== null && durationSec <= 60) ||
      !!card.querySelector('a#thumbnail[href*="/shorts/"]') ||
      !!card.querySelector('ytd-thumbnail-overlay-time-status-renderer[overlay-style="SHORTS"]');

    return { title, durationSec: durationSec ?? null, views, daysAgo, isShort };
  }

  async function scrollForVideos(ui) {
    let lastCount = 0;
    let idle = 0;
    for (let i = 0; i < CFG.maxScrollRounds; i++) {
      const cnt = pickVideoCards().length;
      if (cnt > lastCount) {
        idle = 0;
        lastCount = cnt;
        ui.pushLog(`Видео найдено: ${cnt}`);
        if (cnt >= CFG.maxVideosToAnalyze) break;
      } else idle++;

      if (idle >= 3) break;
      window.scrollBy(0, 1400 + randInt(-200, 250));
      await sleep(randInt(CFG.scrollPauseMinMs, CFG.scrollPauseMaxMs));
    }
  }

  // --------------------
  // Main loop
  // --------------------
  async function loop(state, ui) {
    if (!state.running) return;

    const watchdogStart = Date.now();
    const watchdog = setInterval(() => {
      if (!state.running) return;
      if (Date.now() - watchdogStart > CFG.hardReloadHomeAfterMs) {
        clearInterval(watchdog);
        console.log('[YT Analyzer] Watchdog triggered, reloading page to clear SPA freeze...');
        try { window.location.href = 'https://www.youtube.com/'; } catch {}
      }
    }, 1000);

    const isVideosPage = /\/videos\b/.test(location.pathname);

    if (!isVideosPage) {
      ui.pushLog('Запрос следующего канала...');
      const res = await gmPost(CFG.getEndpoint, { ping: 1, worker_id: state.workerId });

      if (!res.ok) {
        logResult(state, ui, { result: 'ERROR', reason: 'get_endpoint_fail' });
        clearInterval(watchdog);
        await sleep(randInt(1200, 2400));
        if (state.running) loop(state, ui);
        return;
      }

      const txt = (res.text || '').trim();
      if (txt === 'error') {
        state.running = false;
        saveState(state);
        ui.pushLog('Нет каналов для работы (сервер вернул error)');
        ui.writeMeta();
        clearInterval(watchdog);
        return;
      }

      const ch = channelUrlNormalize(txt);
      state.currentChannel = ch;
      saveState(state);
      ui.writeMeta();
      ui.pushLog('Открываю /videos: ' + ch);
      clearInterval(watchdog);
      window.location.href = ch + '/videos';
      return;
    }

    ui.pushLog('Парсинг шапки канала...');
    await sleep(randInt(800, 1400));

    const header = getChannelHeader();
    ui.pushLog(`Канал: ${header.name || '(без названия)'} | subs=${header.subs || 0}`);

    ui.pushLog('Скролл для подгрузки видео...');
    await scrollForVideos(ui);

    const cards = pickVideoCards().slice(0, CFG.maxVideosToAnalyze);
    if (!cards.length) {
      logResult(state, ui, { result: 'DROP', reason: 'no_videos' });
      clearInterval(watchdog);
      await sleep(randInt(900, 1700));
      if (state.running) window.location.href = 'https://www.youtube.com/';
      return;
    }

    const vids = cards.map(getVideoData);

    const total = vids.length;
    const longer5m = vids.filter((v) => (v.durationSec ?? 0) >= 5 * 60).length;
    const rusTitles = vids.filter((v) => looksRussian(v.title)).length;
    const shortsCount = vids.filter((v) => v.isShort).length;

    const viewsArr = vids.map((v) => v.views || 0);
    const viewsSum = viewsArr.reduce((a, b) => a + b, 0);
    const avgViews = total ? Math.round(viewsSum / total) : 0;
    const medViews = median(viewsArr) || 0;
    const maxViews = viewsArr.length ? Math.max(...viewsArr) : 0;

    const daysAgoArr = vids.map((v) => v.daysAgo).filter((x) => x !== null);
    const lastUploadDays = daysAgoArr.length ? Math.min(...daysAgoArr) : null;
    const uploads30d = vids.filter((v) => (v.daysAgo !== null) && v.daysAgo <= CFG.activityDays).length;

    const avgToMedianRatio = (medViews > 0) ? Math.round((avgViews / medViews) * 1000) / 1000 : 0;
    const oneHitRatio = (medViews > 0) ? Math.round((maxViews / medViews) * 1000) / 1000 : 0;

    const titles = vids.map(v => (v.title || '').trim()).filter(Boolean);
    const langInfo = detectLangFromTitles(titles);
    const topic = detectTopicFromTitles(titles);

    let titlesSample = titles.slice(0, CFG.titlesSampleLimit).join('\n');
    if (titlesSample.length > CFG.titlesSampleMaxChars) {
      titlesSample = titlesSample.slice(0, CFG.titlesSampleMaxChars);
    }

    const shortsPct = percent(shortsCount, total);

    const metrics = {
      totalVideosParsed: total,
      percentLonger5m: percent(longer5m, total),
      percentRusTitles: percent(rusTitles, total),
      percentShorts: shortsPct,
      avgViews,
      medianViews: medViews,
      maxViews,
      uploads30d,
      lastUploadDays: (lastUploadDays === null ? -1 : lastUploadDays),
      subs: header.subs || 0,
      totalChannelViews: header.totalViews || 0,
    };

    const scoreInfo = computeScoreV2(metrics);

    const payload = {
      worker_id: state.workerId,
      chanel: state.currentChannel,
      name: header.name,
      videos: header.totalViews || 0,
      is_long: metrics.percentLonger5m,
      is_russian: metrics.percentRusTitles,
      average_views: metrics.avgViews,
      median_views: metrics.medianViews,
      max_views: metrics.maxViews,
      shorts_ratio: metrics.percentShorts,
      uploads_30d: metrics.uploads30d,
      last_upload_days: metrics.lastUploadDays,
      subs: metrics.subs,
      views_per_sub_median: (metrics.subs > 0 ? Math.round((metrics.medianViews / metrics.subs) * 1000) / 1000 : 0),
      lang: langInfo.lang,
      lang_confidence: langInfo.confidence,
      lang_ru_percent: langInfo.ruPercent,
      lang_en_percent: langInfo.enPercent,
      topic: topic,
      avg_to_median_ratio: avgToMedianRatio,
      one_hit_ratio: oneHitRatio,
      score: scoreInfo.score,
      score_parts: scoreInfo.parts,
      sample_size: metrics.totalVideosParsed,
      titles_sample: titlesSample,
      parsed_at: nowIso(),
    };

    // --------------------
    // LOCAL FILTERS
    // --------------------
    if (CFG.autoSkipLangEn && langInfo.lang === 'en') {
      logResult(state, ui, { result: 'DROP', reason: 'lang_en', payload });
      clearInterval(watchdog);
      await sleep(randInt(900, 1500));
      if (state.running) window.location.href = 'https://www.youtube.com/';
      return;
    }

    if (lastUploadDays === null) {
      logResult(state, ui, { result: 'DROP', reason: 'last_upload_unknown', payload });
      clearInterval(watchdog);
      await sleep(randInt(900, 1500));
      if (state.running) window.location.href = 'https://www.youtube.com/';
      return;
    }

    if (lastUploadDays > CFG.maxLastUploadDays) {
      logResult(state, ui, { result: 'DROP', reason: `last_upload_gt_${CFG.maxLastUploadDays}d`, payload });
      clearInterval(watchdog);
      await sleep(randInt(900, 1500));
      if (state.running) window.location.href = 'https://www.youtube.com/';
      return;
    }

    if (uploads30d > CFG.maxUploads30d) {
      logResult(state, ui, { result: 'DROP', reason: `uploads30d_gt_${CFG.maxUploads30d}`, payload });
      clearInterval(watchdog);
      await sleep(randInt(900, 1500));
      if (state.running) window.location.href = 'https://www.youtube.com/';
      return;
    }

    if (shortsPct >= CFG.maxShortsPercent) {
      logResult(state, ui, { result: 'DROP', reason: 'shorts_heavy', payload });
      clearInterval(watchdog);
      await sleep(randInt(900, 1500));
      if (state.running) window.location.href = 'https://www.youtube.com/';
      return;
    }

    // --------------------
    // Send to server
    // --------------------
    ui.pushLog('Отправка метрик на сервер...');
    const res2 = await gmPost(CFG.setEndpoint, payload);

    const raw2 = (res2 && typeof res2.text === 'string') ? res2.text : '';
    let j = res2.ok ? safeJsonParse(raw2) : null;
    if (!j && res2.ok) {
      const m = raw2.match(/\{[\s\S]*\}/);
      if (m) j = safeJsonParse(m[0]);
    }

    const truthy = (v) => v === true || v === 1 || v === '1' || v === 'true' || v === 'True' || v === 'ok' || v === 'OK';
    const okFlag = j ? truthy(j.ok) : (/"ok"\s*:\s*(true|1|"1"|"true")/i.test(raw2));
    const rejectedFlag = j ? truthy(j.rejected) : (/"rejected"\s*:\s*(true|1|"1"|"true")/i.test(raw2));

    if (res2.ok && okFlag) {
      if (rejectedFlag) {
        logResult(state, ui, { result: 'REJECT', reason: (j && (j.reason || j.error)) ? String(j.reason || j.error) : 'server_reject', payload, server: j || { raw: raw2.slice(0, 500) } });
      } else {
        logResult(state, ui, { result: 'OK', reason: '', payload, server: j || { raw: raw2.slice(0, 500) } });
      }
    } else {
      logResult(state, ui, { result: 'ERROR', reason: 'set_data_bad_response', payload, server: j || null });
      ui.pushLog(`set_data status=${res2 && res2.status} ok=${res2 && res2.ok} raw: ${raw2.slice(0, 160)}`);
    }

    clearInterval(watchdog);

    await sleep(randInt(900, 1800));
    if (state.running) window.location.href = 'https://www.youtube.com/';
  }

  // --------------------
  // Boot
  // --------------------
  let state = ensureHistory(loadState() || defaultState());

  if (!state.workerId) {
    state.workerId = 'w_' + Math.random().toString(16).slice(2) + '_' + Date.now();
    saveState(state);
  }

  // <--- ДОБАВЛЕНО СПАСЕНИЕ ОТ БЕЛОГО ЭКРАНА СМЕРТИ --->
  if (!document.body) {
    console.log('[YT Analyzer] Тело страницы не загрузилось. Релоад через 3 секунды...');
    setTimeout(() => window.location.reload(), 3000);
    return;
  }

  const ui = mountPanel(state);
  if (state.running) loop(state, ui);
})();