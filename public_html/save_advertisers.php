<?php
ini_set('display_errors', 1);
ini_set('display_startup_errors', 1);
error_reporting(E_ALL);

require_once __DIR__ . '/lib/db.php';
require_once __DIR__ . '/lib/util.php';

header('Content-Type: application/json; charset=utf-8');
require_api_key_if_configured();

$raw = file_get_contents('php://input');
$payload = json_decode($raw, true);
if (!is_array($payload)) {
  $payload = $_POST;
}

$videoId = (int)($payload['video_db_id'] ?? 0);
$videoDate = (int)($payload['video_date'] ?? 0);
$videoUrl = mb_substr(trim((string)($payload['video_url'] ?? '')), 0, 255);
$advertisers = $payload['advertisers'] ?? [];
if (!is_array($advertisers)) $advertisers = [];

if ($videoId <= 0) {
  echo json_encode(['ok' => false, 'error' => 'bad_video_id'], JSON_UNESCAPED_UNICODE);
  exit;
}

$now = time();
$added = 0;
$exists = 0;
$dbh = DB::getDbh();
$sth = $dbh->prepare(
  'INSERT INTO advertisers (company_name, company_type, video_id, source_video_url, source_video_date, created_at)
   VALUES (?, ?, ?, ?, ?, ?)
   ON DUPLICATE KEY UPDATE id=id'
);

try {
  foreach ($advertisers as $adv) {
    if (!is_array($adv)) continue;

    $companyName = mb_substr(trim((string)($adv['company_name'] ?? '')), 0, 255);
    $companyType = trim((string)($adv['company_type'] ?? ''));
    if ($companyName === '' || !in_array($companyType, ['ООО', 'ИП', 'АО'], true)) continue;

    $sth->execute([$companyName, $companyType, $videoId, $videoUrl, $videoDate > 0 ? $videoDate : null, $now]);

    if ($sth->rowCount() === 1) $added++;
    else $exists++;
  }

  DB::set(
    "UPDATE videos SET status='done', video_date=?, last_error=NULL, updated_at=? WHERE id=?",
    [$videoDate > 0 ? $videoDate : null, $now, $videoId]
  );

  echo json_encode(['ok' => true, 'added' => $added, 'exists' => $exists], JSON_UNESCAPED_UNICODE);
} catch (Throwable $e) {
  DB::set(
    "UPDATE videos SET status='error', last_error=?, updated_at=? WHERE id=?",
    [mb_substr($e->getMessage(), 0, 500), $now, $videoId]
  );

  http_response_code(500);
  echo json_encode(['ok' => false, 'error' => 'save_failed'], JSON_UNESCAPED_UNICODE);
}
