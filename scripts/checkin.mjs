#!/usr/bin/env node
/**
 * 阿里云盘每日自动签到 —— 零依赖（Node 原生 fetch）
 *
 * 行为：
 *   1. 同一账号当天签到成功过 → 不再调用签到接口（状态持久化到 .checkin-state.json）
 *   2. 全部账号成功才推送，任一失败静默
 *   3. 每个推送渠道每天只推送一次（成功后立即落盘，跨 Actions 运行保持）
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const NL = "\n";
const CR = "\r";
export const TZ = "Asia/Shanghai";
export const DEFAULT_STATE_FILE = ".checkin-state.json";
const STATE_KEEP_DAYS = 14;

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export const API = {
  token: "https://auth.aliyundrive.com/v2/account/token",
  signList: "https://member.aliyundrive.com/v2/activity/sign_in_list?_rx-s=mobile",
  rewardV1: "https://member.aliyundrive.com/v1/activity/sign_in_reward?_rx-s=mobile",
  rewardV2: "https://member.aliyundrive.com/v2/activity/sign_in_task_reward?_rx-s=mobile",
};

let httpFetch = (...args) => globalThis.fetch(...args);
export function setFetchImpl(fn) { httpFetch = fn || ((...args) => globalThis.fetch(...args)); }

// ---------- 轻量 .env 加载 ----------
export function loadEnvFile(file, env) {
  const target = env || process.env;
  const p = path.resolve(file || path.join(process.cwd(), ".env"));
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
    if (!target[key]) target[key] = val;
  }
}

// ---------- 北京时间日期 ----------
export function beijingDate(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date || new Date());
  const pick = (type) => (parts.find((p) => p.type === type) || {}).value;
  return pick("year") + "-" + pick("month") + "-" + pick("day");
}

// ---------- 状态文件 ----------
export function statePath(file) {
  return path.resolve(process.cwd(), file || process.env.STATE_FILE || DEFAULT_STATE_FILE);
}

export function loadState(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(file), "utf8"));
    if (parsed && typeof parsed === "object" && parsed.days) {
      if (!parsed.version) parsed.version = 1;
      return parsed;
    }
  } catch { /* 文件不存在或损坏时重建 */ }
  return { version: 1, days: {} };
}

export function saveState(state, file) {
  const keys = Object.keys(state.days).sort();
  const drop = keys.slice(0, Math.max(0, keys.length - STATE_KEEP_DAYS));
  for (const key of drop) delete state.days[key];
  fs.writeFileSync(statePath(file), JSON.stringify(state, null, 2) + NL, "utf8");
}

export function dayOf(state, date) {
  if (!state.days[date]) state.days[date] = { accounts: {}, pushed: {} };
  const day = state.days[date];
  if (!day.accounts) day.accounts = {};
  if (!day.pushed) day.pushed = {};
  return day;
}

export function accountKey(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex").slice(0, 12);
}

// ---------- HTTP ----------
function diagErr(url, err, attempt) {
  const d = (err && err.cause) || err;
  const name = (d && (d.code || d.name)) || "";
  const extra = d && (d.syscall || d.hostname) ? " [" + d.syscall + " " + d.hostname + "]" : "";
  return new Error("[HTTP " + url.slice(0, 60) + "] attempt " + attempt + " failed: " + name + extra + " :: " + err.message);
}

export async function post(url, body, token, maxRetry, label) {
  const headers = { "Content-Type": "application/json", "User-Agent": UA };
  if (token) headers["Authorization"] = token;
  const payload = JSON.stringify(body);
  const attempts = Math.max(1, maxRetry || 1);
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      if (i > 1) {
        const wait = 1500 * Math.pow(2, i - 2);
        console.log("  [retry " + i + "/" + attempts + "] wait " + wait + "ms...");
        await new Promise((r) => setTimeout(r, wait));
      }
      const resp = await httpFetch(url, { method: "POST", headers, body: payload, signal: AbortSignal.timeout(20000) });
      const text = await resp.text();
      if (!resp.ok) throw new Error("HTTP " + resp.status + " " + resp.statusText + " body=" + text.slice(0, 200));
      let json;
      try { json = JSON.parse(text); } catch { throw new Error("响应非 JSON: " + String(text).slice(0, 200)); }
      return json;
    } catch (e) {
      lastErr = diagErr(url, e, i);
      console.log("  [attempt " + i + "] " + lastErr.message + (label ? "" : ""));
    }
  }
  throw lastErr;
}

export async function refreshToken(rt) {
  const json = await post(API.token, { grant_type: "refresh_token", refresh_token: rt }, null, 3);
  if (json.code) {
    const expired = json.code === "RefreshTokenExpired" || json.code === "InvalidParameter.RefreshToken";
    const err = new Error("刷新 token 失败: " + (expired ? "refresh_token 已过期或无效" : (json.message || json.code)));
    err.expired = expired;
    throw err;
  }
  if (!json.access_token) throw new Error("刷新 token 未返回 access_token");
  return json;
}

export function isAlreadySignedToday(signList) {
  const infos = (signList && signList.signInInfos) || [];
  const count = (signList && signList.signInCount) || infos.length;
  const last = infos[count - 1] || infos[infos.length - 1];
  return !!(last && last.status === "finished");
}

export async function doSignIn(accessToken) {
  const json = await post(API.signList, { isReward: false }, accessToken, 3);
  if (!json.success) throw new Error("签到失败: " + (json.message || json.code || "未知错误"));
  const result = json.result || {};
  const infos = result.signInInfos || [];
  const count = result.signInCount || infos.length;
  const today = infos[count - 1] || infos[infos.length - 1] || {};
  return { signList: result, count, today, alreadySigned: isAlreadySignedToday(result) };
}

// 领奖接口自 2024-05 起要求客户端签名，纯 HTTP 会 403；单次尝试，失败跳过
export async function claimRewards(accessToken, today, dryRun) {
  const rewards = (today && today.rewards) || [];
  const lines = [];
  for (const reward of rewards) {
    if (!reward || reward.status !== "finished") continue;
    let url = null;
    if (reward.type === "dailySignIn") url = API.rewardV1;
    else if (reward.type === "dailyTask") url = API.rewardV2;
    if (!url) continue;
    const label = reward.name || reward.type;
    if (dryRun) { lines.push("[DRY-RUN] 可领取: " + label); continue; }
    try {
      const resp = await httpFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": accessToken, "User-Agent": UA },
        body: JSON.stringify({ signInDay: today.day }),
        signal: AbortSignal.timeout(20000),
      });
      const text = await resp.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* 非 JSON 直接跳过 */ }
      if (resp.ok && json && json.success) {
        const info = json.result || {};
        lines.push("领奖成功: " + label + " " + (info.name || info.description || info.notice || ""));
      } else if (resp.status === 403) {
        console.log("  [领奖] " + label + " → 403 签名校验，跳过（不影响签到）");
      } else {
        console.log("  [领奖] " + label + " → " + ((json && json.message) || "HTTP " + resp.status) + "，跳过");
      }
    } catch (e) {
      console.log("  [领奖] " + label + " → " + e.message + "，跳过");
    }
  }
  return lines;
}

// ---------- 推送 ----------
export function buildChannels(title, text, env) {
  const e = env || process.env;
  const list = [];
  const sckey = e.SERVERCHAN_SCKEY;
  if (sckey) {
    list.push({ name: "ServerChan", send: () => httpFetch("https://sc.ftqq.com/" + sckey + ".send", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "text=" + encodeURIComponent(title) + "&desp=" + encodeURIComponent(text),
      signal: AbortSignal.timeout(20000),
    }) });
  }
  const pushplus = e.PUSHPLUS_TOKEN;
  if (pushplus) {
    list.push({ name: "PushPlus", send: () => httpFetch("https://www.pushplus.plus/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: pushplus, title, content: text.replaceAll(NL, "<br>"), template: "html" }),
      signal: AbortSignal.timeout(20000),
    }) });
  }
  const ding = e.DINGTALK_WEBHOOK;
  if (ding) {
    list.push({ name: "钉钉", send: () => httpFetch(ding, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msgtype: "text", text: { content: title + NL + text } }),
      signal: AbortSignal.timeout(20000),
    }) });
  }
  const wx = e.WECHAT_WEBHOOK;
  if (wx) {
    list.push({ name: "企业微信", send: () => httpFetch(wx, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msgtype: "text", text: { content: title + NL + text } }),
      signal: AbortSignal.timeout(20000),
    }) });
  }
  const tgToken = e.TELEGRAM_BOT_TOKEN;
  const tgChat = e.TELEGRAM_CHAT_ID;
  if (tgToken && tgChat) {
    list.push({ name: "Telegram", send: () => httpFetch("https://api.telegram.org/bot" + tgToken + "/sendMessage?chat_id=" + encodeURIComponent(tgChat) + "&text=" + encodeURIComponent(title + NL + text), {
      method: "GET",
      signal: AbortSignal.timeout(20000),
    }) });
  }
  const bark = e.BARK_URL;
  if (bark) {
    list.push({ name: "Bark", send: () => httpFetch(bark.replace(/\/$/, "") + "/" + encodeURIComponent(title) + "/" + encodeURIComponent(text), {
      method: "GET",
      signal: AbortSignal.timeout(20000),
    }) });
  }
  return list;
}

// 各渠道成功时返回 2xx，但服务端业务失败也会带 200，需要看响应体
export function parseChannelFailure(body) {
  if (!body) return null;
  let json;
  try { json = JSON.parse(body); } catch { return null; }
  if (json.ok === false) return String(json.description || json.error_code || "ok=false");
  if (typeof json.errcode === "number" && json.errcode !== 0) return String(json.errmsg || "errcode=" + json.errcode);
  if (typeof json.code === "number" && json.code !== 0 && json.code !== 200) return String(json.message || "code=" + json.code);
  return null;
}

export async function pushAll(state, day, title, text, options) {
  const opts = options || {};
  const channels = buildChannels(title, text, opts.env);
  const report = [];
  if (!channels.length) {
    console.log("  [推送] 未配置任何渠道");
    return report;
  }
  for (const channel of channels) {
    if (day.pushed[channel.name]) {
      console.log("  [推送] " + channel.name + " 今日已推送过，跳过");
      report.push({ channel: channel.name, result: "duplicate" });
      continue;
    }
    try {
      const resp = await channel.send();
      const body = await resp.text().catch(() => "");
      const appError = parseChannelFailure(body);
      if (resp.ok && !appError) {
        day.pushed[channel.name] = new Date().toISOString();
        if (opts.persist !== false) saveState(state, opts.stateFile);
        console.log("  [推送] " + channel.name + " 已推送");
        report.push({ channel: channel.name, result: "sent" });
      } else {
        const detail = appError || ("HTTP " + resp.status + " " + body.slice(0, 120));
        console.log("  [推送] " + channel.name + " 失败: " + detail + "（下次运行会重试）");
        report.push({ channel: channel.name, result: "failed", detail });
      }
    } catch (e) {
      console.log("  [推送] " + channel.name + " 异常: " + e.message + "（下次运行会重试）");
      report.push({ channel: channel.name, result: "error", detail: e.message });
    }
  }
  return report;
}

// ---------- 主流程 ----------
export async function main() {
  loadEnvFile();
  const raw = process.env.REFRESH_TOKEN;
  if (!raw) { console.error("缺少 REFRESH_TOKEN 环境变量"); process.exit(1); }
  const tokens = String(raw).split("&").flatMap((x) => x.split(NL)).map((x) => String(x).replace(CR, "").trim()).filter(Boolean);
  if (!tokens.length) { console.error("REFRESH_TOKEN 解析为空"); process.exit(1); }
  const dryRun = process.env.DRY_RUN === "1";
  const date = beijingDate(new Date());
  const stateFile = statePath();
  const state = loadState();
  const day = dayOf(state, date);

  console.log("阿里云盘自动签到");
  console.log("日期(北京) " + date);
  console.log("账号数量   " + tokens.length);
  console.log("DRY_RUN    " + dryRun);
  console.log("状态文件   " + path.basename(stateFile));
  console.log("----");

  const summary = [];
  let failed = 0;
  let performed = 0;

  for (let i = 0; i < tokens.length; i++) {
    const key = accountKey(tokens[i]);
    const record = day.accounts[key];
    let remarks = "账号" + (i + 1);
    if (record && record.signed) {
      const nick = record.nick || remarks;
      console.log("  " + nick + "：今日已签到，跳过签到接口调用");
      summary.push("OK   " + nick + "：今日已签到，未重复执行");
      continue;
    }
    try {
      const t = await refreshToken(tokens[i]);
      if (t.nick_name) remarks = t.nick_name + "(" + remarks + ")";
      const signed = await doSignIn(t.access_token);
      performed++;
      let msg = remarks + "：签到成功，本月累计 " + signed.count + " 天";
      const claim = await claimRewards(t.access_token, signed.today, dryRun);
      if (claim.length) msg += NL + "  " + claim.join(NL + "  ");
      console.log("  " + msg);
      summary.push("OK   " + msg);
      day.accounts[key] = { signed: true, at: new Date().toISOString(), nick: remarks, count: signed.count };
      if (!dryRun) saveState(state);
    } catch (e) {
      failed++;
      const tag = e.expired ? "[TOKEN过期] " : "";
      console.log("  " + remarks + "：失败 - " + e.message);
      summary.push("NG   " + remarks + "：" + tag + e.message);
    }
  }

  console.log("----");
  console.log("完成：成功 " + (tokens.length - failed) + " / " + tokens.length + "，本次新签到 " + performed + " 个账号");

  if (failed > 0) {
    console.log("（有失败，本次不推送）");
    process.exitCode = 1;
    return;
  }

  // 只看"还没推送过的渠道"：失败的渠道下次运行会补推，已成功的不重复
  const configured = buildChannels("", "", process.env).map((c) => c.name);
  if (!configured.length) {
    console.log("（未配置推送渠道，跳过推送）");
    return;
  }
  const missing = configured.filter((name) => !day.pushed[name]);
  if (!missing.length) {
    console.log("（今日所有渠道均已推送，本次不推送）");
    return;
  }
  if (performed === 0) {
    console.log("（今日已签到，仅补推未成功的渠道：" + missing.join("、") + "）");
  }

  await pushAll(state, day, "阿里云盘签到 " + date + " ✅", summary.join(NL + NL), { stateFile });
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
if (process.env.CHECKIN_SKIP_MAIN !== "1" && invokedDirectly) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
