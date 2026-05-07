<?php
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-cache');

$data_dir = __DIR__ . '/data';
if (!is_dir($data_dir)) mkdir($data_dir, 0755, true);
$catalog_file = $data_dir . '/catalog.json';

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    if (file_exists($catalog_file)) {
        echo file_get_contents($catalog_file);
    } else {
        echo json_encode(['products' => []], JSON_UNESCAPED_UNICODE);
    }

} elseif ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $input = json_decode(file_get_contents('php://input'), true);
    if ($input === null) {
        http_response_code(400);
        echo json_encode(['error' => 'Invalid JSON']);
        exit;
    }
    file_put_contents(
        $catalog_file,
        json_encode($input, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE)
    );
    echo json_encode(['success' => true]);

} else {
    http_response_code(405);
    echo json_encode(['error' => 'Method not allowed']);
}
