# 一页纸

这是一个通过 GitHub Pages 免费发布的私人笔记网页。每张纸都采用固定的 A4 纵向比例，以考试参考纸的密度显示笔记：正文约 8px（6pt）、小间距、白底黑灰。观看模式完整显示每篇笔记的 Markdown 内容，自动安排在这张纸上；点击内容进入编辑模式，直接修改 Markdown 原文，停笔后自动保存。没有笔记标题、文件夹或侧边栏。可建立多张一页纸，每张的面积都有限。“整页”显示全部内容，100% / 150% / 200% 只放大阅读视图，不增加纸张容量。

内容框平时融入纸张，鼠标悬停或聚焦后才显示边框和手柄。拖动左上角手柄可移动，靠近纸张边界自动吸附；拖动右下角手柄可改变大小。正文按 Markdown 显示标题、列表、表格、代码、引用及图文混排。若内容放不进当前纸张，页面会明确标出越界，并在纸张下方完整显示，不会扩展纸张或截断正文。编辑时可选择“移到新页”。

顶部“图片”将本机 PNG、JPG、WebP 图片放入独立内容框，也可直接拖到纸张上。编辑器的“插入图片”或粘贴截图可将图片插入正文。图片保存在同一个私有仓库的 `assets/`，正文通过 `![说明](onepage:图片标识)` 引用，不使用公开图片地址。大图会在本机缩小以便同步，每张保存文件不超过 1 MB。“备份”包含正文和图片；“导入”恢复完整图文内容。初次保存图片需连接 GitHub。

## 首次连接

1. 打开 [一页纸](https://zeranhub.github.io/my-notebook/)，使用网页中的链接创建 GitHub fine-grained personal access token。
2. Resource owner 选 `zeranhub`；Repository access 选 **Only select repositories**，仅选 `personal-notes-data`；Repository permissions 中将 **Contents** 设为 **Read and write**。复制令牌，切勿发到聊天或分享给他人。
3. 回到网页，粘贴令牌并设置这台设备的 6 位 PIN。手机或其他电脑各需配置一次，之后通过同一私有仓库自动同步。

公开仓库 `zeranhub/my-notebook` 只托管网页界面。正文保存在私有仓库 `zeranhub/personal-notes-data` 的 `data/notes.json`，不会发布到 GitHub Pages。编辑后约 2.5 秒开始同步；页面重新获得焦点或联网时会检查其他设备的更新。断网时修改会尝试加密保存在当前浏览器中；若两台设备同时修改同一篇笔记，系统会保留冲突副本。可用“备份”导出 JSON，用“导入”追加备份中的页面和笔记。

## 隐私说明

6 位 PIN 用来解锁本机加密保存的令牌和草稿，主要防止旁人随手打开网页，不能代替强密码或设备锁屏。远端正文的访问权由 GitHub 私有仓库和仅授权该仓库的令牌决定。令牌过期或撤销后，重新连接前请先确认没有待同步的草稿，必要时导出备份。

## 维护

网站由 `index.html`、`styles.css`、`app.js`、`layout.js`、`model.js`、`sync.js`、`markdown.js` 构成；Markdown 解析与清理使用固定版本的本地 Marked 和 DOMPurify，许可见 `vendor/`，不加载远程脚本。无需构建工具，GitHub Pages 从公开仓库 `main` 分支根目录发布。切勿把私有笔记文件、图片或访问令牌提交到公开仓库。
