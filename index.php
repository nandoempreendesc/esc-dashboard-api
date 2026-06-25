<?php
define('RD_CRM_TOKEN', '6a3be3a4c81c68001e67ea0a');
define('RD_MKT_TOKEN', '745467e98d2287fcdd41eb572722b0c9');
define('PIPELINE_ID',  '6a3c2697d2d223001fa3f0ad');

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(200); exit; }

function crm($path) {
    $sep = strpos($path, '?') !== false ? '&' : '?';
    $url = 'https://api.rd.services/api/v2' . $path . $sep . 'token=' . RD_CRM_TOKEN;
    $ch  = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER     => ['Accept: application/json'],
        CURLOPT_TIMEOUT        => 20,
        CURLOPT_SSL_VERIFYPEER => true,
    ]);
    $r = curl_exec($ch); curl_close($ch);
    return $r ? json_decode($r, true) : null;
}

function mkt($path) {
    $sep = strpos($path, '?') !== false ? '&' : '?';
    $url = 'https://api.rd.services' . $path . $sep . 'token=' . RD_MKT_TOKEN;
    $ch  = curl_init($url);
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 15]);
    $r = curl_exec($ch); curl_close($ch);
    return $r ? json_decode($r, true) : null;
}

function all_deals($pipeline_id) {
    $filter = urlencode("pipeline_id:{$pipeline_id}");
    $all = []; $page = 1;
    do {
        $res  = crm("/deals?filter={$filter}&page[number]={$page}&page[size]=50");
        $data = $res['data'] ?? [];
        $all  = array_merge($all, $data);
        $last = 1;
        if (!empty($res['links']['last'])) {
            preg_match('/page%5Bnumber%5D=(\d+)/', $res['links']['last'], $m);
            $last = (int)($m[1] ?? 1);
        }
        $page++;
    } while ($page <= $last && $page <= 10);
    return $all;
}

function map_origin($name) {
    $n = strtolower($name ?? '');
    if (str_contains($n, 'whatsapp') || str_contains($n, 'zap'))    return 'WhatsApp';
    if (str_contains($n, 'site')     || str_contains($n, 'web'))     return 'Site';
    if (str_contains($n, 'rd')       || str_contains($n, 'formu') || str_contains($n, 'landing')) return 'RD Station';
    if (str_contains($n, 'instagram')|| str_contains($n, 'insta'))   return 'Instagram';
    if (str_contains($n, 'indica'))                                   return 'Indicação';
    if (str_contains($n, 'evento'))                                   return 'Evento';
    return 'Outros';
}

function find_stage($map, $keywords) {
    foreach ($keywords as $kw)
        foreach ($map as $name => $id)
            if (str_contains($name, strtolower($kw))) return $id;
    return null;
}

function esc_pct($a, $b) { return $b > 0 ? round(($a / $b) * 100, 1) : 0; }
function esc_sum($deals)  { return array_sum(array_map(fn($d) => floatval($d['total_price'] ?? 0), $deals)); }
function in_stage($deals, $sid) { return array_filter($deals, fn($d) => ($d['stage_id'] ?? '') === $sid); }

// Etapas
$stages_raw = crm('/deal_pipeline_stages?deal_pipeline_id=' . PIPELINE_ID . '&page[size]=20');
$stages = []; $stage_id_map = [];
foreach ($stages_raw['data'] ?? [] as $s) {
    $stages[$s['id']] = $s['name'];
    $stage_id_map[strtolower(trim($s['name']))] = $s['id'];
}

// Usuários e origens
$users_raw = crm('/users?page[size]=50');
$users = [];
foreach ($users_raw['data'] ?? [] as $u) $users[$u['id']] = $u['name'];

$sources_raw = crm('/sources?page[size]=50');
$source_map = [];
foreach ($sources_raw['data'] ?? [] as $s) $source_map[$s['id']] = $s['name'];

// Etapas chave
$sid_agendada  = find_stage($stage_id_map, ['agendada','agendamento','agend']);
$sid_realizada = find_stage($stage_id_map, ['realizada','realiz']);
$sid_proposta  = find_stage($stage_id_map, ['proposta','propost']);

// Deals
$deals = all_deals(PIPELINE_ID);

// Filtros via GET
$date_from = $_GET['date_from'] ?? null;
$date_to   = $_GET['date_to']   ?? null;
$owner_id  = $_GET['owner_id']  ?? null;
$stage_flt = $_GET['stage_id']  ?? null;

if ($date_from || $date_to) {
    $deals = array_values(array_filter($deals, function($d) use ($date_from, $date_to) {
        $dt = substr($d['created_at'] ?? '', 0, 10);
        if ($date_from && $dt < $date_from) return false;
        if ($date_to   && $dt > $date_to)   return false;
        return true;
    }));
}
if ($owner_id)  $deals = array_values(array_filter($deals, fn($d) => ($d['owner_id']  ?? '') === $owner_id));
if ($stage_flt) $deals = array_values(array_filter($deals, fn($d) => ($d['stage_id']  ?? '') === $stage_flt));

// KPIs
$won  = array_values(array_filter($deals, fn($d) => ($d['status'] ?? '') === 'won'));
$lost = array_values(array_filter($deals, fn($d) => ($d['status'] ?? '') === 'lost'));
$open = array_values(array_filter($deals, fn($d) => ($d['status'] ?? '') === 'ongoing'));

$d_agendada  = array_values(in_stage($deals, $sid_agendada));
$d_realizada = array_values(in_stage($deals, $sid_realizada));
$d_proposta  = array_values(in_stage($deals, $sid_proposta));

$receita = esc_sum($won);
$qtd_won = count($won);
$leads_total = count($deals);

// Por origem
$by_origin = [];
foreach ($deals as $d) {
    $origin = map_origin($source_map[$d['source_id'] ?? ''] ?? '');
    if (!isset($by_origin[$origin])) $by_origin[$origin] = ['leads'=>0,'won'=>0,'revenue'=>0];
    $by_origin[$origin]['leads']++;
    if (($d['status']??'') === 'won') { $by_origin[$origin]['won']++; $by_origin[$origin]['revenue'] += floatval($d['total_price']??0); }
}

// Por responsável
$by_owner = [];
foreach ($deals as $d) {
    $name = $users[$d['owner_id']??''] ?? 'Desconhecido';
    if (!isset($by_owner[$name])) $by_owner[$name] = ['total'=>0,'won'=>0,'lost'=>0,'revenue'=>0];
    $by_owner[$name]['total']++;
    if (($d['status']??'') === 'won')  { $by_owner[$name]['won']++;  $by_owner[$name]['revenue'] += floatval($d['total_price']??0); }
    if (($d['status']??'') === 'lost') $by_owner[$name]['lost']++;
}
foreach ($by_owner as &$o) $o['conv'] = esc_pct($o['won'], $o['total']);
unset($o);

// Funil visual
$funnel_visual = [];
foreach ($stages as $sid => $sname)
    $funnel_visual[] = ['stage' => $sname, 'count' => count(in_stage($deals, $sid))];

// Perda por etapa
$perda = [];
foreach ($lost as $d) {
    $name = $stages[$d['stage_id']??''] ?? 'Sem etapa';
    $perda[$name] = ($perda[$name]??0) + 1;
}
arsort($perda);

// Insights
$max_l=$max_v=$max_r=-1; $cl=$cv=$cr=null;
foreach ($by_origin as $k=>$v) {
    if ($v['leads']>$max_l)   { $max_l=$v['leads'];   $cl=$k; }
    if ($v['won']>$max_v)     { $max_v=$v['won'];     $cv=$k; }
    if ($v['revenue']>$max_r) { $max_r=$v['revenue']; $cr=$k; }
}
$melhor_vendedor=null; $max_conv=-1;
foreach ($by_owner as $name=>$o) {
    if ($o['total']>=2 && $o['conv']>$max_conv) { $max_conv=$o['conv']; $melhor_vendedor=$name; }
}

// Marketing
$today   = date('Y-m-d');
$mes_ini = date('Y-m-01');
$mkt_funnel = mkt('/platform/analytics/conversion_funnel');
$leads_hoje = mkt('/platform/contacts/search?page=1&page_size=1&created_at_from='.$today.'T00:00:00&created_at_to='.$today.'T23:59:59');
$leads_mes  = mkt('/platform/contacts/search?page=1&page_size=1&created_at_from='.$mes_ini.'T00:00:00&created_at_to='.$today.'T23:59:59');

echo json_encode([
    'meta' => [
        'pipeline_id' => PIPELINE_ID,
        'total_deals' => count($deals),
        'stages'      => $stages,
        'users'       => $users,
        'gerado_em'   => date('Y-m-d H:i:s'),
    ],
    'captacao' => [
        'leads_whatsapp' => $by_origin['WhatsApp']['leads']   ?? 0,
        'leads_rd'       => $by_origin['RD Station']['leads'] ?? 0,
        'leads_site'     => $by_origin['Site']['leads']       ?? 0,
        'leads_total'    => $leads_total,
        'leads_hoje'     => $leads_hoje['total'] ?? 0,
        'leads_mes'      => $leads_mes['total']  ?? 0,
    ],
    'comercial' => [
        'agendamentos'       => count($d_agendada),
        'reunioes_ocorridas' => count($d_realizada),
        'propostas_enviadas' => count($d_proposta),
        'valor_propostas'    => round(esc_sum($d_proposta), 2),
        'pipeline_aberto'    => round(esc_sum($open), 2),
        'won'                => $qtd_won,
        'lost'               => count($lost),
        'open'               => count($open),
    ],
    'conversao' => [
        'presenca_reuniao'    => esc_pct(count($d_realizada), count($d_agendada)),
        'reuniao_para_venda'  => esc_pct($qtd_won, count($d_realizada)),
        'proposta_para_venda' => esc_pct($qtd_won, count($d_proposta)),
        'lead_para_venda'     => esc_pct($qtd_won, $leads_total),
    ],
    'financeiro' => [
        'receita_fechada'    => round($receita, 2),
        'ticket_medio'       => $qtd_won > 0 ? round($receita / $qtd_won, 2) : 0,
        'receita_por_origem' => array_map(fn($o) => round($o['revenue'], 2), $by_origin),
    ],
    'funil_visual'    => $funnel_visual,
    'por_origem'      => $by_origin,
    'por_responsavel' => $by_owner,
    'perda_por_etapa' => $perda,
    'marketing'       => ['funnel' => $mkt_funnel],
    'insights' => [
        'melhor_canal_leads'   => $cl,
        'melhor_canal_vendas'  => $cv,
        'melhor_canal_receita' => $cr,
        'melhor_vendedor'      => $melhor_vendedor,
        'melhor_vendedor_conv' => $max_conv,
        'etapa_maior_perda'    => array_key_first($perda),
        'perda_por_etapa'      => $perda,
    ],
    'filtros_disponiveis' => [
        'users'   => $users,
        'stages'  => $stages,
        'origens' => ['WhatsApp','Site','RD Station','Instagram','Indicação','Evento','Outros'],
    ],
], JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
