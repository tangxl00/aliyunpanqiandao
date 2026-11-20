# 获取 refresh_token

`refresh_token` 是阿里云盘用于免密续期的凭证，脚本靠它换取 `access_token` 完成签到。

## 方法一：浏览器控制台（推荐）

1. 打开并登录 [阿里云盘网页版](https://www.aliyundrive.com/drive/)。
2. 按 `F12` 打开开发者工具，切到 **Console（控制台）**。
3. 粘贴下面这行并回车：

   ```javascript
   copy(JSON.parse(localStorage.token).refresh_token)
   ```

4. token 已复制到剪贴板，直接粘贴到 GitHub Secrets 即可。

## 方法二：手动查看

1. 登录后打开开发者工具 → **Application → Local Storage → https://www.aliyundrive.com**。
2. 找到 `token` 这一项，点开是一段 JSON。
3. 复制其中 `refresh_token` 字段的**值**（长字符串），不是整段 JSON。

## 多账号

多个账号的 token 用 `&` 或换行分隔，脚本会逐个签到：

```text
token_aaa&token_bbb&token_ccc
```

> 注意：`refresh_token` 等同于账号凭证，请只放进 GitHub Secrets，切勿提交到仓库或公开传播。
