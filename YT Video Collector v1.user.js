// ==UserScript==
// @name         YT Video Collector v1
// @namespace    http://tampermonkey.net/
// @version      2026-03-30
// @description  Генерит запросы, собирает видео из поиска YouTube и сохраняет в БД.
// @match        https://www.youtube.com/results?search_query=*
// @grant        GM.xmlHttpRequest
// ==/UserScript==

(function () {
  'use strict';

  const CFG = {
    apiKey: '',
    queryEndpoint: 'https://ci70535.tw1.ru/get_next_query.php',
    saveEndpoint: 'https://ci70535.tw1.ru/upsert_videos.php',
    minViews: 65000,
    maxItems: 120,
    maxScrolls: 12,
    minRuShare: 0.6,
    sp: 'CAASBAgEEAE%253D',
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function parseViews(text) {
    const t = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const m = t.match(/(\d+(?:[.,]\d+)?)\s*(тыс|млн|k|m)/i);
    if (m) {
      const v = parseFloat(m[1].replace(',', '.'));
      const u = m[2].toLowerCase();
      if (u === 'тыс' || u === 'k') return Math.round(v * 1000);
      if (u === 'млн' || u === 'm') return Math.round(v * 1000000);
    }
    const m2 = t.match(/(\d[\d\s]+)/);
    return m2 ? parseInt(m2[1].replace(/\s+/g, ''), 10) : null;
  }

  function ruShare(text) {
    const letters = String(text || '').match(/[A-Za-zА-Яа-яЁё]/g) || [];
    if (!letters.length) return 0;
    const ru = letters.filter((ch) => /[А-Яа-яЁё]/.test(ch)).length;
    return ru / letters.length;
  }

  function queryServer(url, method = 'GET', payload = null) {
    return new Promise((resolve) => {
      GM.xmlHttpRequest({
        method,
        url,
        data: payload ? JSON.stringify(payload) : null,
        headers: {
          'Content-Type': 'application/json',
          ...(CFG.apiKey ? { 'X-Api-Key': CFG.apiKey } : {}),
        },
        onload: (r) => {
          try { resolve(JSON.parse(r.responseText)); } catch { resolve({ ok: false }); }
        },
        onerror: () => resolve({ ok: false }),
      });
    });
  }

  async function getQuery() {
    const u = CFG.queryEndpoint + (CFG.apiKey ? `?key=${encodeURIComponent(CFG.apiKey)}` : '');
    const data = await queryServer(u, 'GET');
    return (data?.query || '').trim();
  }

  async function ensureQueryInUrl() {
    const current = decodeURIComponent(new URL(location.href).searchParams.get('search_query') || '');
    if (current) return current;

    const q = await getQuery();
    if (!q) return '';

    const target = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&sp=${CFG.sp}`;
    location.href = target;
    return '';
  }

  function getVideoRows() {
    return Array.from(document.querySelectorAll('ytd-video-renderer')).slice(0, CFG.maxItems);
  }

  function parseVideo(item, query) {
    const linkEl = item.querySelector('a#video-title');
    const videoUrl = linkEl?.href || '';
    if (!videoUrl.includes('/watch?v=')) return null;

    const u = new URL(videoUrl, location.origin);
    const videoId = u.searchParams.get('v') || '';
    if (!videoId) return null;

    const title = (linkEl?.textContent || '').trim();
    if (ruShare(title) < CFG.minRuShare) return null;

    const channelUrl = item.querySelector('ytd-channel-name a')?.href || '';
    const viewsText = Array.from(item.querySelectorAll('#metadata-line span')).map((x) => x.textContent || '').join(' ');
    const views = parseViews(viewsText);
    if (views === null || views < CFG.minViews) return null;

    return {
      video_id: videoId,
      video_url: `https://www.youtube.com/watch?v=${videoId}`,
      title,
      channel_url: channelUrl,
      query,
    };
  }

  async function collectAndSend() {
    const q = await ensureQueryInUrl();
    if (!q) return;

    for (let i = 0; i < CFG.maxScrolls; i++) {
      window.scrollBy(0, 1400);
      await sleep(700);
    }

    const videos = getVideoRows().map((it) => parseVideo(it, q)).filter(Boolean);
    if (!videos.length) return;

    const u = CFG.saveEndpoint + (CFG.apiKey ? `?key=${encodeURIComponent(CFG.apiKey)}` : '');
    const res = await queryServer(u, 'POST', { videos });
    console.log('[YT Video Collector] saved:', res);
  }

  setTimeout(collectAndSend, 1800);
})();
