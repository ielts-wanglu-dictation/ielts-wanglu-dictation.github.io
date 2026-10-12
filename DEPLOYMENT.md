# 发布与维护

目标仓库：[ielts-wanglu-dictation.github.io](https://github.com/ielts-wanglu-dictation/ielts-wanglu-dictation.github.io)。

目标网址：[https://ielts-wanglu-dictation.github.io/](https://ielts-wanglu-dictation.github.io/)。

这是纯静态网站，运行时不依赖 Node.js、数据库或服务器。Node.js 24 用于自动测试与打包；无需安装 npm 依赖。练习历史、错词及草稿保存在使用者浏览器，发到 GitHub 的内容不包含这些学习记录。

## 首次发布

1. 将项目文件提交并推送到目标仓库的 `main` 分支。
2. 在仓库 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**。
3. 查看 **Actions → Deploy dictation site to GitHub Pages**，等待 `build` 与 `deploy` 均成功。若首次推送早于步骤 2，可以在该工作流点击 **Run workflow** 重跑。
4. 打开目标网址，核对首页、语料练习、一次听写提交与刷新后的历史恢复。

工作流使用 GitHub 自动提供的临时凭据，不需要填写 PAT 或保存自定义密钥。已设置 `configure-pages` 的 `enablement: true`，但 GitHub 明确说明首次自动启用 Pages 通常需要额外管理权限；普通工作流凭据不能替代仓库管理员完成首次配置。[GitHub 官方 action 参数](https://github.com/actions/configure-pages/blob/v5/action.yml)

若出现 `Get Pages site failed`、`Resource not accessible by integration` 或 Pages 未启用，请先确认步骤 2 已完成，并确认仓库的 Actions 设置允许运行本仓库工作流。若显示等待环境审批，请按该仓库现有的 `github-pages` 环境保护规则完成审批。

## 本地验证

在仓库目录执行：

```sh
npm test
npm run check
node scripts/build.mjs
python -m http.server 4173 --bind 127.0.0.1 --directory dist
```

然后访问 [本地预览](http://127.0.0.1:4173/)。请通过 HTTP 预览，直接双击 `index.html` 会受到 ES 模块及 Service Worker 的浏览器限制。

构建脚本仅复制 `index.html`、`styles.css`、`app.js`、`core.js`、`audio.js`、`data.js`、`icon.svg`、`manifest.webmanifest`、`sw.js`，并创建 `.nojekyll`。所有源文件都存在且可读取后才重建 `dist`；测试、Git 目录和本地辅助文件不会进入发布产物。

## 更新与离线缓存

后续提交到 `main` 会自动测试、打包并发布。只有测试和语法检查通过才会部署。[GitHub Pages 自定义工作流说明](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)

构建脚本会根据全部发布资源的内容生成 SHA-256 摘要，并自动将 `sw.js` 的 `CACHE` 名称替换为 `wanglu-personal-<摘要>`；也支持替换 `__BUILD_ID__` 占位符。页面内容变化即可生成新的缓存版本，无需手动修改源码中的缓存版本。正式发布应使用 `dist` 产物。

Service Worker 的新版本可能等待旧页面关闭。先保存练习，再关闭所有本站标签页和已安装的本站窗口，然后重新打开。不要为了更新页面而清除网站全部数据；这会同时移除本机学习记录。更换设备、浏览器或网址前，请先在「设置与备份」导出 JSON 备份。

首次联网打开并完成缓存后，可离线使用已缓存的页面及语料。本机已安装且可用的英语语音可离线播放；词典发音、浏览器在线语音和在线备用源需要网络。浏览器也可能要求先手动点击一次播放。这里使用合成语音和在线词典发音，不是原书配套录音。

## 回退

需要撤销某次更新时，对该次提交执行 `git revert` 并推送到 `main`，自动部署会重新发布回退后的文件。不要覆盖仓库历史或清除用户浏览器的数据。上线结果应以 Actions 部署成功状态和目标网址实际访问结果为准。
