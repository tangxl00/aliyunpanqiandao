# 阿里云盘每日自动签到

基于 **GitHub Actions + refresh_token** 的阿里云盘每日自动签到，
核心脚本使用 Node.js 原生 `fetch`，**零第三方依赖**，无需 `npm install`。

## ✨ 特性

| 项目 | 说明 |
|---|---|
| 签到方式 | refresh_token 换 access_token，调用 sign_in_list 完成签到 |
| 多账号 | 支持，token 用 `&` 或换行分隔，逐个执行 |
| 自动领奖 | 签到后自动领取每日签到 / 每日任务奖励 |
| 幂等 | 接口本身幂等，同一天重复运行不会重复计数 |
| 消息推送 | 可选，支持 Server 酱 / PushPlus / 钉钉 / 企业微信 / Telegram / Bark |
| 依赖 | 无，仅 Node.js 18+ 原生模块 |
| 定时 | GitHub Actions cron 每天北京时间 09:00 |

## 🚀 快速开始（GitHub Actions）

1. 把本仓库推送到你的 GitHub 账号（新建仓库后 `git push`）。
2. 进入仓库 **Settings → Secrets and variables → Actions**。
3. 新建 Secret：`REFRESH_TOKEN`，值为你的阿里云盘 refresh_token（获取见 [CREDENTIALS.md](CREDENTIALS.md)）。
4. 可选：新建 Variable `DRY_RUN`=`1` 可先只查询不领奖。
5. 打开 **Actions** 标签，选中 `阿里云盘每日签到`，点 **Run workflow** 手动跑一次验证。
6. 之后每天北京时间 09:00 自动执行（对应 workflow 里的 UTC `0 1 * * *`）。

## 💻 本地运行

```bash
# 1. 复制环境变量模板并填写
cp .env.example .env
# 编辑 .env，把 REFRESH_TOKEN 填成你的 token

# 2. 直接运行（零依赖，不需要 npm install）
node scripts/checkin.mjs

# 3. 只查询不领奖
DRY_RUN=1 node scripts/checkin.mjs
```

## 🔑 获取 refresh_token

登录阿里云盘网页版后，控制台执行：

```javascript
copy(JSON.parse(localStorage.token).refresh_token)
```

详细图文步骤见 [CREDENTIALS.md](CREDENTIALS.md)。

## 📢 消息推送（可选）

在 GitHub Secrets（或本地 `.env`）里按需配置对应变量即可启用，留空则不推送：

| 渠道 | 需要的变量 |
|---|---|
| Server 酱 | `SERVERCHAN_SCKEY` |
| PushPlus | `PUSHPLUS_TOKEN` |
| 钉钉 | `DINGTALK_WEBHOOK` |
| 企业微信 | `WECHAT_WEBHOOK` |
| Telegram | `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` |
| Bark | `BARK_URL` |

## ⏰ 调整签到时间

编辑 [.github/workflows/checkin.yml](.github/workflows/checkin.yml) 的 `cron`。
GitHub Actions 使用 **UTC**，北京时间 = UTC + 8。例如北京时间 08:00 对应 `0 0 * * *`。

## 📁 目录结构

```text
aliyun-drive-checkin/
├─ .github/workflows/checkin.yml   # 定时任务配置
├─ scripts/checkin.mjs             # 签到核心脚本（零依赖）
├─ .env.example                    # 环境变量模板
├─ CREDENTIALS.md                  # token 获取指南
├─ package.json
└─ README.md
```

## ❓ FAQ

- **提示 refresh_token 已过期**：重新按 CREDENTIALS.md 获取一个新 token 并更新 Secret。
- **GitHub 定时任务没触发**：GitHub 对免费仓库的 cron 有延迟/暂停策略，可先手动 Run workflow 验证；长时间无活动仓库可能被暂停计划任务。
- **签到成功但没领到奖励**：奖励领取依赖当天任务状态，`status=finished` 才会领取，未完成任务不会重复领取。

## 📝 说明

`refresh_token` 等同于账号凭证，请仅存放在 GitHub Secrets 或本地 `.env` 中，不要提交到仓库或公开传播。
