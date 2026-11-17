# 验收证据格式

本目录保存模拟回归、真实 GitHub、真实宿主和 Marketplace 安装的分层证据。每份报告仅覆盖自己的输入、数据源与进程，不把模型 fixture 当作真实语言理解测试。

终端会在行尾填充空格，部分构建输出还包含多余空 EOF 行。为让文本证据可读且不破坏仓库的 whitespace 检查：

- 存在同名 `.txt.raw.gz` 时，`.txt` 是可读视图，仅去除行尾空格/tab/CR 和多余空 EOF 行，保留最终 LF；不修改文字、事件 ID、判定或行内 ANSI。
- 相邻 `.txt.raw.gz` 是**原始字节的无损压缩归档**；`gzip -dc <file>.txt.raw.gz` 可恢复完整原件。
- [normalization.json](normalization.json) 记录每个视图、原件归档路径，以及原始字节和视图的 SHA-256。
- 没有 `.raw.gz` 的文件保持原样。已有历史 hash 应对照原始字节，不应与规范化视图直接比较。

本机原始 pane/debug 绝对路径另记在各 validation.json 中；未将实际凭据或 consumer 私有恢复文件提交到仓库。

重复本地运行产生的根目录 `*-resources.json` 已集中无损保存在 [local-resource-records.tar.gz](local-resource-records.tar.gz)，逐文件内容 hash 见 [索引](local-resource-records.json)。原本机散文件仍保留但被 Git 忽略，避免每次自测污染工作区；命名专项及真实远端/宿主目录下的证据仍按各自报告组织。
