const http  = require('http');
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

const STAGE_ORDER = {}, STAGE_NAME = {}, STAGES_SIMPLE = {};
STAGES.forEach(s => {
  STAGE_ORDER[s.id] = s.order;
  STAGE_NAME[s.id]  = s.name;
  STAGES_SIMPLE[s.id] = s.name;
});

const SID_GANHO   = '6a3c2dff80f293001ef244bc';
const SID_PERDIDO = '6a3c2e038c080c001f52f8e6';
const POS_AGEND = 3, POS_REUN = 4, POS_NEGOC = 5;

function get(url) {
  return new Promise(resolve => {
    const req = https.get(url, { headers: { Accept: 'application/json' } }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(25000, () => { req.destroy(); resolve(null); });
  });
}

// API v2 — URL manual para preservar ":" no filter
function crm2(path) {
  const sep = path.includes('?') ? '&' : '?';
  return get(`https://api.rd.services/api/v2${path}${sep}token=${CRM_TOKEN}`);
}

function mkt(path) {
  const sep = path.includes('?') ? '&' : '?';
  return get(`https://api.rd.services${path}${sep}token=${MKT_TOKEN}`);
}

async function allDeals() {
  const all = [];
  let page = 1;
  while (page <= 10) {
    // URL montada manualmente — preserva ":" sem encoding
    const url = `https://api.rd.services/api/v2/deals?filter=pipeline_id:${PIPELINE_ID}&page[number]=${page}&page[size]=50&token=${CRM_TOKEN}`;
    const res = await get(url);
    const data = res?.data || [];
    console.log(`Página ${page}: ${data.length} deals`);
    all.push(...data);
    if (data.length < 50) break;
    page++;
  }
  console.log(`Total: ${all.length}`);
  return all;
}

async function getUsers() {
  const res = await get(`https://api.rd.services/api/v2/users?page[size]=50&token=${CRM_TOKEN}`);
  const u = {};
  (res?.data || []).forEach(x => u[x.id] = x.name);
  return u;
}

async function getSources() {
  const res = await get(`https://api.rd.services/api/v2/sources?page[size]=50&token=${CRM_TOKEN}`);
  const m = {};
  (res?.data || []).forEach(x => m[x.id] = x.name);
  return m;
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

// API v2: total_price, status, stage_id, owner_id, source_id
const val  = d  => parseFloat(d.total_price || 0);
const pct  = (a,b) => b > 0 ? Math.round((a/b)*1000)/10 : 0;
const sum  = arr => arr.reduce((s,d) => s + val(d), 0);
const sOrd = d  => STAGE_ORDER[d.stage_id] ?? -1;

async function buildData(p) {
  const [deals, users, sources] = await Promise.all([allDeals(), getUsers(), getSources()]);

  let f = [...deals];
  if (p.date_from || p.date_to) {
    f = f.filter(d => {
      const dt = (d.created_at||'').slice(0,10);
      if (p.date_from && dt < p.date_from) return false;
      if (p.date_to   && dt > p.date_to)   return false;
      return true;
    });
  }
  if (p.owner_id) f = f.filter(d => d.owner_id === p.owner_id);
  if (p.stage_id) f = f.filter(d => d.stage_id === p.stage_id);

  const won  = f.filter(d => d.status === 'won');
  const lost = f.filter(d => d.status === 'lost');
  const open = f.filter(d => d.status === 'ongoing');

  console.log(`won:${won.length} lost:${lost.length} open:${open.length}`);
  console.log('Etapas+valores:', open.map(d=>`${d.name}:${STAGE_NAME[d.stage_id]||'?'}:R$${val(d)}`).join(' | '));

  const cntAgend = open.filter(d => sOrd(d) >= POS_AGEND).length;
  const cntReun  = open.filter(d => sOrd(d) >= POS_REUN).length;
  const cntNegoc = open.filter(d => sOrd(d) >= POS_NEGOC).length;
  const valNegoc = sum(open.filter(d => sOrd(d) >= POS_NEGOC));
  const valPipe  = sum(open);

  const funnel = STAGES.map(s => {
    let cnt, v;
    if (s.id === SID_GANHO || s.id === SID_PERDIDO) {
      const arr = f.filter(d => d.stage_id === s.id);
      cnt = arr.length; v = sum(arr);
    } else {
      const arr = open.filter(d => sOrd(d) >= s.order);
      cnt = arr.length; v = sum(arr);
    }
    return { stage: s.name, count: cnt, value: Math.round(v*100)/100 };
  });

  const byOrigin = {};
  f.forEach(d => {
    const origin = mapOrigin(sources[d.source_id] || '');
    if (!byOrigin[origin]) byOrigin[origin] = { leads:0, won:0, revenue:0 };
    byOrigin[origin].leads++;
    if (d.status==='won') { byOrigin[origin].won++; byOrigin[origin].revenue += val(d); }
  });

  const byOwner = {};
  f.forEach(d => {
    const name = users[d.owner_id] || 'Desconhecido';
    if (!byOwner[name]) byOwner[name] = { total:0, won:0, lost:0, revenue:0, conv:0 };
    byOwner[name].total++;
    if (d.status==='won')  { byOwner[name].won++;  byOwner[name].revenue += val(d); }
    if (d.status==='lost') byOwner[name].lost++;
  });
  Object.values(byOwner).forEach(o => o.conv = pct(o.won, o.total));

  const perda = {};
  lost.forEach(d => {
    const name = STAGE_NAME[d.stage_id] || 'Sem etapa';
    perda[name] = (perda[name]||0)+1;
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
    mkt('/platform/analytics/conversion_funnel'),
    mkt(`/platform/contacts/search?page=1&page_size=1&created_at_from=${today}T00:00:00&created_at_to=${today}T23:59:59`),
    mkt(`/platform/contacts/search?page=1&page_size=1&created_at_from=${mesIni}T00:00:00&created_at_to=${today}T23:59:59`),
  ]);

  const receita = sum(won), qtdWon = won.length;

  return {
    meta: { pipeline_id: PIPELINE_ID, total_deals: f.length, stages: STAGES_SIMPLE, users, gerado_em: new Date().toISOString() },
    captacao: {
      leads_whatsapp: byOrigin['WhatsApp']?.leads    || 0,
      leads_rd:       byOrigin['RD Station']?.leads  || 0,
      leads_site:     byOrigin['Site']?.leads        || 0,
      leads_total: f.length, leads_hoje: leadsHoje?.total||0, leads_mes: leadsMes?.total||0,
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
      lead_para_venda:       pct(qtdWon,   f.length),
    },
    financeiro: {
      receita_fechada: Math.round(receita*100)/100,
      ticket_medio: qtdWon>0 ? Math.round(receita/qtdWon*100)/100 : 0,
      receita_por_origem: Object.fromEntries(Object.entries(byOrigin).map(([k,v])=>[k,Math.round(v.revenue*100)/100])),
    },
    funil_visual: funnel, por_origem: byOrigin, por_responsavel: byOwner,
    perda_por_etapa: perda, marketing: { funnel: mktFunnel },
    insights: {
      melhor_canal_leads: cl, melhor_canal_vendas: cv, melhor_canal_receita: cr,
      melhor_vendedor: bestV, melhor_vendedor_conv: bestC,
      etapa_maior_perda: Object.keys(perda).sort((a,b)=>perda[b]-perda[a])[0]||null,
      perda_por_etapa: perda,
    },
    filtros_disponiveis: { users, stages: STAGES_SIMPLE,
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
  try {
    const data = await buildData(Object.fromEntries(url.searchParams));
    res.writeHead(200);
    res.end(JSON.stringify(data, null, 2));
  } catch(e) {
    console.error(e);
    res.writeHead(500);
    res.end(JSON.stringify({ error: e.message }));
  }
});

server.listen(PORT, () => console.log(`ESC Dashboard API na porta ${PORT}`));
