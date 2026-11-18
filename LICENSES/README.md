# 许可文件说明 / Licence files

本目录存放第三方与上游许可声明。三个文件分工不同，改之前先看这一页。

## 根目录 `LICENSE`

AetherOps 自身的许可：**标准 MIT 正文**，版权块里两行 —— 本项目 `SubDong` 与上游 `fefeding`。

**不要在这个文件里插入任何说明段落。** GitHub 的许可证识别要求正文与标准模板逐段匹配；在版权块与
`Permission is hereby granted` 之间插一段话，识别就会失败，仓库侧栏显示 `Other` / `NOASSERTION`，
并且 `license:mit` 的搜索里查不到本仓库。曾经这么写过一次，结果就是如此，所以说明文字放在这里。

## `LICENSES/AICmd-MIT.txt`

上游 AICmd 的 MIT 原文逐字归档（`Copyright (c) 2026 fefeding`），与 `packages/vscode/LICENSE` 内容一致。

归档理由：上游仓库根目录没有 `LICENSE` 文件、`package.json` 也没有 `license` 字段，那段文本只存在于
它自己的扩展包目录里 —— 上游只要重写一次 VSIX 打包流程，证据就没了。放在本目录的副本不随任何构建
流程变动。

## `packages/vscode/LICENSE`

上游原文的原始位置，保持不动；`aetherops-v*` 的 VSIX 打包会把它带进扩展包。

## 改的时候

- 换协议或改版权行：只改根 `LICENSE`，同时改 `README.md` / `README.zh.md` 的 *License & attribution*
  段落，两边一起改
- 新增第三方依赖许可：放本目录，命名 `<项目名>-<协议>.txt`，并在本文件加一节
