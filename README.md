# 阿里云盘每日自动签到

基于 **GitHub Actions + refresh_token** 的阿里云盘每日自动签到，
核心脚本使用 Node.js 原生 `fetch`，**零第三方依赖**，无需 `npm install`。

## ✨ 特性

| 项目 | 说明 |
|---|---|
| 签到方式 | refresh_token 换 access_token，调用 sign_in_list 完成签到 |
| 多账号 | 支持，token 用 `&` 或换行分隔，逐个执行 |
| 自动领奖 | 签到后自动领取每日签到 / 每日任务奖励（领奖接口 403 时自动跳过） |
| 每日只签一次 | 当天签到成功会写入 `.checkin-state.json`，后续运行直接跳过，不再调用签到接口 |
| 消息推送 | 可选，支持 Server 酱 / PushPlus / 钉钉 / 企业微信 / Telegram / Bark |
| 每渠道每天只推一次 | 每个渠道独立记录，成功即落盘；失败不记账，下次运行只补推失败的那个渠道 |
| 依赖 | 无，仅 Node.js 18+ 原生模块 |
| 定时 | GitHub Actions cron 每天 4 次（北京时间 15:30 / 16:30 / 22:30 / 次日 04:30） |

## 🚀 快速开始（GitHub Actions）

1. 把本仓库推送到你的 GitHub 账号（新建仓库后 `git push`）。
2. 进入仓库 **Settings → Secrets and variables → Actions**。
3. 新建 Secret：`REFRESH_TOKEN`，值为你的阿里云盘 refresh_token（获取见 [CREDENTIALS.md](CREDENTIALS.md)）。
4. 可选：新建 Variable `DRY_RUN`=`1` 可先只查询不领奖。
5. 打开 **Actions** 标签，选中 `阿里云盘每日签到`，点 **Run workflow** 手动跑一次验证。
6. 之后按 cron 自动执行（UTC `30 7,8,14,20 * * *`，对应北京时间 15:30 / 16:30 / 22:30 / 次日 04:30）。

> workflow 用 `actions/cache` 保存 `.checkin-state.json`，并用 `concurrency` 保证同一时间只有一个实例，
> 所以"当天已签到"和"已推送过的渠道"在多次运行之间都能正确延续。

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

**推送规则：**

- 全部账号签到成功才推送，任一账号失败则完全不推送（避免误报成功）。
- 启用了几个渠道就各推一条；每个渠道每天最多一条，记录在 `.checkin-state.json`。
- 渠道返回 `ok=false` / `errcode!=0` / 非 2xx 都算失败，不记账，下一次运行自动补推。

## ⏰ 调整签到时间

编辑 [.github/workflows/checkin.yml](.github/workflows/checkin.yml) 的 `cron`。
GitHub Actions 使用 **UTC**，北京时间 = UTC + 8。例如北京时间 08:00 对应 `0 0 * * *`。

## 📁 目录结构

```text
aliyun-drive-checkin/
├─ .github/workflows/checkin.yml   # 定时任务配置（含状态缓存与并发控制）
├─ scripts/checkin.mjs             # 签到核心脚本（零依赖）
├─ scripts/checkin.test.mjs        # 回归测试（node --test）
├─ .env.example                    # 环境变量模板
├─ .checkin-state.json             # 运行状态（自动生成，已 gitignore）
├─ CREDENTIALS.md                  # token 获取指南
├─ package.json
└─ README.md
```

## 🧪 测试

```bash
npm test
```

覆盖：首次推送、同日第二次运行不重复签到/推送、渠道失败只补推失败渠道、账号失败不推送、业务失败判定、北京时区日期。

## ❓ FAQ

- **提示 refresh_token 已过期**：重新按 CREDENTIALS.md 获取一个新 token 并更新 Secret。
- **GitHub 定时任务没触发**：GitHub 对免费仓库的 cron 有延迟/暂停策略，可先手动 Run workflow 验证；仓库超过 60 天无任何活动会被暂停计划任务。
- **当天签到成功但没收到推送**：说明渠道调用失败（看日志 `[推送]` 行），下次运行会自动补推；已推送成功的渠道不会重发。
- **签到成功但没领到奖励**：奖励领取依赖当天任务状态，`status=finished` 才会领取，未完成任务不会重复领取。

## 📝 说明

`refresh_token` 等同于账号凭证，请仅存放在 GitHub Secrets 或本地 `.env` 中，不要提交到仓库或公开传播。
