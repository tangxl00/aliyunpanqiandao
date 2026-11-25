#!/usr/bin/env node
/**
 * 阿里云盘每日自动签到 —— 零依赖（Node 原生 fetch）
 * 行为：
 *   - 今日已签到 → 立即退出，不发任何推送
 *   - 全部账号签到成功 → 发成功推送
 *   - 有账号失败 → 不发推送
 */

import fs from "node:fs";
import path from "node:path";

const NL = String.fromCharCode(10);
const CR = String.fromCharCode(13);

// ---------- 轻量 .env 加载 ----------
function loadEnvFile() {
  const p = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(p)) return;
  const text = fs.readFileSync(p, "utf8");
  for (const raw of text.split(NL)) {
    const line = String(raw).replace(CR, "").trim();
    if (!line || line[0] === "#") continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (val.length > 1 && ((val[0] === '"' && val[val.length - 1] === '"') || (val[0] === "'" && val[val.length - 1] === "'"))) val = val.slice(1, -1);
    if (!process.env[key]) process.env[key] = val;
  }
}

// ---------- 阿里云盘接口 ----------
const API = {
  token:     "https://auth.aliyundrive.com/v2/account/token",
  signList:  "https://member.aliyundrive.com/v2/activity/sign_in_list?_rx-s=mobile",
  rewardV1:  "https://member.aliyundrive.com/v1/activity/sign_in_reward?_rx-s=mobile",
  rewardV2:  "https://member.aliyundrive.com/v2/activity/sign_in_task_reward?_rx-s=mobile",
};

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function diagErr(url, err, attempt) {
  const d = err && err.cause || err;
  const name = d && (d.code || d.name) || "";
  const extra = d && (d.syscall || d.hostname) ? (" [" + d.syscall + " " + d.hostname + "]") : "";
  return new Error("[HTTP " + url.slice(0, 60) + "] attempt " + attempt + " failed: " + name + (extra ? extra : "") + " :: " + err.message);
}

async function post(url, body, token, maxRetry) {
  const headers = { "Content-Type": "application/json", "User-Agent": UA };
  if (token) headers["Authorization"] = token;
  const payload = JSON.stringify(body);
  let lastErr;
  for (let i = 1; i <= maxRetry; i++) {
    try {
      if (i > 1) { const wait = 1500 * Math.pow(2, i - 2); console.log("  [retry " + i + "/" + maxRetry + "] wait " + wait + "ms..."); await new Promise(r => setTimeout(r, wait)); }
      const resp = await fetch(url, { method: "POST", headers, body: payload, signal: AbortSignal.timeout(20000) });
      const text = await resp.text();
      if (!resp.ok) throw new Error("HTTP " + resp.status + " " + resp.statusText + " body=" + text.slice(0, 200));
      let json; try { json = JSON.parse(text); } catch { throw new Error("响应非 JSON: " + String(text).slice(0, 200)); }
      return json;
    } catch (e) { lastErr = diagErr(url, e, i); console.log("  [attempt " + i + "] " + lastErr.message); }
  }
  throw lastErr;
}

async function refreshToken(rt) {
  const json = await post(API.token, { grant_type: "refresh_token", refresh_token: rt }, null, 3);
  if (json.code) {
    const expired = json.code === "RefreshTokenExpired" || json.code === "InvalidParameter.RefreshToken";
    const err = new Error("刷新 token 失败: " + (expired ? "refresh_token 已过期或无效" : (json.message || json.code)));
    err.expired = expired; throw err;
  }
  if (!json.access_token) throw new Error("刷新 token 未返回 access_token");
  return json;
}

// 判断当天是否已经签过：sign_in_list 里的最后一条记录如果 status=finished 就是今日已签到
function isAlreadySignedToday(signList) {
  const infos = signList.signInInfos || [];
  const count = signList.signInCount || infos.length;
  const last = infos[count - 1] || infos[infos.length - 1];
  return !!(last && last.status === "finished");
}

async function doSignIn(accessToken) {
  const json = await post(API.signList, { isReward: false }, accessToken, 3);
  if (!json.success) throw new Error("签到失败: " + (json.message || json.code || "未知错误"));
  const result = json.result || {};
  return { signList: result, alreadySigned: isAlreadySignedToday(result) };
}

// 注意：阿里云盘领奖接口从 2024-05 起引入客户端级签名校验，纯 HTTP 调用会 403。
// 这里只做一次尝试，不重试，失败直接跳过，不影响签到成功判定。
async function claimRewards(accessToken, today, dryRun) {
  const rewards = (today && today.rewards) || [];
  const lines = [];
  if (dryRun) {
    for (const reward of rewards) {
      if (!reward || reward.status !== "finished") continue;
      const label = reward.name || reward.type;
      lines.push("[DRY-RUN] 可领取: " + label);
    }
    return lines;
  }
  for (const reward of rewards) {
    if (!reward || reward.status !== "finished") continue;
    let url = null;
    if (reward.type === "dailySignIn") url = API.rewardV1;
    else if (reward.type === "dailyTask") url = API.rewardV2;
    if (!url) continue;
    const label = reward.name || reward.type;
    try {
      // 1 次尝试，不 retry（403 是签名校验不过，retry 没用）
      const resp = await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json", "Authorization": accessToken, "User-Agent": UA },
        body: JSON.stringify({ signInDay: today.day }), signal: AbortSignal.timeout(20000),
      });
      const text = await resp.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* non-JSON skip */ }
      if (resp.ok && json && json.success) {
        const info = json.result || {};
        lines.push("领奖成功: " + label + " " + (info.name || info.description || info.notice || ""));
      } else if (resp.status === 403) {
        // 阿里云盘要求客户端签名，领奖接口暂时无法纯 HTTP 调用，跳过
        console.log("  [领奖] " + label + " → 403 签名校验，跳过（不影响签到）");
      } else {
        const detail = (json && json.message) || "HTTP " + resp.status;
        console.log("  [领奖] " + label + " → " + detail + "，跳过");
      }
    } catch (e) {
      console.log("  [领奖] " + label + " → " + e.message + "，跳过");
    }
  }
  return lines;
}

// ---------- 消息推送（可选）----------
function send(url, options, label) { return fetch(url, options).then(function () { return label + " 已推送"; }).catch(function (e) { return label + " 失败: " + e.message; }); }

async function push(title, text) {
  const jobs = [];
  const sckey = process.env.SERVERCHAN_SCKEY;
  if (sckey) jobs.push(send("https://sc.ftqq.com/" + sckey + ".send", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "text=" + encodeURIComponent(title) + "&desp=" + encodeURIComponent(text) }, "ServerChan"));
  const pushplus = process.env.PUSHPLUS_TOKEN;
  if (pushplus) jobs.push(send("https://www.pushplus.plus/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: pushplus, title: title, content: text.replaceAll(NL, "<br>"), template: "html" }) }, "PushPlus"));
  const ding = process.env.DINGTALK_WEBHOOK;
  if (ding) jobs.push(send(ding, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ msgtype: "text", text: { content: title + NL + text } }) }, "钉钉"));
  const wx = process.env.WECHAT_WEBHOOK;
  if (wx) jobs.push(send(wx, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ msgtype: "text", text: { content: title + NL + text } }) }, "企业微信"));
  const tgToken = process.env.TELEGRAM_BOT_TOKEN;
  const tgChat = process.env.TELEGRAM_CHAT_ID;
  if (tgToken && tgChat) jobs.push(send("https://api.telegram.org/bot" + tgToken + "/sendMessage?chat_id=" + encodeURIComponent(tgChat) + "&text=" + encodeURIComponent(title + NL + text), { method: "GET" }, "Telegram"));
  const bark = process.env.BARK_URL;
  if (bark) jobs.push(send(bark.replace(/\/$/, "") + "/" + encodeURIComponent(title) + "/" + encodeURIComponent(text), { method: "GET" }, "Bark"));
  if (jobs.length) {
    const results = await Promise.allSettled(jobs);
    for (const r of results) console.log("  [推送] " + (r.status === "fulfilled" ? r.value : "失败: " + r.reason));
  }
}

// ---------- 主流程 ----------
async function main() {
  loadEnvFile();
  const raw = process.env.REFRESH_TOKEN;
  if (!raw) { console.error("缺少 REFRESH_TOKEN 环境变量"); process.exit(1); }
  const tokens = String(raw).split("&").flatMap(function (x) { return x.split(NL); }).map(function (x) { return String(x).replace(CR, "").trim(); }).filter(Boolean);
  if (!tokens.length) { console.error("REFRESH_TOKEN 解析为空"); process.exit(1); }
  const dryRun = process.env.DRY_RUN === "1";

  console.log("阿里云盘自动签到");
  console.log("账号数量  " + tokens.length);
  console.log("DRY_RUN   " + dryRun);
  console.log("----");

  const summary = [];
  let hadFailed = false;

  for (let i = 0; i < tokens.length; i++) {
    let remarks = "账号" + (i + 1);
    try {
      const t = await refreshToken(tokens[i]);
      if (t.nick_name) remarks = t.nick_name + "(" + remarks + ")";
      const signed = await doSignIn(t.access_token);

      // 今日已签到 —— 立即退出，不再跑后续账号，不发推送
      if (signed.alreadySigned) {
        console.log("  " + remarks + "：今日已签到，跳过本次 run");
        console.log("  原因：阿里云盘签到接口幂等且已标记今日 finished，再跑也没意义");
        console.log("  本 run 将静默退出，不发任何推送");
        console.log("----");
        process.exit(0);
      }

      const infos = signed.signList.signInInfos || [];
      const count = signed.signList.signInCount || infos.length;
      const today = infos[count - 1] || infos[infos.length - 1] || {};
      let msg = remarks + "：签到成功，本月累计 " + count + " 天";
      const claim = await claimRewards(t.access_token, today, dryRun);
      if (claim.length) msg += NL + "  " + claim.join(NL + "  ");
      console.log("  " + msg);
      summary.push("OK   " + msg);
    } catch (e) {
      hadFailed = true;
      const tag = e.expired ? "[TOKEN过期] " : "";
      console.log("  " + remarks + "：失败 - " + e.message);
      summary.push("NG   " + remarks + "：" + tag + e.message);
    }
  }

  const ok = summary.filter(function (s) { return s.indexOf("OK") === 0; }).length;
  console.log("----");
  console.log("完成：成功 " + ok + " / " + tokens.length);

  // 全部成功才推送；有任何失败或已签到都静默（失败由 exit 码判断）
  if (!hadFailed && ok === tokens.length) {
    const date = new Date().toISOString().slice(0, 10);
    await push("阿里云盘签到 " + date + " ✅", summary.join(NL + NL));
  } else {
    console.log("（有失败或已签到，本次不推送）");
  }

  if (ok === 0 || hadFailed) process.exit(1);
}

main().catch(function (e) { console.error(e); process.exit(1); });