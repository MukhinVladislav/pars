<?php
ini_set('display_errors', 1);
ini_set('display_startup_errors', 1);
error_reporting(E_ALL);

require_once __DIR__ . '/lib/db.php';
require_once __DIR__ . '/lib/util.php';

$struct = DB::getStructure('chanels');
$has = fn($c) => isset($struct[$c]);

function safeCount(string $sql, array $params = []): int {
  $row = DB::getRow($sql, $params);
  return (int)($row['c'] ?? 0);
}

function qbuild(array $overrides = [], array $drop = []): string {
  $q = $_GET;
  foreach ($drop as $k) unset($q[$k]);
  foreach ($overrides as $k => $v) {
    if ($v === null) unset($q[$k]);
    else $q[$k] = $v;
  }
  return http_build_query($q);
}

function num_cell($value): string {
  return number_format((int)$value, 0, '.', ' ');
}

// ---- Filters
$amount_videos = int_param('amount_videos', 0, 0, 1000000000);
$percent_bigger_5_min = int_param('percent_bigger_5_min', 0, 0, 100);
$percent_ru_videos = int_param('percent_ru_videos', 0, 0, 100);
$average_views = int_param('average_views', 0, 0, 2000000000);
$score_min = int_param('score_min', 0, 0, 1000000000);
$median_views_min = int_param('median_views_min', 0, 0, 2000000000);

$status = trim((string)($_GET['status'] ?? 'all'));
$allowed_status = ['all','new','processing','done','error','skipped'];
if (!in_array($status, $allowed_status, true)) $status = 'all';

$only_not_blacklisted = int_param('only_not_blacklisted', 1, 0, 1);

$reason_mode = trim((string)($_GET['reason_mode'] ?? 'all'));
$allowed_reason_mode = ['all', 'with_reason', 'without_reason'];
if (!in_array($reason_mode, $allowed_reason_mode, true)) $reason_mode = 'all';

$sort = trim((string)($_GET['sort'] ?? 'id_desc'));
$allowed_sort = ['id_desc','score_desc','avg_desc','median_desc','subs_desc','updated_desc'];
if (!in_array($sort, $allowed_sort, true)) $sort = 'id_desc';

$page = int_param('page', 1, 1, 1000000);
$per_page = int_param('per_page', 200, 25, 2000);
$offset = ($page - 1) * $per_page;

// ---- Counters
$count_all = safeCount("SELECT COUNT(*) AS c FROM chanels");
$count_done = ($has('status') ? safeCount("SELECT COUNT(*) AS c FROM chanels WHERE status='done'") : 0);
$count_new  = ($has('status') ? safeCount("SELECT COUNT(*) AS c FROM chanels WHERE status='new'") : 0);
$count_proc = ($has('status') ? safeCount("SELECT COUNT(*) AS c FROM chanels WHERE status='processing'") : 0);
$count_err  = ($has('status') ? safeCount("SELECT COUNT(*) AS c FROM chanels WHERE status='error'") : 0);
$count_skip = ($has('status') ? safeCount("SELECT COUNT(*) AS c FROM chanels WHERE status='skipped'") : 0);
$count_bl   = safeCount("SELECT COUNT(*) AS c FROM blacklist");

// ---- WHERE
$where = [];
$params = [];

if ($status !== 'all' && $has('status')) {
  $where[] = "c.status = ?";
  $params[] = $status;
}

if ($only_not_blacklisted === 1) {
  $where[] = "b.id IS NULL";
}

if ($has('videos')) {
  $where[] = "c.videos >= ?";
  $params[] = $amount_videos;
}
if ($has('is_long')) {
  $where[] = "c.is_long >= ?";
  $params[] = $percent_bigger_5_min;
}
if ($has('is_russian')) {
  $where[] = "c.is_russian >= ?";
  $params[] = $percent_ru_videos;
}
if ($has('average_views')) {
  $where[] = "c.average_views >= ?";
  $params[] = $average_views;
}
if ($has('score')) {
  $where[] = "c.score >= ?";
  $params[] = $score_min;
}
if ($has('median_views')) {
  $where[] = "c.median_views >= ?";
  $params[] = $median_views_min;
}

if ($reason_mode !== 'all') {
  $reasonExpr = "TRIM(COALESCE(NULLIF(b.reason, ''), NULLIF(c.status_reason, '')))";
  if ($reason_mode === 'with_reason') {
    $where[] = "$reasonExpr <> ''";
  } else {
    $where[] = "($reasonExpr = '' OR $reasonExpr IS NULL)";
  }
}

$whereSql = $where ? ('WHERE ' . implode(' AND ', $where)) : '';

// ---- ORDER
$orderSql = "ORDER BY c.id DESC";
if ($sort === 'score_desc'   && $has('score'))         $orderSql = "ORDER BY c.score DESC, c.id DESC";
if ($sort === 'avg_desc'     && $has('average_views')) $orderSql = "ORDER BY c.average_views DESC, c.id DESC";
if ($sort === 'median_desc'  && $has('median_views'))  $orderSql = "ORDER BY c.median_views DESC, c.id DESC";
if ($sort === 'subs_desc'    && $has('subs'))          $orderSql = "ORDER BY c.subs DESC, c.id DESC";
if ($sort === 'updated_desc' && $has('updated_at'))    $orderSql = "ORDER BY c.updated_at DESC, c.id DESC";

$count_filtered = safeCount(
  "SELECT COUNT(*) AS c
   FROM chanels c
   LEFT JOIN blacklist b ON b.link = c.link
   $whereSql",
  $params
);

$limit = (int)$per_page;
$off = (int)$offset;

$items = DB::getAll(
  "SELECT c.*, b.id AS bl_id, b.reason AS bl_reason
   FROM chanels c
   LEFT JOIN blacklist b ON b.link = c.link
   $whereSql
   $orderSql
   LIMIT $limit OFFSET $off",
  $params
);

$total_pages = max(1, (int)ceil(max(1, $count_filtered) / $per_page));
if ($page > $total_pages) {
  $page = $total_pages;
}
$prev = max(1, $page - 1);
$next = min($total_pages, $page + 1);

$sortLabels = [
  'id_desc' => 'ID ↓',
  'updated_desc' => 'Обновление ↓',
  'score_desc' => 'Оценка ↓',
  'avg_desc' => 'Avg views ↓',
  'median_desc' => 'Median views ↓',
  'subs_desc' => 'Подписчики ↓',
];

$advertisers = DB::getAll(
  "SELECT a.company_name, a.company_type, a.source_video_url, a.source_video_date, a.created_at, v.title AS video_title
   FROM advertisers a
   LEFT JOIN videos v ON v.id = a.video_id
   ORDER BY a.id DESC
   LIMIT 500"
);

?>
<!doctype html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>YouTube парсер — база каналов</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #f7f7f8;
      --panel: #ffffff;
      --panel-2: #fbfbfc;
      --stroke: #e5e7eb;
      --stroke-strong: #d8dbe2;
      --text: #111827;
      --muted: #6b7280;
      --blue: #2563eb;
      --blue-2: #1d4ed8;
      --green: #10a37f;
      --green-2: #0e8f6f;
      --red: #dc2626;
      --yellow: #b45309;
      --chip: #f3f4f6;
      --shadow: 0 1px 2px rgba(16,24,40,.04), 0 12px 32px rgba(15,23,42,.06);
    }
    * { box-sizing: border-box; font-family: 'Inter', system-ui, sans-serif; }
    html, body { margin: 0; background:
      radial-gradient(circle at top left, rgba(16,163,127,.05), transparent 28%),
      radial-gradient(circle at top right, rgba(37,99,235,.04), transparent 22%),
      var(--bg); color: var(--text); }
    body { padding: 22px; }
    a { color: #0000ee; text-decoration: underline; }
    a:visited { color: #551a8b; }
    a:hover { text-decoration: underline; }
    .container { max-width: 1840px; margin: 0 auto; }
    .hero { display:flex; justify-content:space-between; gap:16px; align-items:flex-start; margin-bottom:18px; background:linear-gradient(180deg, rgba(255,255,255,.95), rgba(255,255,255,.88)); border:1px solid var(--stroke); border-radius:28px; padding:22px 24px; box-shadow: var(--shadow); backdrop-filter: blur(8px); }
    .hero h1 { margin:0 0 8px; font-size: 32px; line-height:1.02; letter-spacing:-.03em; }
    .hero p { margin:0; color: var(--muted); max-width: 840px; line-height:1.5; }
    .stats { display:grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap:12px; margin: 18px 0 20px; }
    .stat {
      background: var(--panel);
      border: 1px solid var(--stroke);
      border-radius: 20px;
      padding: 14px 16px;
      box-shadow: var(--shadow);
    }
    .stat .k { color: var(--muted); font-size: 12px; margin-bottom: 6px; }
    .stat .v { font-size: 24px; font-weight: 800; }
    .panel {
      background: var(--panel);
      border: 1px solid var(--stroke);
      border-radius: 28px;
      padding: 18px;
      box-shadow: var(--shadow);
      margin-bottom: 18px;
    }
    .panel-head { display:flex; justify-content:space-between; gap:16px; align-items:center; margin-bottom:14px; }
    .panel-title { font-size: 18px; font-weight: 800; }
    .panel-sub { color: var(--muted); font-size: 13px; }
    .grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap:14px; }
    .field label { display:block; color: var(--muted); font-size: 12px; margin-bottom: 7px; }
    .field input, .field select {
      width:100%;
      border-radius: 16px;
      border:1px solid var(--stroke);
      background: var(--panel-2);
      transition: border-color .18s ease, box-shadow .18s ease, background .18s ease;
      color: var(--text);
      padding: 12px 14px;
      outline:none;
    }
    .field input:focus, .field select:focus { border-color: rgba(25,118,210,.7); box-shadow: 0 0 0 3px rgba(25,118,210,.12); }
    .small { font-size: 11px; color: var(--muted); margin-top: 5px; }
    .actions { display:flex; flex-wrap:wrap; gap:10px; align-items:center; margin-top:16px; }
    .btn {
      appearance:none; border:1px solid transparent; cursor:pointer; border-radius: 16px; padding: 12px 16px;
      font-weight:700; color:#fff; background: linear-gradient(180deg, var(--green), var(--green-2));
      box-shadow: 0 10px 24px rgba(16,163,127,.16);
      text-decoration: none;
    }
    .btn:hover { filter: brightness(1.02); text-decoration:none; }
    .btn:visited { color:#fff; }
    .btn-secondary { background: #fff; color: #111827; box-shadow:none; border-color: var(--stroke); }
    .btn-secondary:visited { color: #1f2937; }
    .btn-danger { background: linear-gradient(180deg, #ef4444, #dc2626); box-shadow: 0 10px 24px rgba(220,38,38,.14); }
    .summary { color: var(--muted); font-size: 13px; margin-left:auto; }
    .chips { display:flex; flex-wrap:wrap; gap:8px; }
    .chip { background: rgba(255,255,255,.94); border:1px solid var(--stroke); padding: 9px 13px; border-radius: 999px; font-size:12px; color: var(--muted); box-shadow: 0 1px 1px rgba(15,23,42,.02); }
    .chip b { color: var(--text); }
    .table-wrap {
      overflow:auto;
      border-radius: 28px;
      border:1px solid var(--stroke);
      background: #ffffff;
    }
    table { width:100%; border-collapse: separate; border-spacing:0; min-width: 1500px; }
    thead th {
      position: sticky; top: 0; z-index: 1;
      background: #f8fafc;
      color: #516071;
      font-size: 12px; text-transform: uppercase; letter-spacing: .05em;
      padding: 13px 12px; text-align:left; border-bottom:1px solid var(--stroke);
    }
    tbody td {
      padding: 12px;
      border-bottom:1px solid #edf1f5;
      color: var(--text);
      vertical-align: top;
      background: #fff;
    }
    tbody tr:hover td { background: #fcfcfd; }
    .mono { font-variant-numeric: tabular-nums; }
    .status-badge, .bl-badge {
      display:inline-flex; align-items:center; gap:6px; border-radius:999px; padding: 5px 10px; font-size: 11px; font-weight:700;
      border: 1px solid transparent;
    }
    .st-new { background:#fff3cd; color:#7a5a00; border-color:#f3df9e; }
    .st-proc { background:#cfe2ff; color:#083a88; border-color:#b6d2ff; }
    .st-done { background:#d1e7dd; color:#0f5132; border-color:#bdddcf; }
    .st-err { background:#f8d7da; color:#842029; border-color:#efc2c7; }
    .st-skip { background:#e2e3e5; color:#2b2f33; border-color:#d4d8dd; }
    .bl-on { background:#fde0e3; color:#9f1239; border-color:#f9c7cf; }
    .bl-off { background:#e7f7ee; color:#166534; border-color:#ccefdc; }
    .reason { max-width: 280px; color: var(--muted); font-size: 12px; line-height: 1.35; }
    td a.channel-link { display:block; color:#0000ee; }
    td a.channel-link:visited { color:#551a8b; }
    .name { font-weight:700; display:block; margin-bottom:4px; color: inherit; }
    .link-sub { color: inherit; opacity: .8; font-size:12px; word-break:break-all; }
    td a.channel-link:visited .name,
    td a.channel-link:visited .link-sub { color:#551a8b; opacity:1; }
    .btn-mini { padding: 9px 12px; border-radius: 14px; background: #fff; border:1px solid var(--stroke-strong); color:#111827; cursor:pointer; font-weight:700; transition: transform .14s ease, box-shadow .14s ease, border-color .14s ease; box-shadow: 0 2px 8px rgba(15,23,42,.04); }
    .btn-mini:hover { transform: translateY(-1px); box-shadow: 0 8px 20px rgba(15,23,42,.08); }
    .pager { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
    .pager a, .pager span {
      display:inline-flex; align-items:center; justify-content:center; min-height:40px;
      padding:0 14px; border-radius:14px; border:1px solid var(--stroke); background: #fff; color: var(--text);
      text-decoration: none;
    }
    .pager a:visited { color: var(--text); }
    .pager .current { background: linear-gradient(180deg, var(--green), var(--green-2)); border-color: transparent; color:#fff; }
    .right { text-align:right; }

    .panel.filters-panel { position: sticky; top: 16px; z-index: 3; background: linear-gradient(180deg, rgba(255,255,255,.97), rgba(255,255,255,.93)); backdrop-filter: blur(10px); }
    .table-note { color: var(--muted); font-size: 13px; }
    tr.row-fade-out { opacity: 0; transform: translateY(-6px); transition: opacity .18s ease, transform .18s ease; }
    tbody tr { transition: opacity .18s ease, transform .18s ease; }
    .toast { position: fixed; right: 18px; bottom: 18px; background: #111827; color: #fff; padding: 12px 14px; border-radius: 14px; box-shadow: 0 12px 30px rgba(0,0,0,.16); font-size: 13px; z-index: 50; opacity:0; transform: translateY(8px); transition: all .18s ease; pointer-events:none; }
    .toast.show { opacity:1; transform: translateY(0); }

    .tabs { display:flex; gap:10px; margin: 0 0 16px; }
    .tab-btn { border:1px solid var(--stroke); background:#fff; color:var(--text); border-radius:14px; padding:10px 14px; font-weight:700; cursor:pointer; }
    .tab-btn.active { background: linear-gradient(180deg, var(--blue), var(--blue-2)); color:#fff; border-color: transparent; }
    .tab-pane { display:none; }
    .tab-pane.active { display:block; }

    @media (max-width: 900px) {
      body { padding: 14px; }
      .hero { flex-direction:column; }
      .summary { width:100%; margin-left:0; }
    }
  </style>
</head>
<body>
<div class="container">
  <div class="hero">
    <div>
      <h1>База каналов</h1>
      <p>Нормальный дашборд вместо голой таблицы: быстрые фильтры, стабильная сортировка и удобный blacklist workflow.</p>
    </div>
    <div class="chips">
      <div class="chip">По фильтру: <b><?= h((string)$count_filtered) ?></b></div>
      <div class="chip">Показано: <b><?= h((string)count($items)) ?></b></div>
      <div class="chip">Страница <b><?= h((string)$page) ?></b> / <b><?= h((string)$total_pages) ?></b></div>
      <div class="chip">Сортировка: <b><?= h($sortLabels[$sort] ?? $sort) ?></b></div>
    </div>
  </div>

  <div class="stats">
    <div class="stat"><div class="k">Всего</div><div class="v"><?= h(num_cell($count_all)) ?></div></div>
    <div class="stat"><div class="k">Done</div><div class="v"><?= h(num_cell($count_done)) ?></div></div>
    <div class="stat"><div class="k">New</div><div class="v"><?= h(num_cell($count_new)) ?></div></div>
    <div class="stat"><div class="k">Processing</div><div class="v"><?= h(num_cell($count_proc)) ?></div></div>
    <div class="stat"><div class="k">Skipped</div><div class="v"><?= h(num_cell($count_skip)) ?></div></div>
    <div class="stat"><div class="k">Error</div><div class="v"><?= h(num_cell($count_err)) ?></div></div>
    <div class="stat"><div class="k">Blacklisted</div><div class="v"><?= h(num_cell($count_bl)) ?></div></div>
  </div>
  <div class="tabs">
    <button class="tab-btn active" type="button" data-tab="channels">Каналы</button>
    <button class="tab-btn" type="button" data-tab="advertisers">Рекламодатели</button>
  </div>

  <section class="tab-pane active" data-pane="channels">


  <form id="filtersForm" class="panel filters-panel" action="view.php" method="GET">
    <div class="panel-head">
      <div>
        <div class="panel-title">Фильтры сверху</div>
        <div class="panel-sub">Добавил фильтр по оценке, по median views и режим для каналов с reason / без reason.</div>
      </div>
    </div>

    <div class="grid">
      <div class="field">
        <label>Статус</label>
        <select name="status" <?= $has('status') ? '' : 'disabled' ?>>
          <?php foreach (['all','done','new','processing','skipped','error'] as $s): ?>
            <option value="<?= h($s) ?>"<?= $status === $s ? ' selected' : '' ?>><?= h($s) ?></option>
          <?php endforeach; ?>
        </select>
        <?php if (!$has('status')): ?><div class="small">status колонки нет</div><?php endif; ?>
      </div>

      <div class="field">
        <label>Blacklist</label>
        <select name="only_not_blacklisted">
          <option value="1"<?= $only_not_blacklisted===1 ? ' selected' : '' ?>>Скрыть BL</option>
          <option value="0"<?= $only_not_blacklisted===0 ? ' selected' : '' ?>>Показывать BL</option>
        </select>
      </div>

      <div class="field">
        <label>Reason mode</label>
        <select name="reason_mode">
          <option value="all"<?= $reason_mode==='all' ? ' selected' : '' ?>>Все</option>
          <option value="with_reason"<?= $reason_mode==='with_reason' ? ' selected' : '' ?>>Только с reason</option>
          <option value="without_reason"<?= $reason_mode==='without_reason' ? ' selected' : '' ?>>Только без reason</option>
        </select>
      </div>

      <div class="field">
        <label>Сортировка</label>
        <select name="sort">
          <?php foreach ($sortLabels as $k => $v): ?>
            <option value="<?= h($k) ?>"<?= $sort === $k ? ' selected' : '' ?>><?= h($v) ?></option>
          <?php endforeach; ?>
        </select>
      </div>

      <div class="field">
        <label>На странице</label>
        <input type="text" name="per_page" value="<?= h((string)$per_page) ?>">
      </div>

      <div class="field">
        <label>Videos ≥</label>
        <input type="text" name="amount_videos" value="<?= h((string)$amount_videos) ?>">
      </div>

      <div class="field">
        <label>% видео &gt; 5 мин ≥</label>
        <input type="text" name="percent_bigger_5_min" value="<?= h((string)$percent_bigger_5_min) ?>">
      </div>

      <div class="field">
        <label>% RU заголовков ≥</label>
        <input type="text" name="percent_ru_videos" value="<?= h((string)$percent_ru_videos) ?>">
      </div>

      <div class="field">
        <label>Average views ≥</label>
        <input type="text" name="average_views" value="<?= h((string)$average_views) ?>">
      </div>

      <div class="field">
        <label>Оценка ≥</label>
        <input type="text" name="score_min" value="<?= h((string)$score_min) ?>">
      </div>

      <div class="field">
        <label>Median views ≥</label>
        <input type="text" name="median_views_min" value="<?= h((string)$median_views_min) ?>">
      </div>
    </div>

    <input type="hidden" name="page" value="1">

    <div class="actions">
      <button class="btn" type="submit">Применить</button>
      <a class="btn btn-secondary" href="view.php">Сбросить</a>
      <button class="btn btn-danger" type="button" onclick="remove_all()">Очистить базу</button>
      <div class="summary">При применении фильтров страница всегда сбрасывается на 1, поэтому фильтры сверху теперь отрабатывают предсказуемо.</div>
    </div>
  </form>

  <div class="panel">
    <div class="panel-head">
      <div>
        <div class="panel-title">Каналы</div>
        <div class="panel-sub">BL / UNBL теперь срабатывает без прыжка наверх. Когда канал скрывается фильтром, строка убирается прямо на месте.</div>
      </div>
      <div class="pager">
        <a href="view.php?<?= h(qbuild(['page' => 1])) ?>">« Первая</a>
        <a href="view.php?<?= h(qbuild(['page' => $prev])) ?>">← Назад</a>
        <span class="current"><?= h((string)$page) ?></span>
        <a href="view.php?<?= h(qbuild(['page' => $next])) ?>">Вперед →</a>
        <a href="view.php?<?= h(qbuild(['page' => $total_pages])) ?>">Последняя »</a>
      </div>
    </div>

    <div class="table-wrap">
      <table>
        <thead>
          <tr data-id="<?= (int)$id ?>" data-is-bl="<?= $isBL ? 1 : 0 ?>" data-has-reason="<?= h($reasonShow !== "" ? "1" : "0") ?>">
            <th>ID</th>
            <th>BL</th>
            <th>Канал</th>
            <th>Status</th>
            <th>Reason</th>
            <th class="right">Score</th>
            <th class="right">Subs</th>
            <th class="right">Avg</th>
            <th class="right">Median</th>
            <th class="right">Max</th>
            <th class="right">% &gt;5m</th>
            <th class="right">% RU</th>
            <th class="right">% Shorts</th>
            <th class="right">Uploads30d</th>
            <th class="right">LastUp(d)</th>
            <th>Upd</th>
          </tr>
        </thead>
        <tbody>
        <?php foreach ($items as $it):
          $id = (int)($it['id'] ?? 0);
          $link = (string)($it['link'] ?? '');
          $name = (string)($it['name'] ?? '');
          $st = $has('status') ? (string)($it['status'] ?? '') : '';
          $st_reason = $has('status_reason') ? trim((string)($it['status_reason'] ?? '')) : '';
          $isBL = !empty($it['bl_id']);
          $bl_reason = trim((string)($it['bl_reason'] ?? ''));
          $score = $has('score') ? (int)($it['score'] ?? 0) : 0;
          $subs = $has('subs') ? (int)($it['subs'] ?? 0) : 0;
          $avg = $has('average_views') ? (int)($it['average_views'] ?? 0) : 0;
          $med = $has('median_views') ? (int)($it['median_views'] ?? 0) : 0;
          $maxv = $has('max_views') ? (int)($it['max_views'] ?? 0) : 0;
          $is_long = $has('is_long') ? (int)($it['is_long'] ?? 0) : 0;
          $is_ru = $has('is_russian') ? (int)($it['is_russian'] ?? 0) : 0;
          $p_shorts = $has('shorts_ratio') ? (int)($it['shorts_ratio'] ?? 0) : (($has('percent_shorts')) ? (int)($it['percent_shorts'] ?? 0) : 0);
          $uploads30d = $has('uploads_30d') ? (int)($it['uploads_30d'] ?? 0) : 0;
          $lastUp = $has('last_upload_days') ? (int)($it['last_upload_days'] ?? -1) : -1;
          $updated_at = ($has('updated_at') && !empty($it['updated_at'])) ? date('d.m H:i', (int)$it['updated_at']) : '';
          $date_create = (!empty($it['date_create'])) ? date('d.m H:i', (int)$it['date_create']) : '';
          $date_show = $updated_at !== '' ? $updated_at : $date_create;
          $badge = 'st-done';
          if ($st === 'new') $badge = 'st-new';
          elseif ($st === 'processing') $badge = 'st-proc';
          elseif ($st === 'error') $badge = 'st-err';
          elseif ($st === 'skipped') $badge = 'st-skip';
          $titleLink = $name !== '' ? $name : $link;
          $reasonShow = $isBL ? ('BL: ' . $bl_reason) : $st_reason;
        ?>
          <tr data-id="<?= (int)$id ?>" data-is-bl="<?= $isBL ? 1 : 0 ?>" data-has-reason="<?= h($reasonShow !== "" ? "1" : "0") ?>">
            <td class="mono"><?= h((string)$id) ?></td>
            <td>
              <button class="btn-mini js-bl-btn" type="button" onclick="toggle_bl(this, <?= (int)$id ?>, <?= $isBL ? 1 : 0 ?>)"><?= $isBL ? 'UNBL' : 'BL' ?></button>
              <div style="margin-top:8px;">
                <span class="bl-badge <?= $isBL ? 'bl-on' : 'bl-off' ?>"><?= $isBL ? 'BLACKLIST' : 'VISIBLE' ?></span>
              </div>
            </td>
            <td>
              <a class="channel-link" target="_blank" rel="noopener noreferrer" href="<?= h($link) ?>">
                <span class="name"><?= h($titleLink) ?></span>
                <span class="link-sub"><?= h($link) ?></span>
              </a>
            </td>
            <td>
              <?php if ($has('status')): ?>
                <span class="status-badge <?= h($badge) ?>"><?= h($st !== '' ? $st : '—') ?></span>
              <?php else: ?>
                <span class="small">—</span>
              <?php endif; ?>
            </td>
            <td class="reason" title="<?= h($reasonShow) ?>"><?= h($reasonShow !== '' ? $reasonShow : '—') ?></td>
            <td class="right mono"><b><?= h(num_cell($score)) ?></b></td>
            <td class="right mono"><?= h(num_cell($subs)) ?></td>
            <td class="right mono"><?= h(num_cell($avg)) ?></td>
            <td class="right mono"><?= h(num_cell($med)) ?></td>
            <td class="right mono"><?= h(num_cell($maxv)) ?></td>
            <td class="right mono"><?= h((string)$is_long) ?></td>
            <td class="right mono"><?= h((string)$is_ru) ?></td>
            <td class="right mono"><?= h((string)$p_shorts) ?></td>
            <td class="right mono"><?= h(num_cell($uploads30d)) ?></td>
            <td class="right mono"><?= h((string)$lastUp) ?></td>
            <td class="mono"><?= h($date_show !== '' ? $date_show : '—') ?></td>
          </tr>
        <?php endforeach; ?>
        </tbody>
      </table>
    </div>
  </div>

  </section>

  <section class="tab-pane" data-pane="advertisers">
    <div class="panel">
      <div class="panel-head">
        <div>
          <div class="panel-title">Рекламодатели</div>
          <div class="panel-sub">Найденные компании (ООО / ИП / АО), видео-источник и дата видео.</div>
        </div>
      </div>
      <div class="table-wrap">
        <table style="min-width:980px;">
          <thead>
            <tr>
              <th>Компания</th>
              <th>Тип</th>
              <th>Видео-источник</th>
              <th>Дата видео</th>
              <th>Добавлено</th>
            </tr>
          </thead>
          <tbody>
            <?php foreach ($advertisers as $adv):
              $vDate = !empty($adv['source_video_date']) ? date('d.m.Y', (int)$adv['source_video_date']) : '—';
              $aDate = !empty($adv['created_at']) ? date('d.m.Y H:i', (int)$adv['created_at']) : '—';
              $videoTitle = trim((string)($adv['video_title'] ?? ''));
              $videoText = $videoTitle !== '' ? $videoTitle : ((string)$adv['source_video_url']);
            ?>
            <tr>
              <td><b><?= h((string)$adv['company_name']) ?></b></td>
              <td class="mono"><?= h((string)$adv['company_type']) ?></td>
              <td><a target="_blank" rel="noopener noreferrer" href="<?= h((string)$adv['source_video_url']) ?>"><?= h($videoText) ?></a></td>
              <td class="mono"><?= h($vDate) ?></td>
              <td class="mono"><?= h($aDate) ?></td>
            </tr>
            <?php endforeach; ?>
          </tbody>
        </table>
      </div>
    </div>
  </section>
</div>

<script src="https://code.jquery.com/jquery-3.6.0.min.js"></script>
<script>
const currentStateUrl = () => window.location.pathname + window.location.search;

function remove_all(){
  const key = prompt("API ключ (если настроен). Если ключ пустой в config.php — оставь тоже пустым", "");
  if(key === null) return;
  if(!confirm("Точно очистить таблицу chanels?")) return;

  $.ajax({
    type: "POST",
    url: "remove_all.php",
    data: { key: key },
    success: function () { window.location.href = currentStateUrl(); },
    error: function (xhr) { alert("Ошибка: " + xhr.status); }
  });
}

function showToast(text){
  let el = document.querySelector('.toast');
  if(!el){
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.remove('show'), 1600);
}

function getFilterState(){
  const form = document.getElementById('filtersForm');
  const fd = new FormData(form);
  return {
    onlyNotBL: String(fd.get('only_not_blacklisted') || '1') === '1',
    reasonMode: String(fd.get('reason_mode') || 'all')
  };
}

function getReasonTextForRow(row, makeBL, reason){
  const cell = row.querySelector('td.reason');
  if(makeBL) return 'BL: ' + (reason || 'manual');
  if (!cell) return '';
  const txt = (cell.textContent || '').trim();
  if (txt === '—') return '';
  if (txt.startsWith('BL: ')) return '';
  return txt;
}

function shouldHideRowAfterToggle(row, makeBL, reason){
  const state = getFilterState();
  const nextReasonText = getReasonTextForRow(row, makeBL, reason);
  if (state.onlyNotBL && makeBL) return true;
  if (state.reasonMode === 'with_reason' && !nextReasonText) return true;
  if (state.reasonMode === 'without_reason' && nextReasonText) return true;
  return false;
}

function updateRowUI(row, makeBL, reason){
  row.dataset.isBl = makeBL ? '1' : '0';
  row.dataset.hasReason = reason ? '1' : '0';

  const btn = row.querySelector('.js-bl-btn');
  const badge = row.querySelector('.bl-badge');
  const reasonCell = row.querySelector('td.reason');

  if (btn){
    btn.textContent = makeBL ? 'UNBL' : 'BL';
    btn.setAttribute('onclick', `toggle_bl(this, ${row.dataset.id}, ${makeBL ? 1 : 0})`);
  }

  if (badge){
    badge.textContent = makeBL ? 'BLACKLIST' : 'VISIBLE';
    badge.classList.toggle('bl-on', makeBL);
    badge.classList.toggle('bl-off', !makeBL);
  }

  if (reasonCell){
    if (makeBL) {
      reasonCell.textContent = 'BL: ' + (reason || 'manual');
      reasonCell.title = reasonCell.textContent;
    } else {
      const original = reasonCell.getAttribute('data-status-reason') || '';
      reasonCell.textContent = original || '—';
      reasonCell.title = original;
    }
  }
}

function toggle_bl(btn, id, isOn){
  const row = btn?.closest('tr');
  const key = prompt("API ключ (если настроен). Если ключ пустой — оставь пустым", "");
  if(key === null) return;

  const on = isOn ? 0 : 1;
  let reason = '';
  if(on === 1){
    reason = prompt("Причина (shorts_only / music / kids / reupload / manual)", "manual") || "manual";
  }

  const hideAfter = row ? shouldHideRowAfterToggle(row, on === 1, reason) : false;
  if (btn) btn.disabled = true;

  $.ajax({
    type: "POST",
    url: "blacklist.php",
    dataType: 'json',
    data: { key: key, id: id, on: on, reason: reason },
    success: function(resp){
      if (!resp || resp.ok !== true) {
        alert('Не удалось обновить blacklist');
        if (btn) btn.disabled = false;
        return;
      }

      if (row) {
        const reasonCell = row.querySelector('td.reason');
        if (reasonCell && !reasonCell.hasAttribute('data-status-reason')) {
          const txt = (reasonCell.textContent || '').trim();
          reasonCell.setAttribute('data-status-reason', txt && !txt.startsWith('BL: ') && txt !== '—' ? txt : '');
        }

        if (hideAfter) {
          row.classList.add('row-fade-out');
          setTimeout(() => {
            row.remove();
            showToast(on === 1 ? 'Канал добавлен в blacklist' : 'Канал убран из blacklist');
          }, 180);
        } else {
          updateRowUI(row, on === 1, reason);
          showToast(on === 1 ? 'Канал добавлен в blacklist' : 'Канал убран из blacklist');
        }
      }

      if (btn) btn.disabled = false;
    },
    error: function(xhr){
      if (btn) btn.disabled = false;
      alert("Ошибка: " + xhr.status);
    }
  });
}

document.querySelectorAll('tbody tr').forEach((row) => {
  const reasonCell = row.querySelector('td.reason');
  if (!reasonCell) return;
  const txt = (reasonCell.textContent || '').trim();
  reasonCell.setAttribute('data-status-reason', txt && !txt.startsWith('BL: ') && txt !== '—' ? txt : '');
});

// Любое изменение фильтра сбрасывает пагинацию на 1.
document.getElementById('filtersForm')?.addEventListener('submit', function(){
  const pageInput = this.querySelector('input[name="page"]');
  if (pageInput) pageInput.value = '1';
});


document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.tab-pane').forEach((pane) => pane.classList.toggle('active', pane.dataset.pane === tab));
  });
});

</script>
</body>
</html>
