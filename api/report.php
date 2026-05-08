<?php
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-cache');

$data_dir = __DIR__ . '/data';

// ── Chargement & déduplication ────────────────────────────────
$all = [];
foreach (glob($data_dir . '/transactions_*.json') as $file) {
    $data = json_decode(file_get_contents($file), true);
    if (is_array($data)) $all = array_merge($all, $data);
}
$byId = [];
foreach ($all as $tx) {
    if (isset($tx['id'])) $byId[$tx['id']] = $tx;
}
$all = array_values($byId);

// ── Filtres date ──────────────────────────────────────────────
$from = $_GET['from'] ?? null;
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

// ── Agrégation ────────────────────────────────────────────────
$sales_count   = 0;
$refund_count  = 0;
$total_sales   = 0.0;
$total_refunds = 0.0;

// Encaissé brut par méthode (ventes uniquement)
$gross_in  = ['cash' => 0.0, 'voucher' => 0.0, 'cb' => 0.0, 'phone' => 0.0];
// Rendu de monnaie donné par méthode
$change_out = ['cash' => 0.0, 'voucher' => 0.0];
// Remboursements sortis par méthode
$refund_out = ['cash' => 0.0, 'voucher' => 0.0, 'cb' => 0.0, 'phone' => 0.0];

// Produits vendus : agrégé par nom
$by_product = [];

foreach ($all as $tx) {
    $type  = $tx['type'] ?? 'sale';
    $total = floatval($tx['total'] ?? 0);

    if ($type === 'sale') {
        $sales_count++;
        $total_sales += $total;

        // Encaissements bruts
        foreach (['cash', 'voucher', 'cb', 'phone'] as $m) {
            $gross_in[$m] += floatval($tx['payment'][$m] ?? 0);
        }

        // Rendu de monnaie
        if (!empty($tx['change']['amount']) && floatval($tx['change']['amount']) > 0) {
            $cm = $tx['change']['method'] ?? 'cash';
            if (isset($change_out[$cm])) {
                $change_out[$cm] += floatval($tx['change']['amount']);
            }
        }

        // Produits vendus
        foreach (($tx['items'] ?? []) as $item) {
            $name = $item['name'] ?? '?';
            if (!isset($by_product[$name])) {
                $by_product[$name] = ['name' => $name, 'qty' => 0, 'revenue' => 0.0];
            }
            $by_product[$name]['qty']     += intval($item['qty'] ?? 1);
            $by_product[$name]['revenue'] += floatval($item['price'] ?? 0) * intval($item['qty'] ?? 1);
        }

    } elseif ($type === 'refund') {
        $refund_count++;
        $total_refunds += abs($total);

        foreach (['cash', 'voucher', 'cb', 'phone'] as $m) {
            $refund_out[$m] += abs(floatval($tx['payment'][$m] ?? 0));
        }
    }
}

// Tri produits par quantité décroissante
usort($by_product, fn($a, $b) => $b['qty'] - $a['qty']);

// Entrées nettes par méthode = encaissé - rendu - remboursé
$net_by_method = [];
foreach (['cash', 'voucher', 'cb', 'phone'] as $m) {
    $net_by_method[$m] = $gross_in[$m] - ($change_out[$m] ?? 0) - $refund_out[$m];
}

// ── Réponse ───────────────────────────────────────────────────
echo json_encode([
    // CA global
    'sales_count'   => $sales_count,
    'refund_count'  => $refund_count,
    'total_sales'   => round($total_sales,   2),
    'total_refunds' => round($total_refunds, 2),
    'net'           => round($total_sales - $total_refunds, 2),

    // Détail produits
    'by_product'    => array_values($by_product),

    // Détail paiements
    'gross_in'      => array_map(fn($v) => round($v, 2), $gross_in),
    'change_out'    => array_map(fn($v) => round($v, 2), $change_out),
    'refund_out'    => array_map(fn($v) => round($v, 2), $refund_out),
    'net_by_method' => array_map(fn($v) => round($v, 2), $net_by_method),

    // Caisse théorique (fond de caisse ajouté côté client)
    'cash_net'      => round($net_by_method['cash'],    2),
    'voucher_net'   => round($net_by_method['voucher'], 2),
], JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE);
