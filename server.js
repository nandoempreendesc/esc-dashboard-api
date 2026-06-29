const http  = require('http');
const https = require('https');
const fs    = require('fs');

const CRM_TOKEN    = '6a3be3a4c81c68001e67ea0a';
const MKT_TOKEN    = '745467e98d2287fcdd41eb572722b0c9';
const PIPELINE_ID  = '6a3c2697d2d223001fa3f0ad';
const CLIENT_ID    = '68f5d893-7f2d-4b61-a264-9d9defd408ec';
const CLIENT_SECRET= '4be61bcbcc6a49cf9ef14ccd5f7f2a66';
const CALLBACK_URL = 'https://esc-dashboard-api.onrender.com/callback';
const TOKEN_FILE   = '/tmp/oauth_tokens.json';
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

const POS_AGEND = 3, POS_REUN = 4, POS_NEGOC = 5;

// ── OAuth tokens em memória ──────────────────────────────────
let oauthTokens = null;
try {
  if (fs.existsSync(TOKEN_FILE)) {
    oauthTokens = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    console.log('OAuth tokens carregados do arquivo');
  }
} catch(e) { console.log('Sem tokens OAuth salvos'); }

function saveTokens(tokens) {
  oauthTokens = tokens;
  try { fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens)); } catch(e) {}
}

// ── HTTP helpers ─────────────────────────────────────────────
function get(url, headers = {}) {
  return new Promise(resolve => {
    const req = https.get(url, { headers: { Accept: 'application/json', ...headers } }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(25000, () => { req.destroy(); resolve(null); });
  });
}

function post(url, body, headers = {}) {
  return new Promise(resolve => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers }
    };
    const req = https.request(options, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.write(data);
    req.end();
  });
}

// ── OAuth ────────────────────────────────────────────────────
async function refreshAccessToken() {
  if (!oauthTokens?.refresh_token) return null;
  const res = await post('https://api.rd.services/auth/token', {
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: oauthTokens.refresh_token,
    grant_type:    'refresh_token'
  });
  if (res?.access_token) {
    saveTokens({ ...oauthTokens, ...res });
    console.log('Access token renovado com sucesso');
    return res.access_token;
  }
  console.log('Erro ao renovar access token:', JSON.stringify(res));
  return null;
}

async function getAccessToken() {
  if (!oauthTokens) return null;
  // Renovar se expirado ou próximo de expirar
  const expiry = oauthTokens.expires_at || 0;
  if (Date.now() > expiry - 60000) {
    return await refreshAccessToken();
  }
  return oauthTokens.access_token;
}

async function exchangeCode(code) {
  const res = await post('https://api.rd.services/auth/token', {
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri:  CALLBACK_URL,
    code,
    grant_type: 'authorization_code'
  });
  if (res?.access_token) {
    saveTokens({
      access_token:  res.access_token,
      refresh_token: res.refresh_token,
      expires_at:    Date.now() + (res.expires_in || 3600) * 1000
    });
    console.log('OAuth autorizado com sucesso!');
    return true;
  }
  console.log('Erro ao trocar código:', JSON.stringify(res));
  return false;
}

// ── API helpers ──────────────────────────────────────────────
function v1(path, params = {}) {
  let url = `https://crm.rdstation.com/api/v1${path}?token=${CRM_TOKEN}`;
  Object.entries(params).forEach(([k, v]) => url += `&${k}=${encodeURIComponent(v)}`);
  return get(url);
}

function mkt(path) {
  const sep = path.includes('?') ? '&' : '?';
  return get(`https://api.rd.services${path}${sep}token=${MKT_TOKEN}`);
}

async function getWithOAuth(url) {
  const token = await getAccessToken();
  if (!token) return null;
  return get(url, { Authorization: `Bearer ${token}` });
}

// ── Deals ────────────────────────────────────────────────────
async function allDeals() {
  const all = [];
  let page = 1;
  while (page <= 10) {
    const res = await v1('/deals', {
      deal_pipeline_id: PIPELINE_ID,
      page, limit: 50,
      order: 'updated_at', direction: 'desc'
    });
    const data = res?.deals || [];
    const total = res?.total || 0;
    console.log(`Página ${page}: ${data.length} deals (total: ${total})`);
    all.push(...data);
    if (all.length >= total || data.length === 0) break;
    page++;
  }
  console.log(`Total: ${all.length}`);
  return all;
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

// ── Busca IDs v2 para os deals da v1 ────────────────────────
async function getDealIdsV2(token) {
  // Busca todos os deals via API v2 para obter os IDs corretos
  const idMap = {}; // name => id_v2
  let page = 1;
  while (page <= 10) {
    const url = `https://api.rd.services/api/v2/deals?filter=pipeline_id:${PIPELINE_ID}&page[number]=${page}&page[size]=50`;
    const res = await get(url, { Authorization: `Bearer ${token}` });
    const data = res?.data || [];
    data.forEach(d => { idMap[d.name] = d.id; });
    if (data.length < 50) break;
    page++;
  }
  console.log(`IDs v2 mapeados: ${Object.keys(idMap).length}`);
  return idMap;
}

// ── Notas via OAuth ──────────────────────────────────────────
async function fetchNotesForDeals(deals) {
  const token = await getAccessToken();
  if (!token) {
    console.log('Sem OAuth — usando updated_at como fallback');
    return null;
  }

  // Mapear IDs v2 pelos nomes dos deals
  const idMapV2 = await getDealIdsV2(token);

  const results = {};
  const chunks = [];
  for (let i = 0; i < deals.length; i += 5)
    chunks.push(deals.slice(i, i + 5));

  for (const chunk of chunks) {
    await Promise.all(chunk.map(async d => {
      // Usa ID v2 pelo nome do deal
      const id = idMapV2[d.name] || d._id;
      if (!id) return;
      const url = `https://api.rd.services/api/v2/deals/${id}/notes?page[size]=5&sort[registered_at]=desc`;
      const res = await get(url, { Authorization: `Bearer ${token}` });
      const notes = res?.data || [];
      if (notes.length > 0) console.log(`Nota: deal=${d.name?.slice(0,20)} date=${(notes[0].registered_at||'').slice(0,10)}`);
      results[d._id || id] = notes;
    }));
  }
  const comNotas = Object.values(results).filter(n=>n.length>0).length;
  console.log(`Deals com notas: ${comNotas}/${deals.length}`);
  return results;
}

function mapOrigin(name) {
  const n = (name || '').toLowerCase();
  if (n.startsWith('social'))                                         return 'Redes Sociais';
  if (n.startsWith('busca paga') || n.includes('paid'))              return 'Tráfego Pago';
  if (n.startsWith('busca org') || n.includes('orgânica') || n.includes('organica')) return 'Busca Orgânica';
  if (n.startsWith('email') || n.includes('e-mail'))                 return 'E-mail';
  if (n.startsWith('refer') || n.includes('referência'))             return 'Referência';
  if (n.includes('indica'))                                          return 'Indicação';
  if (n.includes('evento') || n.includes('feira'))                   return 'Evento';
  if (n.includes('prospec') || n.includes('ativa'))                  return 'Prospecção Ativa';
  if (n.includes('cliente ativo'))                                   return 'Cliente Ativo';
  if (n.includes('whatsapp') || n.includes('zap'))                   return 'WhatsApp';
  return 'Outros';
}

const stageId = d => d.deal_stage?._id || null;
const val     = d => parseFloat(d.amount_total || d.amount_montly || 0);
const isWon   = d => d.win === true;
const isLost  = d => d.win === false && d.win !== null && d.win !== undefined;
const isOpen  = d => !isWon(d) && !isLost(d);
const sOrd    = d => STAGE_ORDER[stageId(d)] ?? -1;
const pct     = (a, b) => b > 0 ? Math.round((a/b)*1000)/10 : 0;
const sum     = arr => arr.reduce((s, d) => s + val(d), 0);

async function buildData(p) {
  const [deals, users, sources] = await Promise.all([allDeals(), getUsers(), getSources()]);

  if (deals.length > 0) {
    const d = deals[0];
    console.log(`Deal[0]: stage=${stageId(d)} ord=${sOrd(d)} val=${val(d)} win=${d.win}`);
  }

  // Notas via OAuth (ou fallback updated_at)
  const notesMap = await fetchNotesForDeals(deals);
  const today2  = new Date().toISOString().slice(0, 10);
  const mesIni2 = today2.slice(0, 8) + '01';
  let interacoesMes = 0, interacoesHoje = 0;

  if (notesMap) {
    for (const notes of Object.values(notesMap)) {
      if (!notes.length) continue;
      const lastDate = (notes[0].registered_at || '').slice(0, 10);
      if (lastDate >= mesIni2) interacoesMes++;
      if (lastDate === today2) interacoesHoje++;
    }
  } else {
    for (const d of deals) {
      const updated = (d.updated_at || '').slice(0, 10);
      if (updated >= mesIni2) interacoesMes++;
      if (updated === today2) interacoesHoje++;
    }
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

  const cntAgend = open.filter(d => sOrd(d) >= POS_AGEND).length;
  const cntReun  = open.filter(d => sOrd(d) >= POS_REUN).length;
  const cntNegoc = open.filter(d => sOrd(d) >= POS_NEGOC).length;
  const valNegoc = sum(open.filter(d => sOrd(d) >= POS_NEGOC));
  const valPipe  = sum(open);

  const funnel = STAGES.map(s => {
    const arr = f.filter(d => stageId(d) === s.id);
    return { stage: s.name, count: arr.length, value: Math.round(sum(arr)*100)/100 };
  });

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
  const allDealsHoje = f.filter(d => (d.created_at||'').slice(0,10) === today);
  const allDealsMes  = f.filter(d => (d.created_at||'').slice(0,10) >= mesIni);
  const [mktFunnel] = await Promise.all([mkt('/platform/analytics/conversion_funnel')]);

  const receita = sum(won), qtdWon = won.length;

  return {
    meta: { pipeline_id: PIPELINE_ID, total_deals: f.length, stages: STAGES_SIMPLE, users, gerado_em: new Date().toISOString(), oauth_ativo: !!oauthTokens },
    captacao: {
      leads_total: f.length, leads_hoje: allDealsHoje.length, leads_mes: allDealsMes.length,
      interacoes_mes: interacoesMes, interacoes_hoje: interacoesHoje,
      leads_whatsapp: byOrigin['WhatsApp']?.leads || 0,
      leads_rd: byOrigin['RD Station']?.leads || 0,
      leads_site: byOrigin['Site']?.leads || 0,
    },
    comercial: {
      agendamentos: cntAgend, reunioes_ocorridas: cntReun,
      em_negociacao: cntNegoc, valor_negociacao: Math.round(valNegoc*100)/100,
      pipeline_aberto: Math.round(valPipe*100)/100,
      won: qtdWon, lost: lost.length, open: open.length,
    },
    conversao: {
      presenca_reuniao: pct(cntReun, cntAgend),
      reuniao_para_venda: pct(qtdWon, cntReun),
      negociacao_para_venda: pct(qtdWon, cntNegoc),
      lead_para_venda: pct(qtdWon, f.length),
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
    },
    filtros_disponiveis: { users, stages: STAGES_SIMPLE,
      origens: ['WhatsApp','Site','RD Station','Instagram','Indicação','Evento','Outros'] },
  };
}

// ── Servidor HTTP ────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const url = new URL(req.url, `http://localhost`);

  // Rota de callback OAuth
  if (url.pathname === '/callback') {
    const code = url.searchParams.get('code');
    if (code) {
      const ok = await exchangeCode(code);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.writeHead(200);
      res.end(ok
        ? '<h2>✅ OAuth autorizado com sucesso! Pode fechar esta janela.</h2>'
        : '<h2>❌ Erro ao autorizar. Tente novamente.</h2>'
      );
    } else {
      res.writeHead(400);
      res.end('Código não encontrado');
    }
    return;
  }

  // Rota de status OAuth
  if (url.pathname === '/oauth-status') {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    res.end(JSON.stringify({ oauth_ativo: !!oauthTokens, expires_at: oauthTokens?.expires_at }));
    return;
  }

  // Rota principal
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
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

server.listen(PORT, () => {
  console.log(`ESC Dashboard API na porta ${PORT}`);
  if (!oauthTokens) {
    const authUrl = `https://api.rd.services/auth/dialog?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(CALLBACK_URL)}&response_type=code`;
    console.log(`\n⚠️  OAuth não configurado! Acesse para autorizar:\n${authUrl}\n`);
  } else {
    console.log('✅ OAuth ativo — notas serão buscadas via API');
  }
});
