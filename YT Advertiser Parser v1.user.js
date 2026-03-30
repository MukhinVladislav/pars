// ==UserScript==
// @name         YT Advertiser Parser v1
// @namespace    http://tampermonkey.net/
// @version      2026-03-30
// @description  Обходит видео, ищет ООО/ИП/АО в описании и сохраняет рекламодателей.
// @match        https://www.youtube.com/*
// @grant        GM.xmlHttpRequest
// ==/UserScript==

(function () {
  'use strict';

  const CFG = {
    apiKey: '',
    nextEndpoint: 'https://ci70535.tw1.ru/get_next_video.php',
    saveEndpoint: 'https://ci70535.tw1.ru/save_advertisers.php',
    channelProbeLimit: 10,
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    const text = m[1];
    const d = Date.parse(text.replace(/г\./g, '').trim());
    return Number.isFinite(d) ? Math.floor(d / 1000) : null;
  }

  function extractAdvertisers(text) {
    const cleaned = String(text || '').replace(/\\n/g, ' ');
    const re = /\b(ООО|ИП|АО)\s+«?"?([А-Яа-яA-Za-z0-9\-\s\.]{2,120})"?/gi;
    const uniq = new Map();
    let m;
    while ((m = re.exec(cleaned))) {
      const companyType = m[1].toUpperCase();
      const companyName = `${companyType} ${m[2].trim().replace(/\s+/g, ' ')}`;
      if (!uniq.has(companyName)) uniq.set(companyName, { company_type: companyType, company_name: companyName });
    }
    return Array.from(uniq.values());
  }

  function extractDescription(html) {
    const m = html.match(/"shortDescription":"([\s\S]*?)"[,}]/);
    return m ? m[1].replace(/\\"/g, '"') : '';
  }

  function extractChannelVideos(html, limit = 10) {
    const ids = [...String(html).matchAll(/"videoId":"([a-zA-Z0-9_-]{11})"/g)].map((m) => m[1]);
    const uniq = [...new Set(ids)].slice(0, limit);
    return uniq.map((id) => `https://www.youtube.com/watch?v=${id}`);
  }

  async function parseOneVideo(videoUrl) {
    const html = await fetchHtml(videoUrl);
    const description = extractDescription(html);
    const adv = extractAdvertisers(description);
    const dateTs = parseDateToTs(html);
    const channelRelative = (html.match(/"canonicalBaseUrl":"([^"]+)"/) || [])[1] || '';
    const channelUrl = channelRelative ? `https://www.youtube.com${channelRelative}/videos` : '';
    return { adv, dateTs, channelUrl };
  }

  async function processQueue() {
    while (true) {
      const nextUrl = CFG.nextEndpoint + (CFG.apiKey ? `?key=${encodeURIComponent(CFG.apiKey)}` : '');
      const next = await gmJson(nextUrl);
      if (!next?.ok || !next.video) {
        console.log('[Advertiser Parser] queue is empty');
        await sleep(15000);
        continue;
      }

      const baseVideo = next.video;
      const parsed = await parseOneVideo(baseVideo.video_url);
      let found = parsed.adv;
      let videoDate = parsed.dateTs;

      if (found.length && parsed.channelUrl) {
        const channelHtml = await fetchHtml(parsed.channelUrl);
        const recent = extractChannelVideos(channelHtml, CFG.channelProbeLimit);
        for (const u of recent) {
          const deep = await parseOneVideo(u);
          found = found.concat(deep.adv);
          if (!videoDate && deep.dateTs) videoDate = deep.dateTs;
          await sleep(400);
        }
      }

      const dedup = Array.from(new Map(found.map((x) => [x.company_name, x])).values());
      const saveUrl = CFG.saveEndpoint + (CFG.apiKey ? `?key=${encodeURIComponent(CFG.apiKey)}` : '');
      const res = await gmJson(saveUrl, 'POST', {
        video_db_id: baseVideo.id,
        video_url: baseVideo.video_url,
        video_date: videoDate,
        advertisers: dedup,
      });
      console.log('[Advertiser Parser] saved', res, baseVideo.video_url);
      await sleep(1200);
    }
  }

  setTimeout(processQueue, 1500);
})();
