# SongShift 移调

将网易云公开歌单迁移到 Spotify 的中文网页应用，基于原 Python 脚本，使用 Next.js App Router、TypeScript 和 React。包含可独立体验的示例模式。

## 本地运行

```sh
npm install
cp .env.example .env.local
# 按下文填写配置。无需配置也能使用示例模式及读取公开歌单。
npm run dev
# 另开一个终端启动后台匹配进程（Node.js >=22.13）：
node --env-file=.env.local --import tsx scripts/task-worker.ts
```

打开 http://127.0.0.1:3002 。不要使用 localhost，以保持 Cookie、请求来源与 OAuth 回调一致。端口 3002 用来避免和父项目冲突。

## Spotify 配置

1. 在 [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) 创建应用。
2. 登记回调 URI：`http://127.0.0.1:3002/api/auth/callback`。
3. 在 `.env.local` 填入 `SPOTIFY_CLIENT_ID`、`APP_URL=http://127.0.0.1:3002` 和至少 32 字符的随机 `SESSION_SECRET`。可用 `openssl rand -hex 32` 生成。
4. 重启服务，点击「连接 Spotify 账号」。无需 Client Secret。

使用 OAuth Authorization Code + PKCE、随机 state 和十分钟有效授权请求。令牌存于 AES-256-GCM 加密的 HttpOnly、SameSite Cookie，服务端刷新。生产环境 APP_URL 必须是 HTTPS；应用默认绑定本机回环地址。

当前使用 `POST /v1/me/playlists` 与 `POST /v1/playlists/{id}/items`，每批最多 100 首。开发模式账号资格、Premium 与用户/调用配额请查看 [Spotify 官方配额说明](https://developer.spotify.com/documentation/web-api/concepts/quota-modes)。这尤其影响上千首歌单的逐首搜索。限流会暂停匹配并保留进度，等待 Retry-After 后可以继续。

## AI 复核：你的中转站 + GPT-5.6 Luna

在 `.env.local` 配置：

```dotenv
AI_BASE_URL=https://api.loe.cx/v1
AI_API_KEY=你的密钥
AI_MODEL=gpt-5.6-luna
AI_API_STYLE=chat_completions
AI_WEB_SEARCH=1
```

地址是否含 `/v1`、模型别名以你的中转站为准。也支持 `AI_API_STYLE=responses`。两种格式都要求中转站支持 JSON Schema 结构化输出；不支持时会明确报错，不会静默切换模型或接口。密钥不进入浏览器，也不写入日志。

- 「AI 复核疑似歌曲」处理待确认、未找到、低分、歌名或时长存在差异的结果；详情中也可手动复核任意候选。
- 仅向配置的中转站发送原曲及最多五个候选的歌曲 ID、名称、歌手、专辑、时长；不会发送账号、Spotify 令牌或音频。
- `AI_WEB_SEARCH=1` 需要同一中转站支持 Responses API 的 `web_search`。歌手或歌名不同会先真实联网核实艺名、原唱和简繁体/罗马字写法，优先艺人、唱片公司等原始来源；只接受实际搜索返回的来源 URL，未执行搜索或无来源时明确报错，不冒充联网核实。
- 已保存任务会按核实结果最多补搜三组 Spotify 关键词，沿用全站 429 等待，不绕过限流。只有 Spotify 实际返回的候选 ID 才能被建议。补搜限流时保留网络核实资料，显示重试时间；可在详情点击「联网查原唱」重试。
- 找不到原曲表演者版本时，可建议有网络依据的原唱版本，明确标为「原唱替代」并等待人工确认，不能当成相同录音。
- 展示中文判断理由。AI 不会自动接受低分结果；若质疑原有自动匹配，会取消勾选并退回待确认。用户确认过的结果不会被 AI 覆盖。
- 显示已复核、待复核、本轮进度与当前歌曲；结果可按建议匹配/跳过/不确定筛选，逐首查看理由、时间和来源，也可导出复核报告。后台任务列表显示已保存的三类结果计数。
- 每首单独请求，可暂停；已保存任务的复核结果直接写入服务器，刷新后跳过已完成歌曲继续。复核批次仍由浏览器发起，需保持网页打开；Spotify 匹配队列则持续后台运行。重新复核会产生新请求。示例模式完全在本地模拟，不调用中转站。
- 判断仅基于元数据，无法确认音频本身。参考 [Luna 模型文档](https://developers.openai.com/api/docs/models/gpt-5.6-luna)、[结构化输出](https://developers.openai.com/api/docs/guides/structured-outputs)。

## 网易云登录说明

本版按原脚本访问网易云网页使用的歌单和歌曲详情接口，读取公开歌单，无需登录。该接口不是有稳定性保证的公开开发者 API，可能受地区、风控或接口变更影响。读取不全时会展示缺失数量，绝不假装完整迁移。

目前未查到可以面向普通开发者直接申请、用于个人歌单授权的官方 OAuth 文档。社区 [NeteaseCloudMusicApiEnhanced](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced) 等项目的扫码登录获取的是 Cookie 会话，并非标准的第三方 OAuth。本版不接入私密歌单或扫码登录。

## 使用流程与限制

粘贴网易云歌单链接或 ID → 连接 Spotify → 开始匹配 → 可选 AI 复核 → 人工选择版本 → 勾选歌曲 → 确认创建歌单。

保留原顺序、检测同名不同艺人及 Live/remix 差异；规则评分不是概率。待确认候选必须人工选择后才能导入。导出报告包含所有结果、是否勾选、AI 建议与理由，使用 UTF-8 BOM 并防止 CSV 公式注入。

网站支持用户名/密码注册与登录，任务按账号隔离，换设备登录后可在「后台任务」中打开。密码使用随机盐与 scrypt 哈希；登录会话使用 HttpOnly Cookie，支持退出注销，并限制注册/登录尝试次数。当前没有邮件找回功能。

点击「创建后台匹配任务」后，歌曲与进度存入 SQLite，关闭网页、重启服务后可续跑。本站不设置每日搜索次数上限，近 24 小时次数仅供统计；每首最多尝试三种查询。遇到 Spotify `429` 时，全站搜索按 `Retry-After`（秒数或 HTTP 日期）等待后自动重试；缺失或无效时等待 60 秒再尝试，不推测固定的每日额度。已完成结果复用，搜索中途限流也会保存查询步骤，恢复后只重试尚未成功的查询。网络或授权错误需要人工重试/重连。后台只负责匹配，全部完成后仍需人工确认并创建 Spotify 歌单。

升级时会自动解除旧版 400 次预算造成的等待，保留所有任务、已完成结果、人工选择及查询进度，并保留已经记录的 Spotify 限流等待时间。手动暂停的任务不会被自动恢复。

Spotify 令牌在数据库中加密保存，以便后台刷新和跨天运行。退出网站账号不停止任务；「断开 Spotify」会移除服务器授权并暂停相关任务。数据库默认在 `data/tasks.sqlite`，可通过 `SONGTRANSFER_DATA_DIR` 指定稳定的数据目录。备份时使用 SQLite 的备份接口或停服务后连同 WAL 文件备份，且需保留 `SESSION_SECRET` 才能解密授权。

写入不自动重试。创建或添加歌曲后的网络超时可能发生在 Spotify 已写入之后：返回的部分成功信息包含目标歌单链接和已确认写入数量；若整个请求响应丢失，界面阻止直接重复创建，并提示先去 Spotify 检查。同一后台任务使用服务器端提交标记阻止并发/重复创建；网络响应丢失时仍需人工检查 Spotify，不会自动重试。任务匹配、人工选择和写入状态可以跨设备恢复。

## 服务器部署

当前站点：https://song.7227.org 。应用位于服务器 `/var/www/songtransfer`，以独立用户 `songtransfer` 运行，监听 `127.0.0.1:3002`。

- Nginx 虚拟主机：`/etc/nginx/sites-available/songtransfer`，配置副本见 `deploy/nginx.conf`。
- systemd 服务：`songtransfer.service`，配置副本见 `deploy/songtransfer.service`。
- 后台队列服务：`songtransfer-worker.service`，配置副本见 `deploy/songtransfer-worker.service`；数据库位于 `/var/lib/songtransfer/tasks.sqlite`，发布代码时不得覆盖这个目录。
- 生产配置：`/etc/songtransfer.env`，仅 root 可读写。填写 `SPOTIFY_CLIENT_ID` 和 `AI_API_KEY` 后执行 `systemctl restart songtransfer`。
- Spotify 应用需登记回调：`https://song.7227.org/api/auth/callback`。
- HTTPS 证书由 Certbot 自动续期，续期后自动重载 Nginx。

查看应用日志：`journalctl -u songtransfer -n 100 --no-pager`。

## 验证

```sh
npm run test
npm run typecheck
npm run lint
npm run build
```

测试覆盖链接校验、错误版本匹配、会话篡改/过期、CSV 注入、分批写入及部分失败、限流、网易云缺失/顺序、AI 候选约束与两种中转站请求格式。真实 Spotify 授权/写入和 AI 调用需要配置自己的应用与中转站。
