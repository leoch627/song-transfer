# SongShift 移调

将网易云公开歌单迁移到 Spotify 的中文网页应用，基于原 Python 脚本，使用 Next.js App Router、TypeScript 和 React。包含可独立体验的示例模式。

## 本地运行

```sh
npm install
cp .env.example .env.local
# 按下文填写配置。无需配置也能使用示例模式及读取公开歌单。
npm run dev
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
```

地址是否含 `/v1`、模型别名以你的中转站为准。也支持 `AI_API_STYLE=responses`。两种格式都要求中转站支持 JSON Schema 结构化输出；不支持时会明确报错，不会静默切换模型或接口。密钥不进入浏览器，也不写入日志。

- 「AI 复核疑似歌曲」仅处理待确认、低分、歌名或时长存在差异的结果；详情中也可手动复核任意候选。
- 仅向配置的中转站发送原曲及最多五个候选的歌曲 ID、名称、歌手、专辑、时长；不会发送账号、Spotify 令牌或音频。
- 通过已有候选 ID 校验限制模型输出，不能凭空生成 Spotify 歌曲。无法确定时返回「不确定」或「跳过」。
- 展示中文判断理由。AI 不会自动接受低分结果；若质疑原有自动匹配，会取消勾选并退回待确认。用户确认过的结果不会被 AI 覆盖。
- 每首单独请求，可暂停，已完成的建议保留在本次会话；点击重新复核会产生新请求。示例模式完全在本地模拟，不调用中转站。
- 判断仅基于元数据，无法确认音频本身。参考 [Luna 模型文档](https://developers.openai.com/api/docs/models/gpt-5.6-luna)、[结构化输出](https://developers.openai.com/api/docs/guides/structured-outputs)。

## 网易云登录说明

本版按原脚本访问网易云网页使用的歌单和歌曲详情接口，读取公开歌单，无需登录。该接口不是有稳定性保证的公开开发者 API，可能受地区、风控或接口变更影响。读取不全时会展示缺失数量，绝不假装完整迁移。

目前未查到可以面向普通开发者直接申请、用于个人歌单授权的官方 OAuth 文档。社区 [NeteaseCloudMusicApiEnhanced](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced) 等项目的扫码登录获取的是 Cookie 会话，并非标准的第三方 OAuth。本版不接入私密歌单或扫码登录。

## 使用流程与限制

粘贴网易云歌单链接或 ID → 连接 Spotify → 开始匹配 → 可选 AI 复核 → 人工选择版本 → 勾选歌曲 → 确认创建歌单。

保留原顺序、检测同名不同艺人及 Live/remix 差异；规则评分不是概率。待确认候选必须人工选择后才能导入。导出报告包含所有结果、是否勾选、AI 建议与理由，使用 UTF-8 BOM 并防止 CSV 公式注入。

本机个人使用版本，无数据库、多用户额度控制或后台队列。歌曲进度保存在当前标签页的 sessionStorage，OAuth 跳转及刷新可恢复；关闭标签页或超出浏览器配额可能丢失。长任务请保持页面打开；远程部署需考虑函数执行时限和访问控制。

写入不自动重试。创建或添加歌曲后的网络超时可能发生在 Spotify 已写入之后：返回的部分成功信息包含目标歌单链接和已确认写入数量；若整个请求响应丢失，界面阻止直接重复创建，并提示先去 Spotify 检查。没有实现跨设备恢复或服务端幂等写入。

## 验证

```sh
npm run test
npm run typecheck
npm run lint
npm run build
```

测试覆盖链接校验、错误版本匹配、会话篡改/过期、CSV 注入、分批写入及部分失败、限流、网易云缺失/顺序、AI 候选约束与两种中转站请求格式。真实 Spotify 授权/写入和 AI 调用需要配置自己的应用与中转站。
