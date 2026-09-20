# X Reply Filter (jev)

Chrome 扩展（MV3）：在 x.com 的推文详情页折叠低质量回复。两级判定：

1. **本地规则**（`rules.js`，零成本）：推广引流、加密货币 shill、AI 工具推销、互动饵（"so true"、纯 emoji、"first"）、纯链接、疑似机器人账号
2. **jev 判定**（`background.js`）：剩余回复每 8 条一批发给 TypeSafe jev（经 OpenRouter `alpha/decisions`），四个 noul 问题：推广/垃圾、互动饵、跑题、AI 套话；任一 ≥ 阈值（默认 0.75）即折叠

折叠成一行「已隐藏 · 类别 · 概率 · 点击展开」，不删内容，方便校验误判。

**判定缓存**（`chrome.storage.local`，不重复计费）：每条判定同时按推文 id 和「作者+正文」的内容哈希写两个键，读的时候 id 优先、哈希兜底。所以重开同一条帖子、X 换了一套 id、甚至同一条垃圾回复出现在别的帖子下，都不会再问一次 jev；同一批里重复的正文也只问一次。缓存超过 5,000 条时清理到 4,000 条，按时间淘汰最旧的，不动你标记的例子。设置页可「清空判定缓存」。

## 用户能看到什么

- **页面内**：被折叠的回复变成一行灰条（类别 + 概率，点击展开）；页面底部蓝色胶囊显示「已隐藏 N 条 · 全部展开」
- **工具栏图标**：角标数字 = 本页已隐藏条数；点开弹窗有总开关、本页统计（扫描/规则/jev）、今日额度、全部展开、设置入口
- **首次安装**：自动打开设置页，顶部有三步使用说明

## 让它学你的口味（反馈闭环）

- **手动标记**：悬停任意回复，右上角出现「隐藏」，点了立即折叠并存为「无效样本」；标记条上可「屏蔽 @用户」或「撤销」
- **纠正误判**：任何折叠条上点「误判」，该回复展开、存为「保留样本」，并且永不再被折叠
- **自定义规则**（设置页）：关键词一行一个，支持 `/正则/i`；屏蔽用户列表。本地生效、零成本，命中的回复不会再发给 jev
- **待确认列表**（设置页）：规则和 AI 自动折叠的回复都会记在「最近自动隐藏」，一键「对，不想看」或「判错了，保留」才变成例子。AI 自己判的结果不会自动变成例子，避免它用自己的输出强化自己
- **喂给 jev**：每次判定会带上最近各 10 条无效/保留样本，并多问一个问题「是否与用户标记过的无效回复同类」。实测（`test/examples.e2e.js`）：标了 3 条「求重置」样本后，同类回复 user 分数 0.90 和 0.93，正常提问 0.08 和 0.10
- 样本只存在本机 `chrome.storage.local`，设置页可逐条删除或清空；走免费中转时样本文本会随请求发到中转再到 jev，不落库

## 两种模式

- **免费额度（默认）**：不填 key。另有每 IP 每天 600 条的上限（安装 id 是客户端生成的，可以随便换，IP 上限才是真正防一个人刷爆公共预算的闸）。插件调 Cloudflare Worker 中转（`worker/`），key 只存在 Worker secret 里。每个安装生成匿名 id，每天 300 条回复；全局日预算 $2，超了返回 429，插件自动退回纯规则模式。
- **自带 key**：设置页填 OpenRouter key，直连 OpenRouter，不限量、自己付费。

中转部署（一次性）：

```bash
cd worker && npx wrangler login
OPENROUTER_API_KEY=sk-or-... ./deploy.sh   # 建 KV、写 secret、部署、自动把 URL 写回 background.js
```

额度和预算在 `worker/wrangler.jsonc` 的 `vars` 里改。

**KV 写入预算**：免费版每天 1,000 次写入，所以每次请求最多写 1 个键（每日每 IP 计数）。全局花费是抽样写入（默认 25 次请求写 1 次，按 25 倍累加），只作粗粒度兜底；真正的闸门是每 IP 每天 600 条。改 worker 后跑 `node test/worker.routes.test.js` 验证所有路由。

## 安装

1. Chrome 打开 `chrome://extensions`，开启右上角「开发者模式」
2. 「加载已解压的扩展程序」，选这个目录
3. 打开任意推文详情页（`x.com/<user>/status/<id>`）

不用任何配置即可使用免费额度；想不限量就在设置页填自己的 OpenRouter key。

## 前置：OpenRouter Guardrail

如果设置页统计一直为 0、控制台出现 `model-ignored-by-guardrail`，说明 OpenRouter 工作区的 Guardrail 把 `typesafe/jev` 挡了，去 https://openrouter.ai/workspaces/default/guardrails 放行。2026-09-18 这把 key 就是这个状态。

## 费用

每条回复约 4 个问题，一批 8 条约 1,500 input tokens，约 $0.00006；刷 1 万条回复约 $0.08。设置页有累计 token 和费用，可导出为 `jevlog` 格式并入 `~/content/jev-leaderboard` 的消耗榜。

## 测试

```bash
node test/rules.test.js                                   # 本地规则 + 自定义关键词/屏蔽用户
node test/sw.load.test.js                                 # service worker 同作用域加载（防重复声明）
OPENROUTER_API_KEY=sk-or-... node test/examples.e2e.js    # 用户样本确实改变 jev 判定
OPENROUTER_API_KEY=sk-or-... node test/jev.e2e.js         # 直连 jev，5 条样例带期望值
cd worker && npx wrangler dev --port 8787 --var DAILY_PER_ID:10 & PROXY_URL=http://localhost:8787 node test/jev.e2e.js   # 走中转，第 3 次应 429
python3 -m http.server 8766 && open http://localhost:8766/test/fixture.html   # 仿 X DOM + mock chrome，看折叠 UI
```

## 隐私

- **发出去的数据**：原推文正文与作者名、待判定回复的正文与作者名、你确认过的例子文本（各最多 10 条）。不含你的账号、cookie、私信或浏览历史
- **去向**：免费模式经 `xrf.ship2market.ai`（Cloudflare Worker）转发到 OpenRouter 的 TypeSafe jev；自带 key 模式直连 OpenRouter
- **中转只存计数**：每个匿名安装 id 和哈希后的 IP 的当日用量、当日总花费，26 小时过期；不存任何推文或回复内容
- **本机**：例子、判定缓存、待确认列表都在 `chrome.storage.local`；关键词、屏蔽用户、key 在 `chrome.storage.sync`
- 不想经过别人的中转？自己部署 `worker/`，把 `background.js` 里的 `proxyUrl` 改成你的域名即可

## 已知限制

- 依赖 x.com 的 `data-testid`（`tweet`、`tweetText`、`User-Name`、`icon-verified`），X 改 DOM 需要跟着改选择器
- 拿不到粉丝数、注册时间等 DOM 里没有的信号
- 只在详情页生效，时间线不处理
- key 存在 `chrome.storage.sync`，随 Chrome 账号同步；不想同步就改成 `local`
