<?php
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-cache');

$data_dir = __DIR__ . '/data';
if (!is_dir($data_dir)) mkdir($data_dir, 0755, true);

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $input = json_decode(file_get_contents('php://input'), true);
    if ($input === null || !isset($input['id'], $input['device_id'])) {
        http_response_code(400);
        echo json_encode(['error' => 'Invalid transaction']);
        exit;
    }

    // Sanitize device_id for use in filename
    $device_id = preg_replace('/[^a-zA-Z0-9_\-]/', '', $input['device_id']);
    if (!$device_id) $device_id = 'unknown';

    $file = $data_dir . '/transactions_' . $device_id . '.json';

    // Load existing, upsert by id (idempotent)
    $transactions = [];
    if (file_exists($file)) {
        $transactions = json_decode(file_get_contents($file), true) ?: [];
    }

    $found = false;
    foreach ($transactions as &$tx) {
        if ($tx['id'] === $input['id']) {
            $tx = $input;
            $found = true;
            break;
        }
    }
    unset($tx);
    if (!$found) $transactions[] = $input;

    file_put_contents(
        $file,
        json_encode($transactions, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE)
    );
    echo json_encode(['success' => true]);

} elseif ($_SERVER['REQUEST_METHOD'] === 'GET') {
    // Merge all devices, sort by timestamp
    $all = [];
    foreach (glob($data_dir . '/transactions_*.json') as $file) {
        $data = json_decode(file_get_contents($file), true);
        if (is_array($data)) $all = array_merge($all, $data);
    }
    usort($all, fn($a, $b) => strcmp($a['timestamp'] ?? '', $b['timestamp'] ?? ''));
    echo json_encode(array_values($all), JSON_UNESCAPED_UNICODE);

} else {
    http_response_code(405);
    echo json_encode(['error' => 'Method not allowed']);
}
