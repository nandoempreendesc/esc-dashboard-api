const http = require('http');
const https = require('https');

const CRM_TOKEN   = '6a3be3a4c81c68001e67ea0a';
const MKT_TOKEN   = '745467e98d2287fcdd41eb572722b0c9';
const PIPELINE_ID = '6a3c2697d2d223001fa3f0ad';
const PORT = process.env.PORT || 3000;

const STAGES = [
  { id: '6a3c2697d2d223001fa3f0af', name: 'Novo Lead',             order: 1 },
  { id: '6a3c2697d2d223001fa3f0b0', name: 'Qualificação',          order: 2 },
  { id: '6a3c2697d2d223001fa3f0b1', name: 'Agendamento Realizado', order: 3 },
  { id: '6a3c2697d2d223001fa3f0b2', name: 'Reunião Realizada',     order: 4 },
  { id: '6a3c2dfc1afd75001e199a2d', name: 'Negociação',            order: 5 },
  { id: '6a3c2dff80f293001ef244bc', name: 'Fechado Ganho',         order: 6 },
  { id: '6a3c2e038c080c001f52f8e6', name: 'Fechado Perdido',       order: 7 },
];

const STAGE_ORDER = {};
const STAGE_NAME  = {};
STAGES.forEach(s => { STAGE_ORDER[s.id] = s.order; STAGE_NAME[s.id] = s.name; });

const SID_GANHO   = '6a3c2dff80f293001ef244bc';
const SID_PERDIDO = '6a3c2e038c080c001f52f8e6';
const POS_AGEND = 3, POS_REUN = 4, POS_NEGOC = 5;

function httpsGet(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { 'Accept': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(25000, () => { req.destroy(); resolve(null); });
  });
}

function crmUrl(path, params = {}) {
  let url = `https://crm.rdstation.com/api/v1${path}?token=${CRM_TOKEN}`;
  Object.entries(params).forEach(([k, v]) => url += `&${k}=${v}`);
  return url;
}

function mktUrl(path) {
  const sep = path.includes('?') ? '&' : '?';
  return `https://api.rd.services${path}${sep}token=${MKT_TOKEN}`;
}

async function allDeals() {
  const all = [];
  let page = 1;
  while (page <= 10) {
    const res = await httpsGet(crmUrl('/deals', {
      deal_pipeline_id: PIPELINE_ID, page, limit: 50,
      order: 'updated_at', direction: 'desc'
    }));
    const data = res?.deals || [];
    const total = res?.total || 0;
    if (page === 1 && data.length > 0) {
      // Log completo do primeiro deal para descobrir os campos corretos
      console.log('DEAL COMPLETO:', JSON.stringify(data[0]));
    }
    all.push(...data);
    if (all.length >= total || data.length === 0) break;
    page++;
  }
  return all;
}

async function getUsers() {
  const res = await httpsGet(crmUrl('/users', { limit: 50 }));
  const users = {};
  (res?.users || []).forEach(u => users[u._id] = u.name);
  return users;
}

async function getSources() {
  const res = await httpsGet(crmUrl('/deal_sources', { limit: 50 }));
  const map = {};
  (res?.deal_sources || []).forEach(s => map[s._id] = s.name);
  return map;
}

function mapOrigin(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('whatsapp') || n.includes('zap'))    return 'WhatsApp';
  if (n.includes('site') || n.includes('web'))         return 'Site';
  if (n.includes('rd') || n.includes('formu') || n.includes('landing')) return 'RD Station';
  if (n.includes('instagram') || n.includes('insta'))  return 'Instagram';
  if (n.includes('indica')) return 'Indicação';
  if (n.includes('evento')) return 'Evento';
  return 'Outros';
}

// Extrai stage_id de qualquer campo possível
function getStageId(d) {
  return d.deal_stage_id || d.stage_id || d.deal_stage?._id || d.stage?._id
    || d.deal_stages?.[0]?._id || null;
}

// Extrai valor de qualquer campo possível  
function getDealVal(d) {
  return parseFloat(d.amount_montly_total || d.amount || d.total_price
    || d.value || d.price || 0);
}

// Extrai status
function isWon(d)  { return d.win === true  || d.status === 'won'; }
function isLost(d) { return d.win === false && (d.win !== null) && d.win !== undefined || d.status === 'lost'; }
function isOpen(d) { return !isWon(d) && !isLost(d); }

function pct(a, b)   { return b > 0 ? Math.round((a/b)*1000)/10 : 0; }
function sumArr(arr) { return arr.reduce((s,d) => s + getDealVal(d), 0); }
function stageOrd(d) { return STAGE_ORDER[getStageId(d)] ?? -1; }

async function buildData(params) {
  const [deals, users, sourceMap] = await Promise.all([allDeals(), getUsers(), getSources()]);

  console.log(`Total deals: ${deals.length}`);
  if (deals.length > 0) {
    const d = deals[0];
    console.log('stage_id tentativas:', {
      deal_stage_id: d.deal_stage_id,
      stage_id: d.stage_id,
      deal_stage: d.deal_stage,
      stage: d.stage,
      getStageId: getStageId(d),
    });
    console.log('valor tentativas:', {
      amount_montly_total: d.amount_montly_total,
      amount: d.amount,
      total_price: d.total_price,
      value: d.value,
    });
    console.log('win/status:', { win: d.win, status: d.status });
  }

  let filtered = [...deals];
  if (params.date_from || params.date_to) {
    filtered = filtered.filter(d => {
      const dt = (d.created_at || '').slice(0, 10);
      if (params.date_from && dt < params.date_from) return false;
      if (params.date_to   && dt > params.date_to)   return false;
      return true;
    });
  }
  if (params.owner_id) filtered = filtered.filter(d => (d.user?._id || d.user_id || d.owner_id) === params.owner_id);
  if (params.stage_id) filtered = filtered.filter(d => getStageId(d) === params.stage_id);

  const won  = filtered.filter(isWon);
  const lost = filtered.filter(isLost);
  const open = filtered.filter(isOpen);

  console.log(`won:${won.length} lost:${lost.length} open:${open.length}`);

  const cntAgend = open.filter(d => stageOrd(d) >= POS_AGEND).length;
  const cntReun  = open.filter(d => stageOrd(d) >= POS_REUN).length;
  const cntNegoc = open.filter(d => stageOrd(d) >= POS_NEGOC).length;
  const valNegoc = sumArr(open.filter(d => stageOrd(d) >= POS_NEGOC));
  const valPipe  = sumArr(open);

  const funnelVisual = STAGES.map(s => {
    let cnt, val;
    if (s.id === SID_GANHO || s.id === SID_PERDIDO) {
      const arr = filtered.filter(d => getStageId(d) === s.id);
      cnt = arr.length; val = sumArr(arr);
    } else {
      const arr = open.filter(d => stageOrd(d) >= s.order);
      cnt = arr.length; val = sumArr(arr);
    }
    return { stage: s.name, count: cnt, value: Math.round(val*100)/100 };
  });

  const byOrigin = {};
  filtered.forEach(d => {
    const srcId = d.deal_source?._id || d.deal_source_id || d.source_id || '';
    const srcName = sourceMap[srcId] || d.deal_source?.name || '';
    const origin = mapOrigin(srcName);
    if (!byOrigin[origin]) byOrigin[origin] = { leads:0, won:0, revenue:0 };
    byOrigin[origin].leads++;
    if (isWon(d)) { byOrigin[origin].won++; byOrigin[origin].revenue += getDealVal(d); }
  });

  const byOwner = {};
  filtered.forEach(d => {
    const name = d.user?.name || users[d.user?._id || d.user_id] || 'Desconhecido';
    if (!byOwner[name]) byOwner[name] = { total:0, won:0, lost:0, revenue:0, conv:0 };
    byOwner[name].total++;
    if (isWon(d))  { byOwner[name].won++;  byOwner[name].revenue += getDealVal(d); }
    if (isLost(d)) byOwner[name].lost++;
  });
  Object.values(byOwner).forEach(o => o.conv = pct(o.won, o.total));

  const perda = {};
  lost.forEach(d => {
    const name = STAGE_NAME[getStageId(d)] || 'Sem etapa';
    perda[name] = (perda[name] || 0) + 1;
  });

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

  const today  = new Date().toISOString().slice(0,10);
  const mesIni = today.slice(0,8)+'01';
  const [mktFunnel, leadsHoje, leadsMes] = await Promise.all([
    httpsGet(mktUrl('/platform/analytics/conversion_funnel')),
    httpsGet(mktUrl(`/platform/contacts/search?page=1&page_size=1&created_at_from=${today}T00:00:00&created_at_to=${today}T23:59:59`)),
    httpsGet(mktUrl(`/platform/contacts/search?page=1&page_size=1&created_at_from=${mesIni}T00:00:00&created_at_to=${today}T23:59:59`)),
  ]);

  const receita = sumArr(won);
  const qtdWon  = won.length;
  const stagesSimple = {};
  STAGES.forEach(s => stagesSimple[s.id] = s.name);

  return {
    meta: { pipeline_id: PIPELINE_ID, total_deals: filtered.length, stages: stagesSimple, users, gerado_em: new Date().toISOString() },
    captacao: {
      leads_whatsapp: byOrigin['WhatsApp']?.leads    || 0,
      leads_rd:       byOrigin['RD Station']?.leads  || 0,
      leads_site:     byOrigin['Site']?.leads        || 0,
      leads_total: filtered.length,
      leads_hoje:  leadsHoje?.total || 0,
      leads_mes:   leadsMes?.total  || 0,
    },
    comercial: {
      agendamentos: cntAgend, reunioes_ocorridas: cntReun,
      em_negociacao: cntNegoc, valor_negociacao: Math.round(valNegoc*100)/100,
      pipeline_aberto: Math.round(valPipe*100)/100,
      won: qtdWon, lost: lost.length, open: open.length,
    },
    conversao: {
      presenca_reuniao:      pct(cntReun,  cntAgend),
      reuniao_para_venda:    pct(qtdWon,   cntReun),
      negociacao_para_venda: pct(qtdWon,   cntNegoc),
      lead_para_venda:       pct(qtdWon,   filtered.length),
    },
    financeiro: {
      receita_fechada: Math.round(receita*100)/100,
      ticket_medio:    qtdWon>0 ? Math.round(receita/qtdWon*100)/100 : 0,
      receita_por_origem: Object.fromEntries(Object.entries(byOrigin).map(([k,v])=>[k,Math.round(v.revenue*100)/100])),
    },
    funil_visual: funnelVisual, por_origem: byOrigin, por_responsavel: byOwner,
    perda_por_etapa: perda, marketing: { funnel: mktFunnel },
    insights: {
      melhor_canal_leads: cl, melhor_canal_vendas: cv, melhor_canal_receita: cr,
      melhor_vendedor: bestV, melhor_vendedor_conv: bestC,
      etapa_maior_perda: Object.keys(perda).sort((a,b)=>perda[b]-perda[a])[0]||null,
      perda_por_etapa: perda,
    },
    filtros_disponiveis: { users, stages: stagesSimple,
      origens: ['WhatsApp','Site','RD Station','Instagram','Indicação','Evento','Outros'] },
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
    console.error('Erro:', e);
    res.writeHead(500);
    res.end(JSON.stringify({ error: e.message }));
  }
});

server.listen(PORT, () => console.log(`ESC Dashboard API rodando na porta ${PORT}`));
