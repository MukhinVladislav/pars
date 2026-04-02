<?php
ini_set('display_errors', 1);
ini_set('display_startup_errors', 1);
error_reporting(E_ALL);

require_once __DIR__ . '/lib/db.php';
require_once __DIR__ . '/lib/util.php';

header('Content-Type: application/json; charset=utf-8');
require_api_key_if_configured();

$now = time();

try {
  DB::beginTransaction();

  $row = DB::getRow("SELECT * FROM videos WHERE status='new' ORDER BY id ASC LIMIT 1 FOR UPDATE");
  if (!$row) {
    DB::commit();
    echo json_encode(['ok' => true, 'video' => null], JSON_UNESCAPED_UNICODE);
    exit;
  }

  DB::set(
    "UPDATE videos SET status='processing', parse_attempts=parse_attempts+1, updated_at=? WHERE id=?",
    [$now, (int)$row['id']]
  );

  $row['id'] = (int)$row['id'];
  DB::commit();

  echo json_encode(['ok' => true, 'video' => $row], JSON_UNESCAPED_UNICODE);
} catch (Throwable $e) {
  DB::rollBack();
  http_response_code(500);
  echo json_encode(['ok' => false, 'error' => 'queue_claim_failed'], JSON_UNESCAPED_UNICODE);
}
