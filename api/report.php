<?php
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-cache');

$data_dir = __DIR__ . '/data';

// ── Chargement & déduplication ────────────────────────────────
$all = [];
foreach (glob($data_dir . '/transactions_*.json') ?: [] as $file) {
    $data = json_decode(file_get_contents($file), true);
    if (is_array($data)) $all = array_merge($all, $data);
}
$byId = [];
foreach ($all as $tx) { if (isset($tx['id'])) $byId[$tx['id']] = $tx; }
$all_full = array_values($byId);   // liste complète, non filtrée

// ── Filtres date ──────────────────────────────────────────────
$from = $_GET['from'] ?? null;
$to   = $_GET['to']   ?? null;

// ── Solde d'ouverture : tout dérouler avant $from ─────────────
// On recalcule l'état réel de la caisse à l'instant $from
// en cumulant TOUS les mouvements antérieurs, dans l'ordre chronologique.
$opening = ['cash' => 0.0, 'voucher' => 0.0];

if ($from) {
    $before = array_filter($all_full, fn($tx) => ($tx['timestamp'] ?? '') < $from);
    usort($before, fn($a, $b) => strcmp($a['timestamp'] ?? '', $b['timestamp'] ?? ''));

    foreach ($before as $tx) {
        $type = $tx['type'] ?? 'sale';

        if ($type === 'fond') {
            // Ajout dans la caisse (fond initial ou rattrapage)
            $opening['cash']    += floatval($tx['payment']['cash']    ?? 0);
            $opening['voucher'] += floatval($tx['payment']['voucher'] ?? 0);

        } elseif ($type === 'sale') {
            // Encaissements liquide/bons
            $opening['cash']    += floatval($tx['payment']['cash']    ?? 0);
            $opening['voucher'] += floatval($tx['payment']['voucher'] ?? 0);
            // Déduire le rendu de monnaie
            if (!empty($tx['change']['amount']) && floatval($tx['change']['amount']) > 0) {
                $cm = $tx['change']['method'] ?? 'cash';
                if (isset($opening[$cm])) $opening[$cm] -= floatval($tx['change']['amount']);
            }

        } elseif ($type === 'refund') {
            $opening['cash']    -= abs(floatval($tx['payment']['cash']    ?? 0));
            $opening['voucher'] -= abs(floatval($tx['payment']['voucher'] ?? 0));

        } elseif ($type === 'decaissement') {
            $opening['cash']    -= abs(floatval($tx['payment']['cash']    ?? 0));
            $opening['voucher'] -= abs(floatval($tx['payment']['voucher'] ?? 0));
        }
    }
}

// ── Filtrer les transactions sur la période ───────────────────
$all = $all_full;
if ($from || $to) {
    $all = array_values(array_filter($all, function ($tx) use ($from, $to) {
        $ts = $tx['timestamp'] ?? '';
        if ($from && $ts < $from) return false;
        if ($to   && $ts > $to)   return false;
        return true;
    }));
}
usort($all, fn($a, $b) => strcmp($a['timestamp'] ?? '', $b['timestamp'] ?? ''));

// ── Agrégation sur la période ─────────────────────────────────
$sales_count  = $refund_count  = 0;
$total_sales  = $total_refunds = 0.0;

$gross_in         = ['cash' => 0.0, 'voucher' => 0.0, 'cb' => 0.0, 'phone' => 0.0];
$change_out       = ['cash' => 0.0, 'voucher' => 0.0];
$refund_out       = ['cash' => 0.0, 'voucher' => 0.0, 'cb' => 0.0, 'phone' => 0.0];
$decaissement_out = ['cash' => 0.0, 'voucher' => 0.0];
$ajouts_in        = ['cash' => 0.0, 'voucher' => 0.0];
$by_product       = [];

foreach ($all as $tx) {
    $type  = $tx['type'] ?? 'sale';
    $total = floatval($tx['total'] ?? 0);

    if ($type === 'sale') {
        $sales_count++; $total_sales += $total;
        foreach (['cash', 'voucher', 'cb', 'phone'] as $m)
            $gross_in[$m] += floatval($tx['payment'][$m] ?? 0);
        if (!empty($tx['change']['amount']) && floatval($tx['change']['amount']) > 0) {
            $cm = $tx['change']['method'] ?? 'cash';
            if (isset($change_out[$cm])) $change_out[$cm] += floatval($tx['change']['amount']);
        }
        foreach (($tx['items'] ?? []) as $item) {
            $name = $item['name'] ?? '?';
            if (!isset($by_product[$name]))
                $by_product[$name] = ['name' => $name, 'qty' => 0, 'revenue' => 0.0];
            $by_product[$name]['qty']     += intval($item['qty'] ?? 1);
            $by_product[$name]['revenue'] += floatval($item['price'] ?? 0) * intval($item['qty'] ?? 1);
        }

    } elseif ($type === 'refund') {
        $refund_count++; $total_refunds += abs($total);
        foreach (['cash', 'voucher', 'cb', 'phone'] as $m)
            $refund_out[$m] += abs(floatval($tx['payment'][$m] ?? 0));

    } elseif ($type === 'decaissement') {
        foreach (['cash', 'voucher'] as $m)
            $decaissement_out[$m] += abs(floatval($tx['payment'][$m] ?? 0));

    } elseif ($type === 'fond') {
        // Ajout dans la caisse pendant la période (rattrapage, appoint…)
        foreach (['cash', 'voucher'] as $m)
            $ajouts_in[$m] += floatval($tx['payment'][$m] ?? 0);
    }
}

usort($by_product, fn($a, $b) => $b['qty'] - $a['qty']);

$net_by_method = [];
foreach (['cash', 'voucher', 'cb', 'phone'] as $m)
    $net_by_method[$m] = $gross_in[$m] - ($change_out[$m] ?? 0) - $refund_out[$m];

// ── Réponse ───────────────────────────────────────────────────
echo json_encode([
    'sales_count'      => $sales_count,
    'refund_count'     => $refund_count,
    'total_sales'      => round($total_sales,   2),
    'total_refunds'    => round($total_refunds, 2),
    'net'              => round($total_sales - $total_refunds, 2),
    'by_product'       => array_values($by_product),
    'gross_in'         => array_map(fn($v) => round($v, 2), $gross_in),
    'change_out'       => array_map(fn($v) => round($v, 2), $change_out),
    'refund_out'       => array_map(fn($v) => round($v, 2), $refund_out),
    'net_by_method'    => array_map(fn($v) => round($v, 2), $net_by_method),
    'decaissement_out' => array_map(fn($v) => round($v, 2), $decaissement_out),
    'ajouts_in'        => array_map(fn($v) => round($v, 2), $ajouts_in),
    'opening'          => array_map(fn($v) => round($v, 2), $opening),
    'cash_net'         => round($net_by_method['cash'],    2),
    'voucher_net'      => round($net_by_method['voucher'], 2),
    'movements'        => array_values(array_filter($all, fn($tx) =>
        in_array($tx['type'] ?? 'sale', ['sale', 'refund', 'fond', 'decaissement'])
    )),
], JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE);
