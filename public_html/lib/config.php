<?php
// -----------------------------------------------------------------------------
// Конфиг проекта
// -----------------------------------------------------------------------------
// ВАЖНО: поменяй API_KEY на свой секрет (длинная случайная строка) и добавь его
// в userscript-ы (передавай как ?key=... или POST key=...).
//
// Если оставить API_KEY пустым, эндпоинты будут работать как раньше
// (это удобно для быстрого теста, но небезопасно).

// 32+ символа.
const API_KEY = '';

// Можно переопределять через переменные окружения (на Timeweb это удобно)
// export YT_DB_DSN='mysql:dbname=...;host=localhost'
// export YT_DB_USER='...'
// export YT_DB_PASS='...'
// Значения по умолчанию (оставлены как было, чтобы ничего не сломать).
// Рекомендация: перенеси их в переменные окружения или поменяй на отдельного
// пользователя БД с минимальными правами.
const DB_DSN_DEFAULT  = 'mysql:dbname=ci70535_yt;host=localhost';
const DB_USER_DEFAULT = 'ci70535_yt';
const DB_PASS_DEFAULT = 'Q6eadvWG';

const DB_DSN  = '';
const DB_USER = '';
const DB_PASS = '';
define('AI_ENABLED', true);
define('AI_URL', 'https://porchless-volcanically-isreal.ngrok-free.dev/classify');
define('AI_GEN_URL', preg_replace('~/classify$~', '/run_query_learning', AI_URL));
define('AI_TIMEOUT_SEC', 350);

define('MAX_NEW_PER_QUERY', 50);
define('MAX_QUERY_WORDS', 2);
define('GEN_TARGET_ON_EMPTY', 40);
define('GEN_COOLDOWN_SEC', 300);
