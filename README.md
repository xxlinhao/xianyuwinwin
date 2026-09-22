# 咸鱼WinWin · stock-monitor

> 诚实做人，认真炒股 · 股息率价值投资观察站

移动端（480px）单页应用，PWA（含 manifest.json + icon-192.png）。

## 目录结构

```
stock-monitor/
├── server.js              # Node 后端（端口 3000）
├── public/
│   ├── index.html         # 单文件应用（HTML+CSS+JS 全内联）
│   ├── manifest.json      # PWA 清单
│   └── icon-192.png
└── *.bak                  # 改动前的备份
```

## 功能模块（4 个 tab）

| Tab | 说明 |
|---|---|
| 🏠 首页 | 股息率价值分档卡片（≥6% 极度低估 / 5.5-6% 低估 / 5.0-5.5% 合理 / 4.0-5.0% 偏贵 / <4% 高估），含布林带迷你条 |
| 🔍 个股 | 展开式详情：估值 / 营收净利双轴图 / 现金流 / 目标价分段 SVG / **布林带买点** / 分红趋势 / 事件 |
| 📊 持仓 | 持股数与成本录入（localStorage 持久化），盈亏、股息率、年分红汇总 |
| ⚙️ 设置 | 22 只股票的显示开关，按 4 大类折叠分组，选择记忆 |

## 布林带买点（核心功能）

### 公式
```
中轨 = MA20                          // 20日收盘价简单均线
σ    = sqrt( Σ(收盘 − 中轨)² / 20 )   // 总体标准差
上轨 = 中轨 + 2σ
下轨 = 中轨 − 2σ
```
实现位置：`public/index.html` 的 `calcBoll()`；`server.js` 也有一份同样的 `calcBoll()`。**两处逻辑必须保持一致。**

### 买点区间推导 `deriveBuyZone()`
```
下沿 = 布林下轨
上沿 = 下轨 + 0.3×(中轨−下轨)        // 硬上限，防止区间过宽
     = 若 MA5 / MA10 落在 [下轨, 该上限] 内，取较高者
```
⚠️ 设计要点：**上沿最多只放到 30% 带宽**。早期实现把上沿一路放到中轨，导致区间过宽失去指导意义（如平安出现 `52.80~54.46`）。

### 布林下轨取代硬编码补仓价
原 `CFG[].buy`（如平安 50、招行 37）是写死的，早已被行情甩开 6%-10%。现在：
- `rw.target = buyZone.low`（布林下轨）
- 日K拉取失败时才回退到 `c.buy`

### 渲染位置
1. **首页卡片**：迷你布林条（下轨→上轨区间 + 中轨刻度 + 现价红点）+ 买点区间文字
2. **个股详情**：完整区块 —— 布林带可视化条 + 买点区间卡 + %B/带宽/σ 三格 + 公式说明

## 数据源

### 行情快照
- 前端 `fo()`：东财 `push2.eastmoney.com`（并发直取，逐只）
- 后端：腾讯 `qt.gtimg.cn` 批量优先 → 东财补齐
  - 腾讯**一次批量拉多只**，返回 **GBK 编码**，需 `TextDecoder('gbk')` 解码
  - 腾讯字段位：`[3]`现价 `[4]`昨收 `[5]`今开 `[15]`… `[32]`涨跌% `[33]`最高 `[34]`最低 `[39]`PE `[45]`总市值(亿) `[46]`PB `[37]`成交额(万)

### 历史日K（布林带用）
- 前端：腾讯 `web.ifzq.gtimg.cn/appstock/app/fqkline/get`（前复权 qfq，**浏览器可直接跨域调用**）
- 后端：`push2his.eastmoney.com`（首选）→ 腾讯（**实际生效**）→ 新浪（兜底）
  - ⚠️ `push2his.eastmoney.com` 在部分网络环境被拦截（`socket hang up`）
  - 腾讯 `qfqday` 为前复权，与东财 `fqt=1` 口径一致

## 接口

- `GET /api/stocks` → `{stocks:[{...boll, buyZone, target...}], totals, dividendCalendar, quoteSource, bollParams}`，缓存 15s
- `GET /api/boll?code=601318&market=1` → 单只布林带明细

## 关键坑（踩过，勿重犯）

1. **`https.get` 必须设 `setTimeout`** —— 无超时会让一个挂起请求阻塞整轮刷新（曾导致某只股票持续 ERROR）
2. **`getAllStockData()` 先用腾讯批量拿快照**，东财仅补齐 —— 减少请求数，避免被限流
3. **东财 `push2delay` 不提供 K 线接口**，只返回 `dktotal` 元信息，不能当备源
4. 布林轨道**每天移动**（招行下轨 3 天内从 38.66 → 39.18），买点须定期重算
5. 触及下轨 ≠ 必涨，趋势下行会沿下轨阴跌（页面已注明）
6. `.bak` 备份文件放在 `public/` 下会被当静态资源，注意别被误请求

## 验证方法

```bash
node --check server.js            # 语法检查
node server.js                    # 启动（端口 3000）
curl localhost:3000/api/stocks    # 看 boll 字段覆盖情况
```

## 环境注意（本机）

- bash 环境缺 `ls`/`dirname`/`cd`，文件操作走 Read/Glob/Grep，命令走 PowerShell 或绝对路径
- 3000 端口释放：`netstat -ano | Select-String ":3000\s+.*LISTENING"` 取 PID → `taskkill /F /PID`
- PowerShell 输出可能被吞，必要时重定向到文件再 Read
