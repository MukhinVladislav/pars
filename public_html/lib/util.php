<?php
require_once __DIR__ . '/config.php';

function h(string $s): string {
    return htmlspecialchars($s, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

function int_param(string $key, int $default = 0, int $min = 0, int $max = PHP_INT_MAX): int {
    $v = $_GET[$key] ?? $_POST[$key] ?? $default;
    if (is_array($v)) {
        return $default;
    }
    $v = (int)preg_replace('/[^0-9\-]/', '', (string)$v);
    if ($v < $min) $v = $min;
    if ($v > $max) $v = $max;
    return $v;
}

function get_request_key(): string {
    $k = $_GET['key'] ?? $_POST['key'] ?? '';
    if (!is_string($k)) return '';
    return trim($k);
}

function require_api_key_if_configured(): void {
    if (API_KEY === '') {
        return; // режим совместимости (НЕбезопасно)
    }

    $k = get_request_key();
    if (!hash_equals(API_KEY, $k)) {
        http_response_code(403);
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode(['ok' => false, 'error' => 'forbidden'], JSON_UNESCAPED_UNICODE);
        exit;
    }
}
