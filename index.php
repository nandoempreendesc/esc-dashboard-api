<?php
define('RD_CRM_TOKEN', '6a3be3a4c81c68001e67ea0a');
define('RD_MKT_TOKEN', '745467e98d2287fcdd41eb572722b0c9');
define('PIPELINE_ID',  '6a3c2697d2d223001fa3f0ad');

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(200); exit; }

// API v1 CRM
function crm($path) {
    $sep = strpos($path, '?') !== false ? '&' : '?';
    $url = 'https://crm.rdstation.com/api/v1' . $path . $sep . 'token=' . RD_CRM_TOKEN;
    $ch  = curl_init($url);
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER=>true, CURLOPT_HTTPHEADER=>['Accept: application/json'], CURLOPT_TIMEOUT=>20]);
    $r = curl_exec($ch); curl_close($ch);
    return $r ? json_decode($r, true) : null;
}

// Marketing API
function mkt($path) {
    $sep = strpos($path, '?') !== false ? '&' : '?';
    $url = 'https://api.rd.services' . $path . $sep . 'token=' . RD_MKT_TOKEN;
    $ch  = curl_init($url);
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER=>true, CURLOPT_TIMEOUT=>15]);
    $r = curl_exec($ch); curl_close($ch);
    return $r ? json_decode($r, true) : null;
}

// Paginação deals API v1
function all_deals($pipeline_id) {
    $all = []; $page = 1;
    do {
        $res  = crm("/deals?deal_pipeline_id={$pipeline_id}&page={$page}&limit=50&order=updated_at&direction=desc");
        $data = $res['deals'] ?? [];
        $all  = array_merge($all, $data);
        $total = $res['total'] ?? 0;
        $page++;
    } while (count($all) < $total && $page <= 10);
    return $all;
}

function map_origin($name) {
    $n = strtolower($name ?? '');
    if (str_contains($n,'whatsapp')||str_contains($n,'zap'))  return 'WhatsApp';
    if (str_contains($n,'site')||str_contains($n,'web'))       return 'Site';
    if (str_contains($n,'rd')||str_contains($n,'formu')||str_contains($n,'landing')) return 'RD Station';
    if (str_contains($n,'instagram')||str_contains($n,'insta')) return 'Instagram';
    if (str_contains($n,'indica'))  return 'Indicação';
    if (str_contains($n,'evento'))  return 'Evento';
    return 'Outros';
}

function find_stage($map, $keywords) {
    foreach ($keywords as $kw)
        foreach ($map as $name => $id)
            if (str_contains(strtolower($name), strtolower($kw))) return $id;
    return null;
}

function deal_value($d) { return floatval($d['amount_montly_total'] ?? $d['amount'] ?? 0); }
function esc_pct($a,$b) { return $b>0 ? round(($a/$b)*100,1) : 0; }
function esc_sum($deals) { return array_sum(array_map('deal_value', $deals)); }
function in_stage($deals,$sid) { return array_filter($deals, fn($d)=>($d['deal_stage_id']??'')===($sid??'')); }

// ── Etapas do funil (em ordem) ───────────────────────────────
$stages_raw = crm('/deal_stages?deal_pipeline_id='.PIPELINE_ID.'&limit=50');
$stages_ordered = []; // [id => ['name'=>, 'order'=>]]
$stage_id_map   = []; // nome_lower => id
foreach ($stages_raw['deal_stages'] ?? [] as $s) {
    $stages_ordered[$s['_id']] = ['name' => $s['name'], 'order' => $s['_position'] ?? $s['position'] ?? 0];
    $stage_id_map[strtolower(trim($s['name']))] = $s['_id'];
}
// Ordenar por posição
uasort($stages_ordered, fn($a,$b) => $a['order'] <=> $b['order']);

// Mapa id => posição sequencial (0,1,2...)
$stage_position = [];
$pos = 0;
foreach ($stages_ordered as $sid => $s) {
    $stage_position[$sid] = $pos++;
}

// Usuários
$users_raw = crm('/users?limit=50');
$users = [];
foreach ($users_raw['users'] ?? [] as $u) $users[$u['_id']] = $u['name'];

// Sources
$sources_raw = crm('/deal_sources?limit=50');
$source_map = [];
foreach ($sources_raw['deal_sources'] ?? [] as $s) $source_map[$s['_id']] = $s['name'];

// Etapas chave por nome
$sid_agendada  = find_stage($stage_id_map, ['agendamento','agendada','agend']);
$sid_realizada = find_stage($stage_id_map, ['realizada','realiz']);
$sid_negociacao= find_stage($stage_id_map, ['negociação','negociacao','negoc']);
$sid_ganho     = find_stage($stage_id_map, ['ganho','fechado ganho']);
$sid_perdido   = find_stage($stage_id_map, ['perdido','fechado perdido']);

// Posições das etapas chave
$pos_agendada  = $stage_position[$sid_agendada]   ?? 999;
$pos_realizada = $stage_position[$sid_realizada]  ?? 999;
$pos_negociacao= $stage_position[$sid_negociacao] ?? 999;
$pos_ganho     = $stage_position[$sid_ganho]      ?? 999;
$pos_perdido   = $stage_position[$sid_perdido]    ?? 999;

// ── Deals ────────────────────────────────────────────────────
$deals = all_deals(PIPELINE_ID);

// Filtros GET
$date_from = $_GET['date_from'] ?? null;
$date_to   = $_GET['date_to']   ?? null;
$owner_id  = $_GET['owner_id']  ?? null;
$stage_flt = $_GET['stage_id']  ?? null;

if ($date_from || $date_to) {
    $deals = array_values(array_filter($deals, function($d) use ($date_from,$date_to) {
        $dt = substr($d['created_at']??'',0,10);
        if ($date_from && $dt < $date_from) return false;
        if ($date_to   && $dt > $date_to)   return false;
        return true;
    }));
}
if ($owner_id)  $deals = array_values(array_filter($deals, fn($d)=>($d['user']['_id']??'')===$owner_id));
if ($stage_flt) $deals = array_values(array_filter($deals, fn($d)=>($d['deal_stage_id']??'')===$stage_flt));

// ── Status ───────────────────────────────────────────────────
$won  = array_values(array_filter($deals, fn($d)=>($d['win']??null)===true));
$lost = array_values(array_filter($deals, fn($d)=>($d['win']??null)===false && isset($d['win'])));
$open = array_values(array_filter($deals, fn($d)=>!isset($d['win'])||$d['win']===null));

// ── Contagem ACUMULADA por etapa ─────────────────────────────
// Um deal em Negociação (pos 5) conta em todas as etapas 0..5
// Exclui Fechado Ganho e Fechado Perdido da contagem acumulada
$funil_visual = [];
$funil_expectativa = []; // valor esperado por etapa
foreach ($stages_ordered as $sid => $sdata) {
    $spos = $stage_position[$sid];
    // Pular etapas de fechamento na contagem acumulada
    if ($sid === $sid_ganho || $sid === $sid_perdido) {
        $cnt = count(in_stage($deals, $sid));
        $val = esc_sum(in_stage($deals, $sid));
    } else {
        // Conta todos os deals em aberto cuja etapa atual >= esta posição
        $cnt = count(array_filter($open, fn($d) => ($stage_position[$d['deal_stage_id']??''] ?? -1) >= $spos));
        $val = esc_sum(array_filter($open, fn($d) => ($stage_position[$d['deal_stage_id']??''] ?? -1) >= $spos));
    }
    $funil_visual[]     = ['stage'=>$sdata['name'], 'count'=>$cnt, 'value'=>round($val,2)];
    $funil_expectativa[]= ['stage'=>$sdata['name'], 'count'=>$cnt, 'value'=>round($val,2)];
}

// ── KPIs acumulados das etapas chave ─────────────────────────
$cnt_agendados  = count(array_filter($open, fn($d)=>($stage_position[$d['deal_stage_id']??'']??-1)>=$pos_agendada));
$cnt_realizados = count(array_filter($open, fn($d)=>($stage_position[$d['deal_stage_id']??'']??-1)>=$pos_realizada));
$cnt_negociacao = count(array_filter($open, fn($d)=>($stage_position[$d['deal_stage_id']??'']??-1)>=$pos_negociacao));

$val_negociacao = esc_sum(array_filter($open, fn($d)=>($stage_position[$d['deal_stage_id']??'']??-1)>=$pos_negociacao));
$val_pipeline   = esc_sum($open);

// ── Por origem ───────────────────────────────────────────────
$by_origin = [];
foreach ($deals as $d) {
    $src_id = $d['deal_source']['_id'] ?? '';
    $origin = map_origin($source_map[$src_id] ?? ($d['deal_source']['name'] ?? ''));
    if (!isset($by_origin[$origin])) $by_origin[$origin]=['leads'=>0,'won'=>0,'revenue'=>0];
    $by_origin[$origin]['leads']++;
    if (($d['win']??null)===true) { $by_origin[$origin]['won']++; $by_origin[$origin]['revenue']+=deal_value($d); }
}

// ── Por responsável ──────────────────────────────────────────
$by_owner = [];
foreach ($deals as $d) {
    $name = $d['user']['name'] ?? 'Desconhecido';
    if (!isset($by_owner[$name])) $by_owner[$name]=['total'=>0,'won'=>0,'lost'=>0,'revenue'=>0];
    $by_owner[$name]['total']++;
    if (($d['win']??null)===true)  { $by_owner[$name]['won']++;  $by_owner[$name]['revenue']+=deal_value($d); }
    if (($d['win']??null)===false && isset($d['win'])) $by_owner[$name]['lost']++;
}
foreach ($by_owner as &$o) $o['conv']=esc_pct($o['won'],$o['total']);
unset($o);

// ── Por etapa atual (snapshot real, não acumulado) ───────────
$by_stage_real = [];
foreach ($deals as $d) {
    $sid  = $d['deal_stage_id'] ?? '';
    $name = $stages_ordered[$sid]['name'] ?? 'Sem etapa';
    if (!isset($by_stage_real[$name])) $by_stage_real[$name]=['count'=>0,'value'=>0];
    $by_stage_real[$name]['count']++;
    $by_stage_real[$name]['value'] += deal_value($d);
}

// ── Perda por etapa ──────────────────────────────────────────
$perda = [];
foreach ($lost as $d) {
    $sid  = $d['deal_stage_id'] ?? '';
    $name = $stages_ordered[$sid]['name'] ?? 'Sem etapa';
    $perda[$name] = ($perda[$name]??0)+1;
}
arsort($perda);

// ── Insights ─────────────────────────────────────────────────
$receita = esc_sum($won);
$qtd_won = count($won);
$leads_total = count($deals);

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

// ── Marketing ────────────────────────────────────────────────
$today   = date('Y-m-d');
$mes_ini = date('Y-m-01');
$mkt_funnel = mkt('/platform/analytics/conversion_funnel');
$leads_hoje = mkt('/platform/contacts/search?page=1&page_size=1&created_at_from='.$today.'T00:00:00&created_at_to='.$today.'T23:59:59');
$leads_mes  = mkt('/platform/contacts/search?page=1&page_size=1&created_at_from='.$mes_ini.'T00:00:00&created_at_to='.$today.'T23:59:59');

// ── Resposta ─────────────────────────────────────────────────
$stages_simple = [];
foreach ($stages_ordered as $sid => $s) $stages_simple[$sid] = $s['name'];

echo json_encode([
    'meta' => [
        'pipeline_id' => PIPELINE_ID,
        'total_deals' => count($deals),
        'stages'      => $stages_simple,
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
        'agendamentos'       => $cnt_agendados,
        'reunioes_ocorridas' => $cnt_realizados,
        'em_negociacao'      => $cnt_negociacao,
        'valor_negociacao'   => round($val_negociacao, 2),
        'pipeline_aberto'    => round($val_pipeline, 2),
        'won'                => $qtd_won,
        'lost'               => count($lost),
        'open'               => count($open),
    ],
    'conversao' => [
        'presenca_reuniao'    => esc_pct($cnt_realizados, $cnt_agendados),
        'reuniao_para_venda'  => esc_pct($qtd_won, $cnt_realizados),
        'negociacao_para_venda'=> esc_pct($qtd_won, $cnt_negociacao),
        'lead_para_venda'     => esc_pct($qtd_won, $leads_total),
    ],
    'financeiro' => [
        'receita_fechada'    => round($receita, 2),
        'ticket_medio'       => $qtd_won>0 ? round($receita/$qtd_won,2) : 0,
        'receita_por_origem' => array_map(fn($o)=>round($o['revenue'],2), $by_origin),
        'expectativa_pipeline'=> $funil_expectativa,
    ],
    'funil_visual'    => $funil_visual,
    'por_origem'      => $by_origin,
    'por_responsavel' => $by_owner,
    'por_etapa_real'  => $by_stage_real,
    'perda_por_etapa' => $perda,
    'marketing'       => ['funnel' => $mkt_funnel],
    'insights' => [
        'melhor_canal_leads'    => $cl,
        'melhor_canal_vendas'   => $cv,
        'melhor_canal_receita'  => $cr,
        'melhor_vendedor'       => $melhor_vendedor,
        'melhor_vendedor_conv'  => $max_conv,
        'etapa_maior_perda'     => array_key_first($perda),
        'perda_por_etapa'       => $perda,
        'valor_pipeline_aberto' => round($val_pipeline,2),
        'valor_em_negociacao'   => round($val_negociacao,2),
    ],
    'filtros_disponiveis' => [
        'users'   => $users,
        'stages'  => $stages_simple,
        'origens' => ['WhatsApp','Site','RD Station','Instagram','Indicação','Evento','Outros'],
    ],
], JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
