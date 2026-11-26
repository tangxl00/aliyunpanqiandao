import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.CHECKIN_SKIP_MAIN = "1";
const mod = await import("./checkin.mjs");

const {
  main, setFetchImpl, loadState, statePath, beijingDate, buildChannels, parseChannelFailure,
} = mod;

let dir;
let savedEnv;
let calls;

function jsonResponse(body, status) {
  const code = status || 200;
  return {
    ok: code >= 200 && code < 300,
    status: code,
    statusText: code === 200 ? "OK" : "ERR",
    text: async () => JSON.stringify(body),
  };
}

function installFetch(handlers) {
  calls = [];
  setFetchImpl(async (url, options) => {
    const u = String(url);
    calls.push(u);
    for (const [fragment, handler] of handlers) {
      if (u.includes(fragment)) return handler(u, options);
    }
    throw new Error("unexpected request: " + u);
  });
}

// 一个已经"今日签到完成"的 sign_in_list 响应
function signedResponse(day) {
  return jsonResponse({
    success: true,
    result: {
      signInCount: day || 7,
      signInInfos: [{ day: day || 7, status: "finished", rewards: [] }],
    },
  });
}

const tokenResponse = jsonResponse({ access_token: "AT-1", nick_name: "tester", refresh_token: "RT-1" });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "checkin-test-"));
  savedEnv = { ...process.env };
  process.env.STATE_FILE = path.join(dir, "state.json");
  process.env.REFRESH_TOKEN = "token-A";
  delete process.env.SERVERCHAN_SCKEY;
  delete process.env.PUSHPLUS_TOKEN;
  delete process.env.DINGTALK_WEBHOOK;
  delete process.env.WECHAT_WEBHOOK;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
  delete process.env.BARK_URL;
  process.env.DRY_RUN = "0";
  process.exitCode = 0;
});

afterEach(() => {
  setFetchImpl(null);
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exitCode = 0;
});

test("首次运行：签到成功后每个渠道各推送一次", async () => {
  process.env.SERVERCHAN_SCKEY = "SC";
  process.env.PUSHPLUS_TOKEN = "PP";
  installFetch([
    ["/v2/account/token", () => tokenResponse],
    ["sign_in_list", () => signedResponse(7)],
    ["sc.ftqq.com", () => jsonResponse({ code: 0 })],
    ["pushplus.plus", () => jsonResponse({ code: 200, msg: "ok" })],
  ]);

  await main();

  const pushes = calls.filter((u) => u.includes("sc.ftqq.com") || u.includes("pushplus.plus"));
  assert.equal(pushes.length, 2, "两个渠道各推一次");
  assert.equal(calls.filter((u) => u.includes("sign_in_list")).length, 1);

  const state = loadState();
  const day = state.days[beijingDate(new Date())];
  assert.ok(day.pushed.ServerChan, "ServerChan 已记录");
  assert.ok(day.pushed.PushPlus, "PushPlus 已记录");
  assert.equal(Object.values(day.accounts)[0].signed, true);
});

test("当天第二次运行：不再调用签到接口，也不再推送", async () => {
  process.env.SERVERCHAN_SCKEY = "SC";
  process.env.PUSHPLUS_TOKEN = "PP";
  installFetch([
    ["/v2/account/token", () => tokenResponse],
    ["sign_in_list", () => signedResponse(7)],
    ["sc.ftqq.com", () => jsonResponse({ code: 0 })],
    ["pushplus.plus", () => jsonResponse({ code: 200 })],
  ]);
  await main();
  const firstRunCalls = calls.length;
  calls = [];

  await main();

  assert.equal(calls.filter((u) => u.includes("sign_in_list")).length, 0, "第二次不再调用签到接口");
  assert.equal(calls.filter((u) => u.includes("sc.ftqq.com")).length, 0, "第二次不再推送 ServerChan");
  assert.equal(calls.filter((u) => u.includes("pushplus.plus")).length, 0, "第二次不再推送 PushPlus");
  assert.ok(firstRunCalls > 0);
});

test("渠道失败不记账，下一次运行只补推失败的那个渠道", async () => {
  process.env.SERVERCHAN_SCKEY = "SC";
  process.env.PUSHPLUS_TOKEN = "PP";
  let pushplusFails = true;
  installFetch([
    ["/v2/account/token", () => tokenResponse],
    ["sign_in_list", () => signedResponse(7)],
    ["sc.ftqq.com", () => jsonResponse({ code: 0 })],
    ["pushplus.plus", () => (pushplusFails ? jsonResponse({ error: "boom" }, 500) : jsonResponse({ code: 200 }))],
  ]);

  await main();
  let day = loadState().days[beijingDate(new Date())];
  assert.ok(day.pushed.ServerChan, "成功的渠道已记录");
  assert.equal(day.pushed.PushPlus, undefined, "失败的渠道不记录");

  pushplusFails = false;
  calls = [];
  await main();

  assert.equal(calls.filter((u) => u.includes("pushplus.plus")).length, 1, "只补推 PushPlus");
  assert.equal(calls.filter((u) => u.includes("sc.ftqq.com")).length, 0, "ServerChan 不重复推送");
  assert.equal(calls.filter((u) => u.includes("sign_in_list")).length, 0, "不重复签到");
  day = loadState().days[beijingDate(new Date())];
  assert.ok(day.pushed.PushPlus);
});

test("账号失败：不推送且退出码非 0", async () => {
  process.env.SERVERCHAN_SCKEY = "SC";
  installFetch([
    ["/v2/account/token", () => jsonResponse({ code: "RefreshTokenExpired", message: "expired" })],
    ["sc.ftqq.com", () => jsonResponse({ code: 0 })],
  ]);

  await main();

  assert.equal(calls.filter((u) => u.includes("sc.ftqq.com")).length, 0, "失败不推送");
  assert.equal(process.exitCode, 1);
});

test("业务失败（HTTP 200 但 ok=false）也算失败，下次重试", async () => {
  process.env.PUSHPLUS_TOKEN = "PP";
  installFetch([
    ["/v2/account/token", () => tokenResponse],
    ["sign_in_list", () => signedResponse(7)],
    ["pushplus.plus", () => jsonResponse({ code: 200, msg: "ok" })],
  ]);
  await main();
  const day = loadState().days[beijingDate(new Date())];
  assert.ok(day.pushed.PushPlus, "正常响应记为成功");

  assert.equal(parseChannelFailure(JSON.stringify({ ok: false, error_code: 40001 })), "40001");
  assert.equal(parseChannelFailure(JSON.stringify({ errcode: 93000, errmsg: "invalid webhook" })), "invalid webhook");
  assert.equal(parseChannelFailure(JSON.stringify({ code: 0 })), null);
});

test("去掉 ServerChan 后只配 PushPlus：只推一次，旧的 ServerChan 记录不影响", async () => {
  process.env.PUSHPLUS_TOKEN = "PP"; // 不再配置 SERVERCHAN_SCKEY
  const date = beijingDate(new Date());
  const seed = { version: 1, days: { [date]: { accounts: {}, pushed: { ServerChan: "2026-11-26T02:00:00.000Z" } } } };
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(seed));

  installFetch([
    ["/v2/account/token", () => tokenResponse],
    ["sign_in_list", () => signedResponse(7)],
    ["pushplus.plus", () => jsonResponse({ code: 200 })],
  ]);

  await main();

  assert.equal(calls.filter((u) => u.includes("pushplus.plus")).length, 1, "PushPlus 推一次");
  assert.equal(calls.filter((u) => u.includes("sc.ftqq.com")).length, 0, "不再调用 ServerChan");
  assert.ok(loadState().days[date].pushed.PushPlus, "PushPlus 已记账");
});

test("只配 PushPlus 且今天已推过：第二次运行不再推送", async () => {
  process.env.PUSHPLUS_TOKEN = "PP";
  installFetch([
    ["/v2/account/token", () => tokenResponse],
    ["sign_in_list", () => signedResponse(7)],
    ["pushplus.plus", () => jsonResponse({ code: 200 })],
  ]);

  await main();
  assert.equal(calls.filter((u) => u.includes("pushplus.plus")).length, 1);

  calls = [];
  await main();

  assert.equal(calls.filter((u) => u.includes("pushplus.plus")).length, 0, "第二次不重复推送");
  assert.equal(calls.filter((u) => u.includes("sign_in_list")).length, 0, "第二次不重复签到");
});

test("北京时区日期按 UTC+8 计算", () => {
  const utcLate = new Date("2026-11-25T18:30:00Z");
  assert.equal(beijingDate(utcLate), "2026-11-26");
  const utcEarly = new Date("2026-11-25T02:00:00Z");
  assert.equal(beijingDate(utcEarly), "2026-11-25");
});

test("多渠道构建：只包含已配置的渠道", () => {
  const none = buildChannels("t", "x", {});
  assert.equal(none.length, 0);
  const two = buildChannels("t", "x", { SERVERCHAN_SCKEY: "a", BARK_URL: "https://bark.example" });
  assert.deepEqual(two.map((c) => c.name), ["ServerChan", "Bark"]);
  const tgMissingChat = buildChannels("t", "x", { TELEGRAM_BOT_TOKEN: "t" });
  assert.equal(tgMissingChat.length, 0, "Telegram 缺少 chat_id 不启用");
});
