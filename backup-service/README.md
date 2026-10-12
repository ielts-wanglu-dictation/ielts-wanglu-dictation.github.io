# GitHub 私有备份服务

为 [听见进步](https://ielts-wanglu-dictation.github.io) 提供 GitHub App 登录与私有仓库备份。它是独立部署的 Node.js 22 ESM API，没有数据库、npm 依赖或本地持久文件。

本实例的稳定生产地址为 `https://wanglu-backup-service.vercel.app`，GitHub App Callback URL 为 `https://wanglu-backup-service.vercel.app/auth/callback`。服务端配置位于 [Vercel 项目环境变量](https://vercel.com/liuys117810-6281s-projects/wanglu-backup-service/settings/environment-variables)，健康检查为 [`/health`](https://wanglu-backup-service.vercel.app/health)。部署状态 READY 表示代码构建完成；只有配置完整、真实 GitHub 登录与备份验证通过后，才能认为自动备份已启用。

只允许 GitHub 用户 **scpsyl，数字 ID `89184687`**。只读写私有仓库 `ielts-wanglu-dictation/wanglu-dictation-backups` 的 `main` 分支：当前备份只写 `latest.json`，历史快照只读 `snapshots/index.json` 和 `snapshots/YYYY-MM-DD.json`。每次备份请求都会检查仓库仍为私有。

## GitHub App 配置

1. 在组织的 [GitHub Apps 设置](https://github.com/organizations/ielts-wanglu-dictation/settings/apps) 注册应用。将应用设为仅所有者可安装时，应用必须由 `ielts-wanglu-dictation` 组织拥有，才能安装到该组织的私有仓库。
2. Homepage URL 填 `https://ielts-wanglu-dictation.github.io`。
3. 确定 Vercel 的稳定生产域名后，将 **Callback URL** 精确设为 `https://你的生产域名/auth/callback`。不附带查询参数或其他跳转地址。
4. Repository permissions 只授予 **Contents: Read and write**；Metadata 的只读权限由 GitHub 自动包含。不需要其他仓库权限、账户权限或 webhook。可关闭 Webhook 的 Active 选项。
5. 保持 user-to-server token expiration 开启。**不要勾选 Request user authorization (OAuth) during installation**，也不要开启设备登录流程。不要使用传统 OAuth App 的 `repo` scope。
6. 将 GitHub App 安装到组织，仅选择 `wanglu-dictation-backups` 一个仓库。安装与服务配置完成后，从听写站点的“连接 GitHub”按钮开始授权，才能先建立登录所需的 state、PKCE 和弹窗 nonce；安装时直接发起 OAuth 不具备这些验证上下文，会被服务拒绝。
7. 在应用设置中取得 **Client ID** 并生成 **Client secret**。服务使用 OAuth 用户授权，不需要 GitHub App 私钥或个人 PAT。Client secret 只保存到 Vercel 服务端环境变量。

GitHub App 的权限由应用配置、安装仓库和用户自身权限共同限制；本服务的 OAuth 请求不传任何权限 scope，使用 PKCE S256 和随机 state 验证流程。[官方 GitHub App 用户授权文档](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)

## Vercel 部署

从站点源码仓库创建一个**独立 Vercel 项目**，Root Directory 选择 `backup-service`，Framework Preset 选择 **Other**，Node.js 使用 **22.x**。不设置框架构建命令或静态产物目录，保留此目录的 `vercel.json` 原生 Function 配置。GitHub Pages 前端继续按原工作流部署。

部署服务后，在 Vercel 项目 **Settings → Environment Variables** 设置以下 Production 环境变量，再重新部署：

| 变量 | 内容 |
| --- | --- |
| `GITHUB_CLIENT_ID` | GitHub App Client ID |
| `GITHUB_CLIENT_SECRET` | GitHub App Client secret，保密 |
| `SESSION_SECRET` | 随机 32 字节，标准 Base64 编码，保密 |
| `ALLOWED_GITHUB_USER_ID` | `89184687` |
| `APP_ORIGIN` | `https://ielts-wanglu-dictation.github.io` |
| `SERVICE_ORIGIN` | 稳定的 HTTPS 生产 origin，无结尾斜杠或路径 |
| `BACKUP_OWNER` | `ielts-wanglu-dictation` |
| `BACKUP_REPO` | `wanglu-dictation-backups` |

可以在可信终端用 `node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))"` 生成 `SESSION_SECRET`，只粘贴到服务端秘密配置中，不提交进 Git、前端配置或聊天记录。`.env.example` 不包含真实秘密，真实 `.env` 文件被 Git 忽略。

确认 GitHub App Callback URL 与 `SERVICE_ORIGIN + '/auth/callback'` 完全一致。部署的 API 应允许公网请求到达；若启用了 Vercel Deployment Protection，前端无法直接调用，需针对这个生产 API 调整保护设置。API 自身仍要求账户验证和显式 Bearer 会话，不因公网可访问而开放备份数据。

`GET /health` 成功返回 `{"ok":true,...}` 才表示配置完整；配置缺失时返回 503，且不会透露缺少哪个秘密或任何秘密内容。然后在前端配置服务的生产 URL，手动连接 GitHub，验证首次保存、读取和历史备份。预览域名不会自动成为受信任回调域名。

## API 契约

浏览器只从固定的 `APP_ORIGIN` 调用。API 不使用 cookie 身份验证；所有学习数据读取与写入都要求 `Authorization: Bearer <opaque session>`。

| 接口 | 请求 / 响应 |
| --- | --- |
| `GET /auth/start?nonce=...` | 16–128 位 Base64URL 字符的随机前端 nonce；302 到 GitHub |
| `GET /auth/callback` | GitHub 回调；向原窗口固定 origin 发送 `{type:'wanglu-auth',nonce,session,user}` |
| `GET /api/session` | `{user:{id,login,avatarUrl},repo:{owner,name,private:true},expiresAt}` |
| `GET /api/backup` | `{exists,sha,envelope}` 或 `{exists,sha,envelopeGzip}` |
| `PUT /api/backup` | `{baseSha,envelope}` 或 `{baseSha,envelopeGzip}`；成功 `{sha}` |
| `GET /api/snapshots` | `{snapshots:[{date,path,stateHash,revisionId,archivedAt,sourceUpdatedAt,sourceCommit}]}` |
| `GET /api/backup?date=YYYY-MM-DD` | 指定日期只读快照，格式同当前备份 |
| `POST /api/logout` | 撤销当前会话对应的 GitHub 用户 token，返回 `{ok:true}` |

初次写入必须显式传 `baseSha:null`，后续写入传上次获取的文件 SHA。备份的 `parentRevisionId` 还必须等于当前云端 `revisionId`。如果另一设备更新了云端，返回 HTTP **409** 和 `CONFLICT`，绝不自动重试覆盖。

错误结构为 `{error:{code,message}}`。有效 OAuth state 下的登录错误通过 `{type:'wanglu-auth',nonce,error:{code,message}}` 返回原窗口。前端必须同时校验 `event.origin`、`event.source` 和 nonce，不能只校验消息类型。

身份验证后的 API 成功或错误响应可能包含 `refreshedSession` 与 `expiresAt`。前端应先原子替换自己的会话，再处理其他响应字段。会话本身不能用于调用 GitHub，也不含前端可解密的 GitHub token。

## 备份格式与压缩

```json
{
  "format": "wanglu-github-backup",
  "version": 1,
  "revisionId": "a UUID",
  "parentRevisionId": null,
  "updatedAt": "2026-10-12T06:00:00.000Z",
  "studyDay": "2026-10-12",
  "state": { "version": 1, "settings": {}, "history": [], "reviews": {}, "draft": null },
  "stateHash": "SHA-256 lowercase hexadecimal"
}
```

`stateHash` 是规范化 JSON 的 UTF-8 SHA-256：对象键递归按 JavaScript `.sort()` 排序，数组保留顺序，原始类型使用 `JSON.stringify`。服务校验结构、摘要、大小和危险键；前端另行使用完整学习数据模型验证，服务不会修改或自动合并学习记录。

Vercel Function 单次请求和响应存在 4.5 MB 平台限制，因此超过 256 KiB 的响应使用 Base64 编码的 gzip `envelopeGzip`；前端较大请求也使用该字段。解压后最多 **10 MiB**，gzip 本体最多 **3 MiB**，解压过程限制输出大小。未压缩的大于 4 MB 请求会被要求压缩。GitHub 仓库仍保存可读 JSON。[Vercel 官方大小限制](https://vercel.com/docs/functions/limitations#request-body-size)

读取超过 1 MB 的 GitHub 文件时，服务按 Contents 返回的不可变 blob SHA 获取完整内容并校验，避免当前文件在两次请求间改变而造成 SHA 与内容错配。[GitHub blob API](https://docs.github.com/en/rest/git/blobs#get-a-blob)

## 会话与退出行为

GitHub token 与 refresh token 仅封装在服务端 AES-256-GCM 加密会话中；随机 IV 和附加验证数据把会话绑定到固定服务、前端和用户。登录 state 单独加密保存在 `HttpOnly; Secure; SameSite=Lax` cookie，十分钟过期，回调后清除。API 不接受这个 cookie 作为授权。

GitHub 用户 token 通常八小时过期。服务按需使用 refresh token 轮换 GitHub 凭据，并通过 `refreshedSession` 交回新的加密会话；本服务会话最长三十天。GitHub refresh token 使用后会失效，因此多个持有同一旧会话的标签页同时刷新时，部分标签页可能需要重新登录。客户端应串行发送同步请求。[GitHub token 轮换说明](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens)

退出时前端应立即清除本机服务会话，并尽力调用 `/api/logout`；网络失败不阻塞本机退出。撤销接口针对当前 GitHub token，不是撤销整个 GitHub App 授权。复制同一会话的其他标签页也会受到当前 token 撤销的影响。若需要彻底撤销 App 授权，可在 GitHub 个人账户的授权应用设置中操作。更换 `SESSION_SECRET` 会让全部已发出的服务会话失效。

服务没有数据库或后台守护进程，不运行定时归档。每日快照由私有备份仓库中的独立工作流维护。

## 验证

在 `backup-service` 目录运行：

```sh
npm run check
npm test
```

测试使用内存 GitHub API 模拟，不需要真实凭据，不访问真实仓库。覆盖 PKCE 与 state、禁止账户、会话篡改、CORS、私有仓库限制、SHA 和父版本冲突、压缩与解压上限、Git blob 读取、token 刷新、历史快照和退出撤销。真实 GitHub App 登录与 Vercel 发布还需部署后的端到端验证。
