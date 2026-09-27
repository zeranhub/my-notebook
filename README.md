# 我的笔记本

这是一个无需安装的中文笔记网页。公开的 GitHub Pages 只托管界面；笔记数据保存在 `zeranhub/personal-notes-data` 私有仓库的 `data/notes.json` 中。网页使用 GitHub API 直接同步，因此每台设备首次使用都需要单独输入一个 GitHub fine-grained personal access token。

## 首次使用

1. 打开 `https://zeranhub.github.io/my-notebook/`，点击页面里的 GitHub 令牌创建链接。
2. Resource owner 选 `zeranhub`；Repository access 选 **Only select repositories**，仅选择 `personal-notes-data`；Repository permissions 中将 **Contents** 设置为 **Read and write**。生成后复制令牌，勿发到聊天或分享给他人。
3. 回到笔记网页，粘贴令牌，设置该设备的 6 位 PIN。手机或其他电脑需要分别操作一次，之后它们使用同一个私有仓库同步。

写作停止约数秒后自动同步；页面重新获得焦点时也会检查其他设备的修改。顶部显示同步状态。网络中断时，未同步内容会尝试加密保存在当前浏览器。遇到两台设备同时修改同一笔记，网页会保留冲突副本供你整理。可以用“导出备份”保存 JSON 文件；“导入 JSON”会保留现有笔记。

## 隐私边界

GitHub Pages 的网页界面及其源代码对所有人可见，但未获授权的访客不能从私有仓库读取笔记。6 位 PIN 用来解锁本机保存的加密令牌和草稿，**不是网站的服务器登录密码**；它位数较少，不适合抵御设备数据被复制后的暴力猜测。真正的远端访问权限由私有仓库和限定该仓库权限的令牌提供。不要在笔记中保存账户密码、恢复码等高度敏感资料。令牌到期或撤销后，应创建新令牌并在网页里重新连接；重新连接前先确认没有待同步草稿，必要时先导出备份。

## 维护

网页源码为 `index.html`、`styles.css`、`app.js` 和 `sync.js`，不依赖第三方脚本或构建工具。将这些文件放在公开仓库的 `main` 分支根目录，GitHub Pages 从 `main` 的 `/` 发布。私有笔记文件不可复制到公开仓库，也不可把令牌写入源码。
