# IETF Atlas · 部署与运维

## 一、域名

| 项 | 值 |
|---|---|
| 推荐域名 | **`atlas.ietfmap.app`**（`atlas` 前缀可改，见「配置」页） |
| 根域 | `ietfmap.app`（`.app` 顶级域强制 HTTPS，Google 运营，无需额外配置 HSTS） |
| 备选前缀 | `map` / `std` / `wg` / `ietf` |

> 改名只改界面与标题，实际访问域名由托管平台的自定义域决定。上线前请确认 `ietfmap.app` 尚未被他人注册（`.app` 域名通过任意注册商查询，约 ¥100–200/年）。

**为什么是 `atlas.`**：`atlas` 一词在中文语境也常被理解为"图谱/地图册"，跨语言可读性强于 `map`；而 `map` 太泛，`std` 偏离"地图"语义。

## 二、本地运行

```bash
PORT=8080 python3 server.py     # 打开 http://localhost:8080
```

`server.py` = 静态托管 `app/` + `/api/live/{doc,group}` 同源代理。代理只原样转发 Datatracker 公开 API 并做 5 分钟缓存，
不引入任何第三方数据源。**不要**用 `python -m http.server` 直接托管 `app/`——那样实时回源会因浏览器跨域限制失效。

托管平台（端口由 `$PORT` 动态注入）请用 `launcher.py`：

```bash
python3 launcher.py     # 等价于 server.py，但端口没开时重试、探针断连不退出
```

平台的就绪探针常常在服务起来之前就开始敲端口，被拒的连接会让 `HTTPServer` 直接退出。
`launcher.py` 把"端口暂时打不开"当成常态（占上端口再重试），并打印 `Serving ... on http://0.0.0.0:<port>/` 这行就绪日志。

## 三、数据更新（构建期）

```bash
python3 scripts/fetch.py     # 从 Datatracker 拉取 → scripts/out/*.json
python3 scripts/pack.py      # 合并压缩 → app/data/snapshot.json
python3 scripts/layout.py    # 图谱的静态坐标 → app/data/layout.json（需要 graphviz 的 dot）
```

`/api/docfile` 是离线下载的转发口：只允许 `www.rfc-editor.org` 与 `www.ietf.org/archive/id` 两个来源，
名字/版本/格式都按正则校验，单份上限 12MB。部署环境需允许服务器出网到这两个域名；反向代理的读超时建议 ≥ 60s。

`layout.py` 只在快照更新后需要重跑（几秒）：它把每个领域的引用关系算成"层 = 行"的坐标，
前端只按坐标画点与箭头。改了抽主干的参数（`PICK` / `MAXD`）或 `FEATURED` 名单时也要重跑。

`fetch.py` 只拉取：全部组织实体（1614 个）、draft/rfc 类型且非过期/废弃文稿、以及有语义的关系边（排除 `contains`/`refold` 等结构关系）。
单次全量约 5–8 分钟，请勿高频运行。

## 四、发布

### Cloudflare Pages（纯静态，需额外配 Functions 才有代理）
```bash
npx wrangler pages deploy app --project-name ietf-atlas
```
若要保留实时回源，在 `functions/api/live/[[path]].js` 写一个转发函数（等价于 `server.py` 的 `/api/live/*`）；
否则纯静态部署只剩「快照命中」路径，新草案需等下一次快照重建。

### 带代理的单端口服务（推荐，开箱即用）
```bash
PORT=8080 python3 server.py
# 任何支持 Python/容器的平台（Fly.io / Railway / 自建）均可直接跑
```

### Netlify
```bash
npx netlify deploy --prod --dir=app
```

### GitHub Pages
```bash
git subtree push --prefix app origin gh-pages
```

## 五、定时刷新数据（GitHub Actions）

`.github/workflows/refresh.yml`：

```yaml
name: refresh-snapshot
on:
  schedule: [{ cron: '0 2 * * *' }]   # 每日 02:00 UTC
  workflow_dispatch:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: python3 scripts/fetch.py
      - run: python3 scripts/pack.py
      - run: sudo apt-get install -y graphviz && python3 scripts/layout.py
      - run: npx wrangler pages deploy app --project-name ietf-atlas
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CF_API_TOKEN }}
```

## 六、上线检查清单

- [ ] `atlas.ietfmap.app` 已解析并签发 HTTPS
- [ ] 首页页脚 "Unofficial / 无关联" 声明可见
- [ ] `#/about` 法律页面可达（页脚、帮助页均有入口）
- [ ] Lighthouse PWA 安装性检查通过（manifest + SW + 图标 192/512）
- [ ] 移动端 375px 宽度下三栏折叠正常
- [ ] 图谱页：切换 3~5 个领域，确认没有文字重叠 / 被画布裁切；点节点图**不重排**；全屏后页眉页脚收起（Esc 退出）
- [ ] 离线下载：收藏库点 `↓` 存一份草案 → 断网（或 DevTools Offline）→ 点「读」仍能打开；删收藏时三选一都能用
- [ ] `/api/docfile?name=rfc9000&fmt=txt` 返回 200 且是纯文本（这条要服务器能出网到 `www.rfc-editor.org`）
- [ ] 快照 `<meta name="generated">` 与实际日期一致
- [ ] `robots.txt` / `sitemap.xml` 域名与实际域名一致
- [ ] `GET /api/health` 返回 `{"ok":true,...}`（代理存活）
- [ ] 在「添加文稿」里输入一条快照中不存在的新草案，确认显示「实时 · Datatracker」并能加入
