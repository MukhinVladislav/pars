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

$videos = $payload['videos'] ?? [];
if (!is_array($videos) || !$videos) {
  echo json_encode(['ok' => false, 'error' => 'no_videos'], JSON_UNESCAPED_UNICODE);
  exit;
}

$added = 0;
$exists = 0;
$now = time();

foreach ($videos as $v) {
  if (!is_array($v)) continue;
  $videoId = trim((string)($v['video_id'] ?? ''));
  $videoUrl = trim((string)($v['video_url'] ?? ''));
  if ($videoId === '' || $videoUrl === '') continue;

  $title = mb_substr(trim((string)($v['title'] ?? '')), 0, 500);
  $query = mb_substr(trim((string)($v['query'] ?? '')), 0, 255);
  $channelUrl = mb_substr(trim((string)($v['channel_url'] ?? '')), 0, 255);

  $found = DB::getRow('SELECT id FROM videos WHERE video_id = ? LIMIT 1', [$videoId]);
  if ($found) {
    $exists++;
    continue;
  }

  DB::add(
    'INSERT INTO videos (video_id, video_url, title, query_text, channel_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [$videoId, $videoUrl, $title, $query, $channelUrl, $now, $now]
  );
  $added++;
}

echo json_encode(['ok' => true, 'added' => $added, 'exists' => $exists], JSON_UNESCAPED_UNICODE);
