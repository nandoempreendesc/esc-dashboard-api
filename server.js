const http = require('http');
const https = require('https');

const CRM_TOKEN = '6a3be3a4c81c68001e67ea0a';
const MKT_TOKEN = '745467e98d2287fcdd41eb572722b0c9';
const PIPELINE_ID = '6a3c2697d2d223001fa3f0ad';
const PORT = process.env.PORT || 3000;

function get(url) {
  return new Promise((resolve) => {
    https.get(url, { headers: { 'Accept': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    }).on('error', () => resolve(null));
  });
}

function crm(path) {
  const sep = path.includes('?') ? '&' : '?';
  return get(`https://crm.rdstation.com/api/v1${path}${sep}token=${CRM_TOKEN}`);
}

function mkt(path) {
  const sep = path.includes('?') ? '&' : '?';
  return get(`https://api.rd.services${path}${sep}token=${MKT_TOKEN}`);
}

async function allDeals(pipelineId) {
  let all = [], page = 1;
  while (true) {
    const res = await crm(`/deals?deal_pipeline_id=${pipelineId}&page=${page}&limit=50&order=updated_at&direction=desc`);
    const deals = res?.deals || [];
    all = all.concat(deals);
    if (all.length >= (res?.total || 0) || deals.length === 0 || page >= 10) break;
    page++;
  }
  return all;
}

function mapOrigin(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('whatsapp') || n.includes('zap')) return 'WhatsApp';
  if (n.includes('site') || n.includes('web')) return 'Site';
  if (n.includes('rd') || n.includes('formu') || n.includes('landing')) return 'RD Station';
  if (n.includes('instagram') || n.includes('insta')) return 'Instagram';
  if (n.includes('indica')) return 'Indicação';
  if (n.includes('evento')) return 'Evento';
  return 'Outros';
}

function dealValue(d) { return parseFloat(d.amount_montly_total || d.amount || 0); }
function pct(a, b) { return b > 0 ? Math.round((a / b) * 1000) / 10 : 0; }
function sumDeals(arr) { return arr.reduce((s, d) => s + dealValue(d), 0); }

async function buildData(params) {
  const [stagesRaw, usersRaw, sourcesRaw, deals] = await Promise.all([
    crm(`/deal_stages?deal_pipeline_id=${PIPELINE_ID}&limit=50`),
    crm(`/users?limit=50`),
    crm(`/deal_sources?limit=50`),
    allDeals(PIPELINE_ID),
  ]);

  // Ordenar etapas — tentar múltiplos campos de posição
  const stagesArr = (stagesRaw?.deal_stages || []).sort((a, b) => {
    const posA = a._position ?? a.position ?? a.order ?? 0;
    const posB = b._position ?? b.position ?? b.order ?? 0;
    return posA - posB;
  });

  // Mapas de etapas
  const stages = {};       // id => name
  const stagePos = {};     // id => index (0,1,2...)
  const stageIdMap = {};   // name_lower => id

  stagesArr.forEach((s, i) => {
    stages[s._id] = s.name;
    stagePos[s._id] = i;
    stageIdMap[s.name.toLowerCase().trim()] = s._id;
  });

  // Log de debug
  console.log('Etapas encontradas:', stagesArr.map(s => `${s.name}(pos:${stagePos[s._id]})`).join(', '));
  console.log('Total deals:', deals.length);
  if (deals.length > 0) {
    console.log('Exemplo deal stage_id:', deals[0].deal_stage_id, '-> pos:', stagePos[deals[0].deal_stage_id]);
  }

  const users = {};
  (usersRaw?.users || []).forEach(u => users[u._id] = u.name);

  const sourceMap = {};
  (sourcesRaw?.deal_sources || []).forEach(s => sourceMap[s._id] = s.name);

  // Encontrar etapas chave por nome
  function findStage(keywords) {
    for (const kw of keywords)
      for (const [name, id] of Object.entries(stageIdMap))
        if (name.includes(kw.toLowerCase())) return id;
    return null;
  }

  const sidAgendada  = findStage(['agendamento realizado', 'agendamento', 'agendada', 'agend']);
  const sidRealizada = findStage(['reunião realizada', 'realizada', 'realiz']);
  const sidNegoc     = findStage(['negociação', 'negociacao', 'negoc']);
  const sidGanho     = findStage(['fechado ganho', 'ganho']);
  const sidPerdido   = findStage(['fechado perdido', 'perdido']);

  const posAgendada  = stagePos[sidAgendada]  ?? 999;
  const posRealizada = stagePos[sidRealizada] ?? 999;
  const posNegoc     = stagePos[sidNegoc]     ?? 999;

  console.log('Etapas chave - agendada:', sidAgendada, 'pos:', posAgendada);
  console.log('Etapas chave - realizada:', sidRealizada, 'pos:', posRealizada);
  console.log('Etapas chave - negoc:', sidNegoc, 'pos:', posNegoc);

  // Filtros
  let filtered = [...deals];
  if (params.date_from || params.date_to) {
    filtered = filtered.filter(d => {
      const dt = (d.created_at || '').slice(0, 10);
      if (params.date_from && dt < params.date_from) return false;
      if (params.date_to   && dt > params.date_to)   return false;
      return true;
    });
  }
  if (params.owner_id) filtered = filtered.filter(d => (d.user?._id || '') === params.owner_id);
  if (params.stage_id) filtered = filtered.filter(d => (d.deal_stage_id || '') === params.stage_id);

  // Status — API v1 usa win: true/false/null
  const won  = filtered.filter(d => d.win === true);
  const lost = filtered.filter(d => d.win === false && 'win' in d);
  const open = filtered.filter(d => !('win' in d) || d.win === null);

  console.log('won:', won.length, 'lost:', lost.length, 'open:', open.length);

  // Posição de cada deal em aberto
  const getPos = d => {
    const pos = stagePos[d.deal_stage_id];
    return pos !== undefined ? pos : -1;
  };

  // Contagem acumulada — deals que chegaram até essa etapa ou além
  const cntAgend  = open.filter(d => getPos(d) >= posAgendada).length;
  const cntReal   = open.filter(d => getPos(d) >= posRealizada).length;
  const cntNegoc  = open.filter(d => getPos(d) >= posNegoc).length;
  const valNegoc  = sumDeals(open.filter(d => getPos(d) >= posNegoc));
  const valPipe   = sumDeals(open);

  // Funil visual — para cada etapa conta deals em aberto nessa posição ou acima
  const funnelVisual = stagesArr.map(s => {
    const sid  = s._id;
    const spos = stagePos[sid];
    let cnt, val;
    if (sid === sidGanho || sid === sidPerdido) {
      const arr = filtered.filter(d => d.deal_stage_id === sid);
      cnt = arr.length;
      val = sumDeals(arr);
    } else {
      const arr = open.filter(d => getPos(d) >= spos);
      cnt = arr.length;
      val = sumDeals(arr);
    }
    return { stage: s.name, count: cnt, value: Math.round(val * 100) / 100 };
  });

  console.log('Funil visual:', funnelVisual.map(f => `${f.stage}:${f.count}`).join(', '));

  // Por origem
  const byOrigin = {};
  filtered.forEach(d => {
    const srcName = sourceMap[d.deal_source?._id || ''] || d.deal_source?.name || '';
    const origin = mapOrigin(srcName);
    if (!byOrigin[origin]) byOrigin[origin] = { leads: 0, won: 0, revenue: 0 };
    byOrigin[origin].leads++;
    if (d.win === true) { byOrigin[origin].won++; byOrigin[origin].revenue += dealValue(d); }
  });

  // Por responsável
  const byOwner = {};
  filtered.forEach(d => {
    const name = d.user?.name || 'Desconhecido';
    if (!byOwner[name]) byOwner[name] = { total: 0, won: 0, lost: 0, revenue: 0, conv: 0 };
    byOwner[name].total++;
    if (d.win === true)  { byOwner[name].won++;  byOwner[name].revenue += dealValue(d); }
    if (d.win === false && 'win' in d) byOwner[name].lost++;
  });
  Object.values(byOwner).forEach(o => o.conv = pct(o.won, o.total));

  // Perda por etapa
  const perda = {};
  lost.forEach(d => {
    const name = stages[d.deal_stage_id] || 'Sem etapa';
    perda[name] = (perda[name] || 0) + 1;
  });

  // Insights
  let cl = null, cv = null, cr = null, maxL = -1, maxV = -1, maxR = -1;
  Object.entries(byOrigin).forEach(([k, v]) => {
    if (v.leads > maxL)   { maxL = v.leads;   cl = k; }
    if (v.won > maxV)     { maxV = v.won;     cv = k; }
    if (v.revenue > maxR) { maxR = v.revenue; cr = k; }
  });
  let bestVendedor = null, bestConv = -1;
  Object.entries(byOwner).forEach(([name, o]) => {
    if (o.total >= 2 && o.conv > bestConv) { bestConv = o.conv; bestVendedor = name; }
  });

  // Marketing
  const today  = new Date().toISOString().slice(0, 10);
  const mesIni = today.slice(0, 8) + '01';
  const [mktFunnel, leadsHoje, leadsMes] = await Promise.all([
    mkt('/platform/analytics/conversion_funnel'),
    mkt(`/platform/contacts/search?page=1&page_size=1&created_at_from=${today}T00:00:00&created_at_to=${today}T23:59:59`),
    mkt(`/platform/contacts/search?page=1&page_size=1&created_at_from=${mesIni}T00:00:00&created_at_to=${today}T23:59:59`),
  ]);

  const receita = sumDeals(won);
  const qtdWon  = won.length;
  const stagesSimple = {};
  stagesArr.forEach(s => stagesSimple[s._id] = s.name);

  return {
    meta: {
      pipeline_id: PIPELINE_ID,
      total_deals: filtered.length,
      stages: stagesSimple,
      users,
      gerado_em: new Date().toISOString(),
      debug: {
        total_raw: deals.length,
        open: open.length,
        pos_agendada: posAgendada,
        pos_realizada: posRealizada,
        pos_negoc: posNegoc,
        deals_stages: deals.map(d => ({ id: d._id?.slice(-6), stage_id: d.deal_stage_id?.slice(-6), pos: getPos(d), win: d.win }))
      }
    },
    captacao: {
      leads_whatsapp: byOrigin['WhatsApp']?.leads   || 0,
      leads_rd:       byOrigin['RD Station']?.leads || 0,
      leads_site:     byOrigin['Site']?.leads       || 0,
      leads_total: filtered.length,
      leads_hoje:  leadsHoje?.total  || 0,
      leads_mes:   leadsMes?.total   || 0,
    },
    comercial: {
      agendamentos:       cntAgend,
      reunioes_ocorridas: cntReal,
      em_negociacao:      cntNegoc,
      valor_negociacao:   Math.round(valNegoc * 100) / 100,
      pipeline_aberto:    Math.round(valPipe * 100) / 100,
      won: qtdWon, lost: lost.length, open: open.length,
    },
    conversao: {
      presenca_reuniao:      pct(cntReal,  cntAgend),
      reuniao_para_venda:    pct(qtdWon,   cntReal),
      negociacao_para_venda: pct(qtdWon,   cntNegoc),
      lead_para_venda:       pct(qtdWon,   filtered.length),
    },
    financeiro: {
      receita_fechada: Math.round(receita * 100) / 100,
      ticket_medio:    qtdWon > 0 ? Math.round(receita / qtdWon * 100) / 100 : 0,
      receita_por_origem: Object.fromEntries(Object.entries(byOrigin).map(([k, v]) => [k, Math.round(v.revenue * 100) / 100])),
    },
    funil_visual:    funnelVisual,
    por_origem:      byOrigin,
    por_responsavel: byOwner,
    perda_por_etapa: perda,
    marketing:       { funnel: mktFunnel },
    insights: {
      melhor_canal_leads:    cl,
      melhor_canal_vendas:   cv,
      melhor_canal_receita:  cr,
      melhor_vendedor:       bestVendedor,
      melhor_vendedor_conv:  bestConv,
      etapa_maior_perda:     Object.keys(perda).sort((a, b) => perda[b] - perda[a])[0] || null,
      perda_por_etapa:       perda,
    },
    filtros_disponiveis: {
      users, stages: stagesSimple,
      origens: ['WhatsApp','Site','RD Station','Instagram','Indicação','Evento','Outros'],
    },
  };
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const url = new URL(req.url, `http://localhost`);
  const params = Object.fromEntries(url.searchParams);

  try {
    const data = await buildData(params);
    res.writeHead(200);
    res.end(JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Erro:', e);
    res.writeHead(500);
    res.end(JSON.stringify({ error: e.message }));
  }
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
