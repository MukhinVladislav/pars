from flask import Flask, request, jsonify
import requests
import json
import re
import threading
import logging
import os
from typing import List

app = Flask(__name__)

logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(levelname)s | %(message)s")
log = logging.getLogger("ai_server")

INLINE_GROQ_API_KEY = ""  # можешь вставить ключ сюда, если не хочешь использовать env
GROQ_API_KEY = "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"
GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions"
MODEL_MAIN = "llama-3.3-70b-versatile"

SERVER_BASE = "https://ci70535.tw1.ru"
API_KEY = ""

SYSTEM_PROMPT_CLASSIFY = """
You are a strict YouTube channel classifier for RU long-form channels.
Return STRICT JSON only:
{
  "keep": true|false,
  "reason": "ok|politics|news|kids|music_only|religion|war|adult|gambling|crypto_only|movies_series|anime_only|podcast_only|interviews_only|streams_only|shorts_only|reupload|cuts|compilations|celebs_gossip|sports_only|weapons|other",
  "confidence": 0-100
}

Reject when the channel is mostly any of these: politics, current news, military/war, kids content, nursery/rhymes/cartoons for children, music-only channels, religion/sermons, adult/18+, gambling/casino/betting, pure crypto trading calls, movie/series recaps, anime-only, podcasts/interviews only, streams/records of streams only, shorts-only, reuploads, cuts/highlights, compilations, celebrity gossip, sports-only, weapons.

Use the channel name, metrics and titles. Be strict. If there are obvious signals of these categories, set keep=false and pick the single best reason slug from the allowed list. Use keep=true only when the channel clearly does NOT belong to those buckets. Never invent reasons outside the allowed list.
""".strip()

SYSTEM_PROMPT_GEN = """
Ты генерируешь поисковые запросы для поиска русскоязычных YouTube-каналов.

Нужно вернуть СТРОГО JSON:
{
  "best_queries": ["..."],
  "fresh_queries": ["..."]
}

Требования:
- всего 15 запросов
- best_queries и fresh_queries должны быть примерно поровну
- каждый запрос 1-2 слова максимум
- только русский язык
- только разумные безопасные тематики: технологии, наука, образование, бизнес, психология, лайфстайл, рецепты, ремонт, авто, путешествия, животные, интервью, подкасты, юмор, спорт, дизайн, фотография, программирование
- best_queries должны быть похожи на уже рабочие популярные запросы
- fresh_queries должны быть новыми и разнообразными, но реалистичными
- избегай однотипных формулировок и дублей

ЖЕСТКО ЗАПРЕЩЕНО:
фильмы, сериалы, аниме, мультфильмы, детское, политика, новости, война, религия, музыка-only, клипы, концерты, ставки, казино, крипта-only, шок-контент

Никаких пояснений. Только JSON.
""".strip()

BANNED_QUERY_RE = re.compile(
    r"(?:\bnews\b|\bkids?\b|\bnursery\b|\bcartoon\b|\banime\b|\bmovie\b|\bseries\b|"
    r"полит|новост|войн|фильм|сериал|аниме|мульт|детск|для детей|религ|молитв|церк|"
    r"музык|песн|клип|концерт|ставк|казино|бетт|крипт|трейдинг|шок)"
    , re.I
)

SAFE_SEED_BEST = [
    "юмор", "наука", "бизнес", "психология", "авто", "ремонт", "технологии", "рецепты"
]
SAFE_SEED_FRESH = [
    "дизайн", "фотография", "путешествия", "интервью", "подкасты", "животные", "программирование"
]

def call_groq(model: str, system: str, user: str, temp: float) -> str:
    if not GROQ_API_KEY:
        log.error("Groq API key is missing")
        return ""

    headers = {
        "Authorization": f"Bearer {GROQ_API_KEY}",
        "Content-Type": "application/json"
    }
    payload = {
        "model": model,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "temperature": temp,
        "response_format": {"type": "json_object"}
    }
    try:
        r = requests.post(GROQ_CHAT_URL, headers=headers, json=payload, timeout=60)
        if r.status_code == 401:
            log.error("Groq API 401 Unauthorized: invalid/revoked API key")
            return ""
        r.raise_for_status()
        res_json = r.json()
        content = res_json["choices"][0]["message"]["content"]
        log.info(f"Groq Response received ({len(content)} chars)")
        return content
    except Exception as e:
        log.error(f"Groq API error: {e}")
        return ""

def _parse_json(text: str) -> dict:
    if not text:
        return {}
    try:
        return json.loads(text)
    except Exception:
        m = re.search(r"\{.*\}", text, re.S)
        if m:
            try:
                return json.loads(m.group(0))
            except Exception:
                return {}
    return {}

def _normalize_query(q: str) -> str:
    q = str(q or "").lower().replace("ё", "е")
    q = " ".join(re.findall(r"[а-я0-9]+", q))
    q = re.sub(r"\s+", " ", q).strip()
    return q

def _is_allowed_query(q: str) -> bool:
    if not q:
        return False
    if BANNED_QUERY_RE.search(q):
        return False
    wc = len(q.split())
    if wc < 1 or wc > 2:
        return False
    if len(q) < 3:
        return False
    if not re.search(r"[а-я]", q):
        return False
    return True

def _dedupe_keep_order(items: List[str]) -> List[str]:
    out, seen = [], set()
    for x in items:
        if x not in seen:
            seen.add(x)
            out.append(x)
    return out

def _split_best_fresh(parsed: dict) -> tuple[list[str], list[str]]:
    best = parsed.get("best_queries") or []
    fresh = parsed.get("fresh_queries") or []

    if not isinstance(best, list):
        best = []
    if not isinstance(fresh, list):
        fresh = []

    best = [_normalize_query(x) for x in best if isinstance(x, str)]
    fresh = [_normalize_query(x) for x in fresh if isinstance(x, str)]

    best = [x for x in best if _is_allowed_query(x)]
    fresh = [x for x in fresh if _is_allowed_query(x)]

    best = _dedupe_keep_order(best)
    fresh = _dedupe_keep_order([x for x in fresh if x not in set(best)])
    return best, fresh

_gen_lock = threading.Lock()

@app.post("/classify")
def classify():
    data = request.get_json(silent=True) or {}
    text = data.get("text") or data.get("prompt") or ""
    raw = call_groq(MODEL_MAIN, SYSTEM_PROMPT_CLASSIFY, text, 0.0)
    j = _parse_json(raw)
    keep = bool(j.get("keep", False))
    reason = str(j.get("reason", "other") or "other").strip().lower().replace(' ', '_').replace('-', '_')
    conf = int(j.get("confidence", 0) or 0)
    return jsonify({
        "ok": True,
        "keep": keep,
        "reason": reason,
        "confidence": conf,
        "result": {"keep": keep, "reason": reason, "confidence": conf}
    })

@app.post("/run_query_learning")
def run_query_learning():
    data = request.get_json(silent=True) or {}
    target_count = int(data.get("target", 15) or 15)
    target_count = max(6, min(target_count, 30))

    if not _gen_lock.acquire(blocking=False):
        return jsonify({"ok": True, "status": "busy"})

    try:
        log.info(f"Starting generation for {target_count} queries...")

        user_msg = (
            f"Сгенерируй ровно {target_count} поисковых запросов. "
            f"Раздели их на best_queries и fresh_queries примерно пополам."
        )
        raw = call_groq(MODEL_MAIN, SYSTEM_PROMPT_GEN, user_msg, 0.35)
        parsed = _parse_json(raw)

        best, fresh = _split_best_fresh(parsed)

        need_best = (target_count + 1) // 2
        need_fresh = target_count - need_best

        for q in SAFE_SEED_BEST:
            nq = _normalize_query(q)
            if len(best) >= need_best:
                break
            if _is_allowed_query(nq) and nq not in best and nq not in fresh:
                best.append(nq)

        for q in SAFE_SEED_FRESH:
            nq = _normalize_query(q)
            if len(fresh) >= need_fresh:
                break
            if _is_allowed_query(nq) and nq not in best and nq not in fresh:
                fresh.append(nq)

        combined = []
        for q in best[:need_best]:
            combined.append({"q": q, "weight": 3})
        for q in fresh[:need_fresh]:
            combined.append({"q": q, "weight": 1})

        log.info(f"Filtered queries: {len(combined)} (best={len(best[:need_best])}, fresh={len(fresh[:need_fresh])})")

        upsert_res = {"ok": True, "inserted_queries": 0}
        if combined:
            try:
                url = f"{SERVER_BASE}/upsert_queries.php"
                if API_KEY:
                    url += "?key=" + API_KEY
                r_up = requests.post(url, json={"queries": combined}, timeout=20)
                upsert_res = r_up.json()
                log.info(f"DB Upsert: {upsert_res}")
            except Exception as e:
                log.error(f"DB Error: {e}")
                upsert_res = {"ok": False, "error": str(e)}

        return jsonify({
            "ok": True,
            "generated_queries": len(combined),
            "best_queries": [x["q"] for x in combined if x["weight"] == 3],
            "fresh_queries": [x["q"] for x in combined if x["weight"] == 1],
            "upsert_result": upsert_res
        })
    finally:
        _gen_lock.release()

if __name__ == "__main__":
    log.info("Server active on port 3333. Use /classify or /run_query_learning")
    app.run(host="0.0.0.0", port=3333)
