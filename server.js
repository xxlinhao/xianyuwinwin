const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const STOCKS = [
  // target: 人工目标补仓价（null = 不再使用硬编码，改由布林下轨动态计算）
  // bollMode: 'auto' 用布林下轨，'manual' 用上面的 target
  { name: '中国平安', code: '601318', market: '1', divPerShare: 2.70, target: null, bollMode: 'auto', role: '周期弹性' },
  { name: '招商银行', code: '600036', market: '1', divPerShare: 2.016, target: null, bollMode: 'auto', role: '稳定底仓' },
  { name: '格力电器', code: '000651', market: '0', divPerShare: 3.00, target: null, bollMode: 'auto', role: '高股息' },
  { name: '中国移动', code: '600941', market: '1', divPerShare: 4.70, target: null, bollMode: 'auto', role: '波动缓冲' },
];

// ═══ 布林带参数 ═══
const BOLL_N = 20;        // 中轨周期：20日简单均线
const BOLL_K = 2;         // 标准差倍数：上下轨默认 2σ
const BOLL_LOOKBACK = 40; // 拉取日K条数（多拉一些备用）
const BOLL_MIN_BARS = 20; // 少于该条数无法计算

const POSITIONS = {
  '601318': { shares: 1000, cost: 50.88 },
  '600036': { shares: 700, cost: 36.41 },
  '000651': { shares: 500, cost: 39.38 },
  '600941': { shares: 0, cost: 0 },
};

const DIVIDEND_CALENDAR = [
  { stock: '格力电器', type: '年报', date: '2026-08', per10: 20 },
  { stock: '中国移动', type: '年报', date: '2026-09', per10: 22 },
  { stock: '中国平安', type: '中报', date: '2026-10', per10: 9.5 },
  { stock: '招商银行', type: '中报', date: '2027-01', per10: 10 },
];

function fetchStock(secid) {
  return new Promise((resolve, reject) => {
    const url = 'https://push2.eastmoney.com/api/qt/stock/get?secid=' + secid +
      '&fields=f43,f44,f45,f46,f48,f50,f60,f162,f167,f116,f169&invt=2&fltt=2';
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Referer': 'https://quote.eastmoney.com/',
      }
    }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    // 关键：无超时会导致单个挂起请求阻塞整轮刷新
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('stock timeout')); });
  });
}

// 带重试的行情快照（网络抖动时自动重试）
async function fetchStockRetry(secid, times) {
  times = times || 2;
  let last;
  for (let i = 0; i < times; i++) {
    try {
      const r = await fetchStock(secid);
      if (r && r.data && r.data.f43) return r;
      last = new Error('empty data');
    } catch (e) {
      last = e;
    }
    if (i < times - 1) await new Promise(function (s) { setTimeout(s, 400); });
  }
  throw last || new Error('fetch failed');
}

// ═══ 腾讯行情快照（备源）═══
// 一次可批量拉多只；字段以 ~ 分隔。返回结构与东财对齐：{data:{f43,f60,f44,f45,f46,f48,f162,f167,f116,f169}}
function fetchQuoteTencent(symbols) {
  return new Promise((resolve, reject) => {
    const url = 'https://qt.gtimg.cn/q=' + symbols.join(',');
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Referer': 'https://gu.qq.com/',
      },
    }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        try {
          // 腾讯返回 GBK 编码，需转 UTF-8
          const text = new TextDecoder('gbk').decode(Buffer.concat(chunks));
          const out = {};
          text.split(';').forEach(function (line) {
            const m = line.match(/v_(\w+)="([^"]*)"/);
            if (!m) return;
            const f = m[2].split('~');
            const code = f[2];
            if (!code) return;
            out[code] = {
              code: code,
              name: f[1],
              price: parseFloat(f[3]) || 0,
              prevClose: parseFloat(f[4]) || 0,
              open: parseFloat(f[5]) || 0,
              high: parseFloat(f[33]) || 0,
              low: parseFloat(f[34]) || 0,
              changePct: parseFloat(f[32]) || 0,
              change: parseFloat(f[31]) || 0,
              volume: parseFloat(f[6]) || 0,
              amount: (parseFloat(f[37]) || 0) * 1e4, // 万元 → 元
              pe: parseFloat(f[39]) || 0,
              pb: parseFloat(f[46]) || 0,
              marketCap: parseFloat(f[45]) || 0,      // 亿元，与东财口径一致
              time: f[30],
            };
          });
          resolve(out);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(9000, () => { req.destroy(); reject(new Error('tencent quote timeout')); });
  });
}

// ═══ 日K拉取（多源回退：东财 → 腾讯 → 新浪）═══
// 说明：东财 push2his 为原始首选；部分网络环境会拦截该域名，
//       故自动降级到腾讯/新浪，保证布林带始终可算。
function httpGetJson(url, timeout) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Referer': 'https://quote.eastmoney.com/',
      },
    }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('parse fail: ' + body.slice(0, 120))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeout || 10000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// 把 '1.601318' / '0.000001' 转成 'sh601318' / 'sz000001'
function toTxSymbol(secid) {
  const p = secid.split('.');
  return (p[0] === '1' ? 'sh' : 'sz') + p[1];
}

// 源1：东方财富（原始首选）
async function klineEastmoney(secid, lmt) {
  const url = 'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=' + secid +
    '&fields1=f1,f2,f3,f4,f5,f6' +
    '&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61' +
    '&klt=101&fqt=1&end=20500101&lmt=' + (lmt || BOLL_LOOKBACK);
  const j = await httpGetJson(url);
  const d = j && j.data;
  if (!d || !d.klines || !d.klines.length) throw new Error('em empty');
  return {
    source: 'eastmoney',
    name: d.name,
    date: d.klines[d.klines.length - 1].split(',')[0],
    closes: d.klines.map(function (line) { return parseFloat(line.split(',')[2]); }),
  };
}

// 源2：腾讯（前复权 qfqday）
async function klineTencent(secid, lmt) {
  const sym = toTxSymbol(secid);
  const url = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=' +
    sym + ',day,,,' + (lmt || BOLL_LOOKBACK) + ',qfq';
  const j = await httpGetJson(url);
  const d = j && j.data && j.data[sym];
  if (!d) throw new Error('tx empty');
  const arr = d.qfqday || d.day;
  if (!arr || !arr.length) throw new Error('tx no klines');
  return {
    source: 'tencent',
    name: d.qt ? (d.qt[sym] && d.qt[sym][1]) : secid,
    date: arr[arr.length - 1][0],
    closes: arr.map(function (row) { return parseFloat(row[2]); }),
  };
}

// 源3：新浪（不复权，作最后兜底）
async function klineSina(secid, lmt) {
  const sym = toTxSymbol(secid);
  const url = 'https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/' +
    'CN_MarketData.getKLineData?symbol=' + sym + '&scale=240&ma=no&datalen=' + (lmt || BOLL_LOOKBACK);
  const j = await httpGetJson(url);
  if (!Array.isArray(j) || !j.length) throw new Error('sina empty');
  return {
    source: 'sina',
    name: secid,
    date: j[j.length - 1].day,
    closes: j.map(function (row) { return parseFloat(row.close); }),
  };
}

// 依次尝试，任一成功即返回
async function fetchCloses(secid, lmt) {
  const sources = [klineEastmoney, klineTencent, klineSina];
  const errs = [];
  for (const fn of sources) {
    try {
      const r = await fn(secid, lmt);
      if (r.closes && r.closes.length >= BOLL_MIN_BARS) return r;
      errs.push(fn.name + ': only ' + (r.closes ? r.closes.length : 0) + ' bars');
    } catch (e) {
      errs.push(fn.name + ': ' + e.message);
    }
  }
  throw new Error('all sources failed → ' + errs.join(' | '));
}

// ═══ 布林带计算 ═══
// 中轨 = N日简单均线(MA20)
// σ    = 总体标准差 sqrt( Σ(收盘 − 中轨)² / N )
// 上轨 = 中轨 + Kσ ；下轨 = 中轨 − Kσ
function calcBoll(closes, n, k) {
  n = n || BOLL_N; k = k || BOLL_K;
  if (!closes || closes.length < n) return null;
  const win = closes.slice(-n);
  const ma = win.reduce((a, b) => a + b, 0) / n;
  const variance = win.reduce((a, b) => a + (b - ma) * (b - ma), 0) / n;
  const sd = Math.sqrt(variance);
  return {
    ma: ma,
    sd: sd,
    upper: ma + k * sd,
    lower: ma - k * sd,
    n: n,
    k: k,
    bars: closes.length,
    // 带宽（上下轨间距占中轨百分比），衡量波动率大小
    width: ma > 0 ? (2 * k * sd / ma * 100) : 0,
    // 现价在带内的相对位置：0=下轨，50=中轨，100=上轨
    pctB: (k * sd) > 0 ? ((closes[closes.length - 1] - (ma - k * sd)) / (2 * k * sd) * 100) : 50,
  };
}

// ═══ 由布林带推导最优买点区间 ═══
// 逻辑：
//   下沿 = 布林下轨（统计意义上的超卖锚点，也是补仓价的底线）
//   上沿 = min(中轨, 短均线中位) ，但最多只放开到「下轨 + 30% 带宽」
//         ——避免区间过宽失去指导意义（原实现会一路放到中轨）
//   区间宽度约等于 0.3×2σ，即买点只覆盖下轨上方一小段
function deriveBuyZone(boll, ma5, ma10, price) {
  if (!boll) return null;
  const lower = boll.lower, mid = boll.ma;
  const span = mid - lower;                 // = Kσ
  if (!(span > 0)) return { low: lower, high: lower, mid: mid };

  // 1) 下轨 + 30%带宽（硬上限，防止区间过宽）
  let top = lower + span * 0.3;

  // 2) 若短均线恰好落在 [下轨, 该上限] 内，取其中较高者作为上沿
  const cands = [ma5, ma10].filter(function (v) { return v && v > lower && v <= top; });
  if (cands.length) top = Math.max.apply(null, cands);

  if (top > mid) top = mid;
  if (top < lower) top = lower;

  return { low: lower, high: top, mid: mid, width: top - lower };
}

async function getAllStockData() {
  const results = [];
  // ── 步骤1：批量取行情快照（腾讯优先，一次请求拿全部；失败再逐只走东财）──
  const quotes = {};
  let snapSource = null;
  try {
    const syms = STOCKS.map(function (s) { return toTxSymbol(s.market + '.' + s.code); });
    const tq = await fetchQuoteTencent(syms);
    let hit = 0;
    STOCKS.forEach(function (s) {
      if (tq[s.code] && tq[s.code].price > 0) { quotes[s.code] = tq[s.code]; hit++; }
    });
    if (hit > 0) snapSource = 'tencent';
  } catch (e) {
    console.error('batch quote error:', e.message);
  }

  // 腾讯没覆盖到的，逐只走东财补齐
  for (let si = 0; si < STOCKS.length; si++) {
    const s = STOCKS[si];
    if (quotes[s.code]) continue;
    try {
      const resp = await fetchStockRetry(s.market + '.' + s.code, 2);
      const d = (resp && resp.data) ? resp.data : {};
      if (d.f43) {
        quotes[s.code] = {
          code: s.code, name: d.f58 || s.name,
          price: d.f43, prevClose: d.f60 || 0, open: d.f46 || 0,
          high: d.f44 || 0, low: d.f45 || 0,
          change: d.f169 || 0,
          changePct: (d.f60 || 0) > 0 ? ((d.f43 - d.f60) / d.f60 * 100) : 0,
          volume: d.f47 || 0, amount: d.f48 || 0,
          pe: d.f162 || 0, pb: d.f167 || 0,
          marketCap: (d.f116 || 0) / 1e8,
        };
        if (snapSource === null) snapSource = 'eastmoney';
      }
    } catch (e) {
      console.error(s.name, 'quote error:', e.message);
    }
    if (si < STOCKS.length - 1) await new Promise(function (r) { setTimeout(r, 200); });
  }

  // ── 步骤2：逐只算布林带 ──
  for (let si = 0; si < STOCKS.length; si++) {
    const s = STOCKS[si];
    const q = quotes[s.code];
    if (!q || !q.price) {
      results.push({ code: s.code, name: s.name, role: s.role, error: true });
      continue;
    }
    const price = q.price;
    const pos = POSITIONS[s.code] || { shares: 0, cost: 0 };

    // ── 布林带：拉日K → 算 MA20/2σ → 推买点 ──
    let boll = null, buyZone = null, klineSource = null, effectiveTarget = s.target;
    try {
      const kr = await fetchCloses(s.market + '.' + s.code, BOLL_LOOKBACK);
      klineSource = kr.source;
      const closes = kr.closes;
      boll = calcBoll(closes, BOLL_N, BOLL_K);
      if (boll) {
        boll.lastDate = kr.date;
        boll.source = kr.source;
        // 短均线用于收敛买点区间
        const ma = function (p) {
          if (closes.length < p) return null;
          const w = closes.slice(-p);
          return w.reduce((a, b) => a + b, 0) / p;
        };
        buyZone = deriveBuyZone(boll, ma(5), ma(10), price);
        if (s.bollMode !== 'manual' && buyZone) effectiveTarget = buyZone.low;
      }
    } catch (e) {
      console.error(s.name, 'kline error:', e.message);
    }

    // 最终使用的目标补仓价：手动优先，否则布林下轨
    const target = (s.bollMode === 'manual' && s.target != null) ? s.target : effectiveTarget;
    // 布林买点区间中值，作为「理想介入成本」参考
    const buyMid = buyZone ? (buyZone.low + buyZone.high) / 2 : target;

    results.push({
      code: s.code, name: s.name, role: s.role,
      price: price,
      prevClose: q.prevClose || 0,
      changePct: q.changePct || 0,
      change: q.change || 0,
      high: q.high || 0,
      low: q.low || 0,
      open: q.open || 0,
      volume: q.volume || 0,
      amount: q.amount || 0,
      pe: q.pe || 0,
      pb: q.pb || 0,
      marketCap: q.marketCap || 0,
      divPerShare: s.divPerShare,
      divRate: price > 0 ? (s.divPerShare / price * 100) : 0,
      target: target,
      buyZone: buyZone,
      buyMid: buyMid,
      boll: boll,
      bollMode: s.bollMode || 'auto',
      distanceToTarget: target > 0 ? ((price - target) / target * 100) : 0,
      position: pos,
      positionValue: (pos.shares || 0) * price,
      positionPnL: pos.shares > 0 ? pos.shares * (price - pos.cost) : 0,
      annualDiv: (pos.shares || 0) * s.divPerShare,
    });
  }
  results.sort((a, b) => (a.distanceToTarget || 999) - (b.distanceToTarget || 999));
  return {
    stocks: results,
    totals: {
      marketValue: results.reduce((s, r) => s + (r.positionValue || 0), 0),
      totalPnL: results.reduce((s, r) => s + (r.positionPnL || 0), 0),
      annualDiv: results.reduce((s, r) => s + (r.annualDiv || 0), 0),
    },
    dividendCalendar: DIVIDEND_CALENDAR,
    quoteSource: snapSource,
    bollParams: { n: BOLL_N, k: BOLL_K, lookback: BOLL_LOOKBACK },
  };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
};

// Simple in-memory cache
let cacheData = null;
let cacheTime = 0;
const TTL = 15000;

// ═══ 独立布林带接口：/api/boll?code=601318&market=1 ═══
async function bollOnly(code, market) {
  const kr = await fetchCloses(market + '.' + code, BOLL_LOOKBACK);
  const closes = kr.closes;
  const boll = calcBoll(closes, BOLL_N, BOLL_K);
  if (!boll) return null;
  boll.lastDate = kr.date;
  boll.source = kr.source;
  const ma = function (p) {
    if (closes.length < p) return null;
    const w = closes.slice(-p);
    return w.reduce((a, b) => a + b, 0) / p;
  };
  return {
    code: code,
    name: kr.name,
    last: closes[closes.length - 1],
    boll: boll,
    buyZone: deriveBuyZone(boll, ma(5), ma(10), closes[closes.length - 1]),
    formula: '中轨=MA' + BOLL_N + '；σ=sqrt(Σ(收盘−中轨)²/' + BOLL_N + ')；上/下轨=中轨±' + BOLL_K + 'σ',
    source: kr.source,
    bars: closes.length,
  };
}

http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.url === '/api/stocks') {
    const now = Date.now();
    if (!cacheData || now - cacheTime > TTL) {
      cacheData = await getAllStockData();
      cacheTime = now;
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(cacheData));
    return;
  }

  if (req.url.indexOf('/api/boll') === 0) {
    const m = req.url.match(/[?&]code=(\d+)/);
    const mk = req.url.match(/[?&]market=(\d)/);
    if (!m) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'missing code' }));
      return;
    }
    try {
      const r = await bollOnly(m[1], mk ? mk[1] : '1');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(r || { error: 'no data' }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // 静态文件：优先仓库根目录，其次 public/（兼容两种部署方式）
  let rel = req.url.split('?')[0];
  if (rel === '/' || rel === '') rel = '/index.html';
  const candidates = [
    path.join(__dirname, rel),
    path.join(__dirname, 'public', rel),
  ];
  const ext = path.extname(rel);
  const serve = function (i) {
    if (i >= candidates.length) { res.writeHead(404); return res.end('Not Found'); }
    fs.readFile(candidates[i], (err, data) => {
      if (err) return serve(i + 1);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain; charset=utf-8' });
      res.end(data);
    });
  };
  serve(0);

}).listen(3000, () => console.log('📊 http://localhost:3000'));
