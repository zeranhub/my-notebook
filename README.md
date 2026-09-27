# 一页纸

这是一个通过 GitHub Pages 免费发布的私人笔记网页。每张纸都采用固定的 A4 纵向比例。观看模式把每篇笔记的完整正文放进独立文本框，自动安排在这张纸上；点击文本框进入编辑模式，直接修改纯文本正文，停笔后自动保存。没有笔记标题、文件夹或侧边栏。可建立多张一页纸，每张的面积都有限。

文本框会按正文长度自动调整；拖动左上角手柄可移动，拖动右下角手柄可改变大小。若正文放不进当前纸张，页面会明确标出越界，并在纸张下方完整显示这些笔记，不会扩展纸张或截断正文。编辑时可选择“移到新页”。

## 首次连接

1. 打开 [一页纸](https://zeranhub.github.io/my-notebook/)，使用网页中的链接创建 GitHub fine-grained personal access token。
2. Resource owner 选 `zeranhub`；Repository access 选 **Only select repositories**，仅选 `personal-notes-data`；Repository permissions 中将 **Contents** 设为 **Read and write**。复制令牌，切勿发到聊天或分享给他人。
3. 回到网页，粘贴令牌并设置这台设备的 6 位 PIN。手机或其他电脑各需配置一次，之后通过同一私有仓库自动同步。

公开仓库 `zeranhub/my-notebook` 只托管网页界面。正文保存在私有仓库 `zeranhub/personal-notes-data` 的 `data/notes.json`，不会发布到 GitHub Pages。编辑后约 2.5 秒开始同步；页面重新获得焦点或联网时会检查其他设备的更新。断网时修改会尝试加密保存在当前浏览器中；若两台设备同时修改同一篇笔记，系统会保留冲突副本。可用“备份”导出 JSON，用“导入”追加备份中的页面和笔记。

## 隐私说明

6 位 PIN 用来解锁本机加密保存的令牌和草稿，主要防止旁人随手打开网页，不能代替强密码或设备锁屏。远端正文的访问权由 GitHub 私有仓库和仅授权该仓库的令牌决定。令牌过期或撤销后，重新连接前请先确认没有待同步的草稿，必要时导出备份。

## 维护

网站由 `index.html`、`styles.css`、`app.js`、`layout.js`、`model.js`、`sync.js` 构成，不依赖第三方脚本或构建工具。GitHub Pages 从公开仓库 `main` 分支根目录发布。切勿把私有笔记文件或访问令牌提交到公开仓库。
