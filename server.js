const http = require('http');
const https = require('https');

const CRM_TOKEN  = '6a3be3a4c81c68001e67ea0a';
const MKT_TOKEN  = '745467e98d2287fcdd41eb572722b0c9';
const PIPELINE_ID = '6a3c2697d2d223001fa3f0ad';
const PORT = process.env.PORT || 3000;

// Etapas fixas (ordem real do CRM)
const STAGES = [
  { id: '6a3c2697d2d223001fa3f0af', name: 'Novo Lead',            order: 1 },
  { id: '6a3c2697d2d223001fa3f0b0', name: 'Qualificação',         order: 2 },
  { id: '6a3c2697d2d223001fa3f0b1', name: 'Agendamento Realizado',order: 3 },
  { id: '6a3c2697d2d223001fa3f0b2', name: 'Reunião Realizada',    order: 4 },
  { id: '6a3c2dfc1afd75001e199a2d', name: 'Negociação',           order: 5 },
  { id: '6a3c2dff80f293001ef244bc', name: 'Fechado Ganho',        order: 6 },
  { id: '6a3c2e038c080c001f52f8e6', name: 'Fechado Perdido',      order: 7 },
];

const STAGE_POS  = {};  // id => order (1-based)
const STAGE_NAME = {};  // id => name
const STAGE_MAP  = {};  // name_lower => id
STAGES.forEach(s => {
  STAGE_POS[s.id]  = s.order;
  STAGE_NAME[s.id] = s.name;
  STAGE_MAP[s.name.toLowerCase()] = s.id;
});

const SID_AGEND  = '6a3c2697d2d223001fa3f0b1'; // Agendamento Realizado (order 3)
const SID_REUN   = '6a3c2697d2d223001fa3f0b2'; // Reunião Realizada (order 4)
const SID_NEGOC  = '6a3c2dfc1afd75001e199a2d'; // Negociação (order 5)
const SID_GANHO  = '6a3c2dff80f293001ef244bc'; // Fechado Ganho (order 6)
const SID_PERDIDO= '6a3c2e038c080c001f52f8e6'; // Fechado Perdido (order 7)

const POS_AGEND  = STAGE_POS[SID_AGEND];   // 3
const POS_REUN   = STAGE_POS[SID_REUN];    // 4
const POS_NEGOC  = STAGE_POS[SID_NEGOC];   // 5

// ── HTTP helpers ─────────────────────────────────────────────
function get(url) {
  return new Promise((resolve) => {
    https.get(url, { headers: { 'Accept': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    }).on('error', () => resolve(null));
  });
}

// API v2 CRM — usa Bearer token
function crmV2(path) {
  const sep = path.includes('?') ? '&' : '?';
  const url = `https://api.rd.services/api/v2${path}${sep}token=${CRM_TOKEN}`;
  return get(url);
}

function mkt(path) {
  const sep = path.includes('?') ? '&' : '?';
  return get(`https://api.rd.services${path}${sep}token=${MKT_TOKEN}`);
}

// Busca todos os deals do pipeline via API v2
async function allDeals() {
  const all = [];
  let page = 1;
  while (true) {
    const res = await crmV2(`/deals?filter=pipeline_id:${PIPELINE_ID}&page[number]=${page}&page[size]=50`);
    const data = res?.data || [];
    all.push(...data);
    // Verifica se há mais páginas
    if (!res?.links?.next || data.length === 0 || page >= 10) break;
    page++;
  }
  return all;
}

// Busca usuários via API v2
async function getUsers() {
  const res = await crmV2('/users?page[size]=50');
  const users = {};
  (res?.data || []).forEach(u => users[u.id] = u.name);
  return users;
}

// Busca sources via API v2
async function getSources() {
  const res = await crmV2('/sources?page[size]=50');
  const map = {};
  (res?.data || []).forEach(s => map[s.id] = s.name);
  return map;
}

function mapOrigin(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('whatsapp') || n.includes('zap'))  return 'WhatsApp';
  if (n.includes('site') || n.includes('web'))       return 'Site';
  if (n.includes('rd') || n.includes('formu') || n.includes('landing')) return 'RD Station';
  if (n.includes('instagram') || n.includes('insta')) return 'Instagram';
  if (n.includes('indica'))  return 'Indicação';
  if (n.includes('evento'))  return 'Evento';
  return 'Outros';
}

function dealVal(d)   { return parseFloat(d.total_price || 0); }
function pct(a, b)    { return b > 0 ? Math.round((a/b)*1000)/10 : 0; }
function sumArr(arr)  { return arr.reduce((s, d) => s + dealVal(d), 0); }
function stagePos(d)  { return STAGE_POS[d.stage_id] ?? -1; }

async function buildData(params) {
  const [deals, users, sourceMap] = await Promise.all([
    allDeals(), getUsers(), getSources()
  ]);

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
  if (params.owner_id)  filtered = filtered.filter(d => d.owner_id === params.owner_id);
  if (params.stage_id)  filtered = filtered.filter(d => d.stage_id === params.stage_id);

  // Status — API v2 usa status: 'won', 'lost', 'ongoing'
  const won  = filtered.filter(d => d.status === 'won');
  const lost = filtered.filter(d => d.status === 'lost');
  const open = filtered.filter(d => d.status === 'ongoing');

  // Contagem acumulada — deals em aberto que chegaram até essa etapa ou além
  const cntAgend = open.filter(d => stagePos(d) >= POS_AGEND).length;
  const cntReun  = open.filter(d => stagePos(d) >= POS_REUN).length;
  const cntNegoc = open.filter(d => stagePos(d) >= POS_NEGOC).length;
  const valNegoc = sumArr(open.filter(d => stagePos(d) >= POS_NEGOC));
  const valPipe  = sumArr(open);

  // Funil visual com valor por etapa
  const funnelVisual = STAGES.map(s => {
    let cnt, val;
    if (s.id === SID_GANHO || s.id === SID_PERDIDO) {
      const arr = filtered.filter(d => d.stage_id === s.id);
      cnt = arr.length; val = sumArr(arr);
    } else {
      const arr = open.filter(d => stagePos(d) >= s.order);
      cnt = arr.length; val = sumArr(arr);
    }
    return { stage: s.name, count: cnt, value: Math.round(val*100)/100 };
  });

  // Por origem
  const byOrigin = {};
  filtered.forEach(d => {
    const origin = mapOrigin(sourceMap[d.source_id] || '');
    if (!byOrigin[origin]) byOrigin[origin] = { leads:0, won:0, revenue:0 };
    byOrigin[origin].leads++;
    if (d.status === 'won') { byOrigin[origin].won++; byOrigin[origin].revenue += dealVal(d); }
  });

  // Por responsável
  const byOwner = {};
  filtered.forEach(d => {
    const name = users[d.owner_id] || 'Desconhecido';
    if (!byOwner[name]) byOwner[name] = { total:0, won:0, lost:0, revenue:0, conv:0 };
    byOwner[name].total++;
    if (d.status === 'won')  { byOwner[name].won++;  byOwner[name].revenue += dealVal(d); }
    if (d.status === 'lost') byOwner[name].lost++;
  });
  Object.values(byOwner).forEach(o => o.conv = pct(o.won, o.total));

  // Perda por etapa
  const perda = {};
  lost.forEach(d => {
    const name = STAGE_NAME[d.stage_id] || 'Sem etapa';
    perda[name] = (perda[name] || 0) + 1;
  });

  // Insights
  let cl=null,cv=null,cr=null,mL=-1,mV=-1,mR=-1;
  Object.entries(byOrigin).forEach(([k,v]) => {
    if(v.leads>mL){mL=v.leads;cl=k;}
    if(v.won>mV){mV=v.won;cv=k;}
    if(v.revenue>mR){mR=v.revenue;cr=k;}
  });
  let bestV=null,bestC=-1;
  Object.entries(byOwner).forEach(([n,o]) => {
    if(o.total>=2&&o.conv>bestC){bestC=o.conv;bestV=n;}
  });

  // Marketing
  const today  = new Date().toISOString().slice(0,10);
  const mesIni = today.slice(0,8)+'01';
  const [mktFunnel, leadsHoje, leadsMes] = await Promise.all([
    mkt('/platform/analytics/conversion_funnel'),
    mkt(`/platform/contacts/search?page=1&page_size=1&created_at_from=${today}T00:00:00&created_at_to=${today}T23:59:59`),
    mkt(`/platform/contacts/search?page=1&page_size=1&created_at_from=${mesIni}T00:00:00&created_at_to=${today}T23:59:59`),
  ]);

  const receita = sumArr(won);
  const qtdWon  = won.length;
  const stagesSimple = {};
  STAGES.forEach(s => stagesSimple[s.id] = s.name);

  return {
    meta: { pipeline_id: PIPELINE_ID, total_deals: filtered.length, stages: stagesSimple, users, gerado_em: new Date().toISOString() },
    captacao: {
      leads_whatsapp: byOrigin['WhatsApp']?.leads   || 0,
      leads_rd:       byOrigin['RD Station']?.leads || 0,
      leads_site:     byOrigin['Site']?.leads       || 0,
      leads_total:    filtered.length,
      leads_hoje:     leadsHoje?.total || 0,
      leads_mes:      leadsMes?.total  || 0,
    },
    comercial: {
      agendamentos:       cntAgend,
      reunioes_ocorridas: cntReun,
      em_negociacao:      cntNegoc,
      valor_negociacao:   Math.round(valNegoc*100)/100,
      pipeline_aberto:    Math.round(valPipe*100)/100,
      won: qtdWon, lost: lost.length, open: open.length,
    },
    conversao: {
      presenca_reuniao:      pct(cntReun,  cntAgend),
      reuniao_para_venda:    pct(qtdWon,   cntReun),
      negociacao_para_venda: pct(qtdWon,   cntNegoc),
      lead_para_venda:       pct(qtdWon,   filtered.length),
    },
    financeiro: {
      receita_fechada:    Math.round(receita*100)/100,
      ticket_medio:       qtdWon>0 ? Math.round(receita/qtdWon*100)/100 : 0,
      receita_por_origem: Object.fromEntries(Object.entries(byOrigin).map(([k,v])=>[k,Math.round(v.revenue*100)/100])),
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
      melhor_vendedor:       bestV,
      melhor_vendedor_conv:  bestC,
      etapa_maior_perda:     Object.keys(perda).sort((a,b)=>perda[b]-perda[a])[0]||null,
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
  const url = new URL(req.url, 'http://localhost');
  const params = Object.fromEntries(url.searchParams);
  try {
    const data = await buildData(params);
    res.writeHead(200);
    res.end(JSON.stringify(data, null, 2));
  } catch(e) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: e.message }));
  }
});

server.listen(PORT, () => console.log(`ESC Dashboard API rodando na porta ${PORT}`));
