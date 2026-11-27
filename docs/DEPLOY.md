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

### 账号与登录

服务端带了登录，凭据存在 `state/`（首次启动自动生成，权限 700/600）：

| 文件 | 内容 | 说明 |
|---|---|---|
| `state/users.json` | 账号名、角色、盐、PBKDF2 散列、`pv`（密码版本） | 密码不可逆，只能重置 |
| `state/secret` | 会话签名密钥 | 删掉等于让所有人重新登录 |
| `state/auth.log` | 登录、改密、建号、删号的审计 | 仅管理员在「操作日志」页可见 |

初始账号是 `admin` / `admin`，**首次登录会强制改密码**。上线后务必先登录改掉。

会话有效期是 **30 天**（`auth.SESSION_TTL`），并且滑动续期：用满一天后，下次访问会自动换一张新票，
所以天天用的人不会被踢出去，只有连续 30 天不来才要重新登录。想收紧就改这个常量，
它同时决定 Cookie 的 `Max-Age` 和前端的离线缓存时长。

部署要点：

- **`state/` 必须是持久卷**。容器重建后如果丢了，会自动重新播种 `admin/admin`——等于把门重开了。
  在 Fly.io / Railway 上挂一个 volume 到 `/app/state`；只读文件系统下要先 `mkdir -p state` 并确保可写。
- **一定要走 HTTPS**。`Secure` Cookie 依据 `X-Forwarded-Proto` 或 Host 判断，反代要透传这个头；
  没走 HTTPS 时会话 Cookie 可被同网段窃听。
- **反代不改写 Host 时要声明公网域名**。写操作（登录、改密、建号）会做同源校验，
  拿浏览器的 `Origin` 跟服务看到的 `Host` 比。如果网关把 `Host` 换成了内部地址
  （容器名、`xxx.sandbox.…` 之类），两个值永远不相等，登录会直接 403。两种解法：

  ```bash
  # 解法一（推荐）：告诉服务对外的域名
  ATLAS_PUBLIC_HOST=ietfmap.app.workbuddy.host python3 launcher.py
  ```

  或者让反代透传 `X-Forwarded-Host` / `Host` 原值。被拦下来的请求会写一条
  `origin-refused` 审计（含它看到的 Host），在「操作日志」页能直接看到现场。
- **多副本要注意**：会话是无状态的（HMAC 签名），所以多机部署必须共享同一个 `state/secret`，
  否则每台机器签发的 Cookie 在别的机器上验不过。
- 忘记密码：用另一个管理员在「配置 → 账号管理」里重置。**如果只剩一个管理员、密码又丢了**，
  在服务器上跑：

  ```bash
  python3 auth.py list                        # 看看有哪些账号
  python3 auth.py reset admin 新的临时密码      # 立刻生效，旧会话全部失效
  ```

  服务不用停。这条命令直接改 `state/users.json`，并把该账号标记为「下次登录必须先改密码」。

- **发布时别删 `state/`**。它跟着代码目录一起发布，是账号库；为了"干净部署"而 `rm -rf state`
  等于把所有账号清空（重启会重新播种 `admin/admin`，等于把门重开）。发布前要备份，就 `cp -a state /tmp/state-$(date +%F)`。

### 用户数据与备份

收藏、笔记、离线正文**不在服务器上**，也不在仓库里：它们存在每个用户自己浏览器的 IndexedDB 里，
按账号分库（`ietf-atlas--<账号名>`）。这决定了三件事：

| 现象 | 原因 | 处理 |
|---|---|---|
| 换账号登录后收藏是空的 | 每个账号一个库 | 配置 → 找回数据 → 选原来那个库「恢复到此账号」 |
| 换浏览器 / 换设备后空了 | 数据不跨设备 | 在新设备上「导入备份 JSON」 |
| 清站点数据 / 无痕窗口后空了 | IndexedDB 被删 | 同上；无痕窗口关掉就没了，救不回来 |
| iPhone / iPad Safari 放几天后空了 | 系统清理 7 天未访问站点的本地数据 | 让用户加到主屏；定期导出备份 |

> 升级到账号版时，旧版那份公共库 `ietf-atlas` 是**原样保留**的；第一个登录的账号会认领一份副本，
> 原库不删。所以"新库里是空的"往往还能从旧库合并回来——「找回数据」里能看到。

给用户的建议只有两条：**每周导一次 JSON 备份**，以及**点一下「开启持久存储」**。
前端会自动申请 `navigator.storage.persist()`，并在设置页显示上次备份距今多久。

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

### 发布/重启之间：收藏存在哪、什么会丢

- 收藏、笔记、日志、报告、离线正文 **全部存在访问者浏览器的 IndexedDB**，按账号分库
  （`ietf-atlas--<账号名>`）。服务器上没有任何收藏副本，`state/` 里只有账号和会话密钥。
- 因此：**重新发布、重启服务、清空 `state/` 都不会删收藏；清浏览器站点数据才会。**
- 排查“收藏不见了”的顺序：
  1. 应用顶部会自动出一条自检提示（有收藏时不出现），直接说清本机还剩几个库、各多少条；
  2. 配置 → 找回数据 → 扫描本机历史数据 / 复制体检结果；
  3. 只有「导出备份 JSON」留下的文件能跨设备、跨浏览器恢复。
