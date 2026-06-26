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

function v1(path, params = {}) {
  let url = `https://crm.rdstation.com/api/v1${path}?token=${CRM_TOKEN}`;
  Object.entries(params).forEach(([k, v]) => url += `&${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  return get(url);
}

function mkt(path) {
  const sep = path.includes('?') ? '&' : '?';
  return get(`https://api.rd.services${path}${sep}token=${MKT_TOKEN}`);
}

async function allDeals() {
  const all = [];
  let page = 1;
  while (page <= 10) {
    const res = await v1('/deals', { deal_pipeline_id: PIPELINE_ID, page, limit: 50, order: 'updated_at', direction: 'desc' });
    const data = res?.deals || [];
    const total = res?.total || 0;
    console.log(`Página ${page}: ${data.length} deals (total: ${total})`);
    all.push(...data);
    if (all.length >= total || data.length === 0) break;
    page++;
  }
  console.log(`Total carregado: ${all.length}`);
  return all;
}

async function fetchNotesForDeals(dealIds) {
  // Busca notas de todos os deals em paralelo (máx 10 simultâneas)
  const results = {};
  const chunks = [];
  for (let i = 0; i < dealIds.length; i += 10)
    chunks.push(dealIds.slice(i, i + 10));

  for (const chunk of chunks) {
    await Promise.all(chunk.map(async id => {
      const url = `https://api.rd.services/crm/v2/deals/${id}/notes?page[size]=50&token=${CRM_TOKEN}`;
      const res = await get(url);
      results[id] = res?.data || [];
    }));
  }
  return results;
}

async function getUsers() {
  const res = await v1('/users', { limit: 50 });
  const u = {};
  (res?.users || []).forEach(x => u[x._id] = x.name);
  return u;
}

async function getSources() {
  const res = await v1('/deal_sources', { limit: 50 });
  const m = {};
  (res?.deal_sources || []).forEach(x => m[x._id] = x.name);
  return m;
}

function mapOrigin(name) {
  const n = (name || '').toLowerCase();
  // Redes Sociais — tudo que é Social | X (orgânico)
  if (n.startsWith('social'))                                         return 'Redes Sociais';
  // Tráfego Pago — Busca Paga | X
  if (n.startsWith('busca paga') || n.includes('paid'))              return 'Tráfego Pago';
  // Busca Orgânica — Busca Orgânica | X
  if (n.startsWith('busca org') || n.includes('org\u00e2nica') || n.includes('organica')) return 'Busca Orgânica';
  // E-mail — Email | X
  if (n.startsWith('email') || n.includes('e-mail'))                 return 'E-mail';
  // Referência — Referência | site
  if (n.startsWith('refer') || n.includes('refer\u00eancia'))       return 'Referência';
  // Indicação
  if (n.includes('indica'))                                          return 'Indicação';
  // Evento / Feiras
  if (n.includes('evento') || n.includes('feira'))                   return 'Evento';
  // Prospecção Ativa
  if (n.includes('prospec') || n.includes('ativa'))                  return 'Prospecção Ativa';
  // Cliente Ativo
  if (n.includes('cliente ativo'))                                   return 'Cliente Ativo';
  // WhatsApp (caso usado como origem)
  if (n.includes('whatsapp') || n.includes('zap'))                   return 'WhatsApp';
  // Tudo mais → Outros
  return 'Outros';
}

// API v1 campos corretos (confirmados nos logs):
// stage: deal_stage._id
// valor: amount_total
// status: win (true=ganho, false=perdido, null=aberto)
// dono: user._id
// fonte: deal_source._id

const stageId = d => d.deal_stage?._id || null;
const val     = d => parseFloat(d.amount_total || d.amount_montly || 0);
const isWon   = d => d.win === true;
const isLost  = d => d.win === false;
const isOpen  = d => d.win === null || d.win === undefined;
const sOrd    = d => STAGE_ORDER[stageId(d)] ?? -1;
const pct     = (a,b) => b > 0 ? Math.round((a/b)*1000)/10 : 0;
const sum     = arr => arr.reduce((s,d) => s + val(d), 0);

async function buildData(p) {
  const [deals, users, sources] = await Promise.all([allDeals(), getUsers(), getSources()]);

  if (deals.length > 0) {
    const d = deals[0];
    console.log(`Deal[0]: stage=${stageId(d)} ord=${sOrd(d)} val=${val(d)} win=${d.win}`);
  }

  // Buscar notas de todos os deals do funil
  const dealIds = deals.map(d => d.id);
  const notesMap = await fetchNotesForDeals(dealIds);

  // Interações = deals com pelo menos 1 nota cuja última anotação foi no mês/hoje
  const today2   = new Date().toISOString().slice(0, 10);
  const mesIni2  = today2.slice(0, 8) + '01';

  let interacoesMes  = 0;
  let interacoesHoje = 0;

  for (const [dealId, notes] of Object.entries(notesMap)) {
    if (!notes.length) continue;
    // Última anotação (já vem ordenada desc)
    const lastNote = notes[0];
    const lastDate = (lastNote.registered_at || lastNote.created_at || '').slice(0, 10);
    if (lastDate >= mesIni2)  interacoesMes++;
    if (lastDate === today2)  interacoesHoje++;
  }

  console.log(`Interações hoje: ${interacoesHoje} | mês: ${interacoesMes}`);

  let f = [...deals];
  if (p.date_from || p.date_to) {
    f = f.filter(d => {
      const dt = (d.created_at||'').slice(0,10);
      if (p.date_from && dt < p.date_from) return false;
      if (p.date_to   && dt > p.date_to)   return false;
      return true;
    });
  }
  if (p.owner_id) f = f.filter(d => (d.user?._id) === p.owner_id);
  if (p.stage_id) f = f.filter(d => stageId(d) === p.stage_id);

  const won  = f.filter(isWon);
  const lost = f.filter(isLost);
  const open = f.filter(isOpen);

  console.log(`won:${won.length} lost:${lost.length} open:${open.length}`);
  console.log('Open stages:', open.map(d=>`${d.name}:${STAGE_NAME[stageId(d)]||'?'}:ord${sOrd(d)}:R$${val(d)}`).join(' | '));

  const cntAgend = open.filter(d => sOrd(d) >= POS_AGEND).length;
  const cntReun  = open.filter(d => sOrd(d) >= POS_REUN).length;
  const cntNegoc = open.filter(d => sOrd(d) >= POS_NEGOC).length;
  const valNegoc = sum(open.filter(d => sOrd(d) >= POS_NEGOC));
  const valPipe  = sum(open);

  // Funil snapshot real — mostra onde cada deal está agora
  const funnel = STAGES.map(s => {
    const arr = f.filter(d => stageId(d) === s.id);
    return { stage: s.name, count: arr.length, value: Math.round(sum(arr)*100)/100 };
  });

  console.log('Funil:', funnel.map(x=>`${x.stage}:${x.count}:R$${x.value}`).join(', '));

  const byOrigin = {};
  f.forEach(d => {
    const origin = mapOrigin(sources[d.deal_source?._id] || d.deal_source?.name || '');
    if (!byOrigin[origin]) byOrigin[origin] = { leads:0, won:0, revenue:0 };
    byOrigin[origin].leads++;
    if (isWon(d)) { byOrigin[origin].won++; byOrigin[origin].revenue += val(d); }
  });

  const byOwner = {};
  f.forEach(d => {
    const name = d.user?.name || users[d.user?._id] || 'Desconhecido';
    if (!byOwner[name]) byOwner[name] = { total:0, won:0, lost:0, revenue:0, conv:0 };
    byOwner[name].total++;
    if (isWon(d))  { byOwner[name].won++;  byOwner[name].revenue += val(d); }
    if (isLost(d)) byOwner[name].lost++;
  });
  Object.values(byOwner).forEach(o => o.conv = pct(o.won, o.total));

  const perda = {};
  lost.forEach(d => {
    const name = STAGE_NAME[stageId(d)] || 'Sem etapa';
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
  // Leads hoje e mês — conta deals criados no pipeline no período
  const allDealsHoje = f.filter(d => (d.created_at||'').slice(0,10) === today);
  const allDealsMes  = f.filter(d => (d.created_at||'').slice(0,10) >= mesIni);
  const leadsHoje = { total: allDealsHoje.length };
  const leadsMes  = { total: allDealsMes.length  };
  const [mktFunnel] = await Promise.all([
    mkt('/platform/analytics/conversion_funnel'),
  ]);

  const receita = sum(won), qtdWon = won.length;

  return {
    meta: { pipeline_id: PIPELINE_ID, total_deals: f.length, stages: STAGES_SIMPLE, users, gerado_em: new Date().toISOString() },
    captacao: {
      leads_whatsapp: byOrigin['WhatsApp']?.leads    || 0,
      leads_rd:       byOrigin['RD Station']?.leads  || 0,
      leads_site:     byOrigin['Site']?.leads        || 0,
      leads_total: f.length, leads_hoje: leadsHoje?.total||0, leads_mes: leadsMes?.total||0,
      interacoes_mes:  interacoesMes,
      interacoes_hoje: interacoesHoje,
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
// patch
