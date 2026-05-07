<?php
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-cache');

$data_dir = __DIR__ . '/data';

// Load and merge all transactions
$all = [];
foreach (glob($data_dir . '/transactions_*.json') as $file) {
    $data = json_decode(file_get_contents($file), true);
    if (is_array($data)) $all = array_merge($all, $data);
}

// Deduplicate by id (in case of duplicate syncs)
$byId = [];
foreach ($all as $tx) {
    if (isset($tx['id'])) $byId[$tx['id']] = $tx;
}
$all = array_values($byId);

// Optional filters
$from = $_GET['from'] ?? null;  // ISO datetime string
$to   = $_GET['to']   ?? null;

if ($from || $to) {
    $all = array_values(array_filter($all, function ($tx) use ($from, $to) {
        $ts = $tx['timestamp'] ?? '';
        if ($from && $ts < $from) return false;
        if ($to   && $ts > $to)   return false;
        return true;
    }));
}

usort($all, fn($a, $b) => strcmp($a['timestamp'] ?? '', $b['timestamp'] ?? ''));

// Aggregate
$report = [
    'sales_count'   => 0,
    'refund_count'  => 0,
    'total_sales'   => 0.0,
    'total_refunds' => 0.0,
    'by_method'     => ['cash' => 0.0, 'voucher' => 0.0, 'cb' => 0.0, 'phone' => 0.0],
    'change_given'  => ['cash' => 0.0, 'voucher' => 0.0],
    'transactions'  => $all,
];

foreach ($all as $tx) {
    $total = floatval($tx['total'] ?? 0);
    if ($tx['type'] === 'sale') {
        $report['sales_count']++;
        $report['total_sales'] += $total;
    } elseif ($tx['type'] === 'refund') {
        $report['refund_count']++;
        $report['total_refunds'] += abs($total);
    }
    foreach (['cash', 'voucher', 'cb', 'phone'] as $m) {
        $report['by_method'][$m] += floatval($tx['payment'][$m] ?? 0);
    }
    if (!empty($tx['change']['amount'])) {
        $method = $tx['change']['method'] ?? 'cash';
        $report['change_given'][$method] += floatval($tx['change']['amount']);
    }
}

$report['net'] = $report['total_sales'] - $report['total_refunds'];

// Cash drawer estimate
// by_method.cash = cash received from customers
// by_method.cash for refunds is already negative in payment data? No.
// We need to account for cash refunds separately.
// Cash in drawer = opening + cash_sales - cash_refunds - cash_change_given
$report['cash_received']   = $report['by_method']['cash'];
$report['cash_change_out'] = $report['change_given']['cash'];
// Refunds paid in cash: sum of refund transactions where payment.cash < 0
$cash_refunds_out = 0.0;
foreach ($all as $tx) {
    if ($tx['type'] === 'refund') {
        $cash_refunds_out += abs(floatval($tx['payment']['cash'] ?? 0));
    }
}
$report['cash_refunds_out'] = $cash_refunds_out;
$report['cash_net']         = $report['cash_received'] - $report['cash_change_out'] - $cash_refunds_out;

echo json_encode($report, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE);
