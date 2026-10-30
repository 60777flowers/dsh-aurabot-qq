# 第三方组件署名与许可（THIRD-PARTY NOTICES）

本仓库是我们的原创作品（MIT，见 LICENSE），但部分文件从下列第三方项目移植/借鉴而来。
按各许可要求，在此逐文件署名并附许可原文。

## dsh-pet —— 桌宠

桌宠模块已搬到社区库，署名和许可原文见 dsh-aurabot-qq-mods 的 `modules/pet/THIRD-PARTY-NOTICES.md`。

## 「大肥鱼」形象与动画素材 —— 独立仓库分发，运行时自动下载

- 来源：dsh-pet 的 pet pack（作者 PC2005-cloud）
- 许可：**CC BY-NC-SA 4.0**（署名 · 非商业 · 相同方式共享）
  <https://creativecommons.org/licenses/by-nc-sa/4.0/deed.zh-hans>
- 作者声明原文：「大肥鱼是遵守 CC BY-NC-SA 4.0 协议的形象，不可以以任何形式商业化。」
- 本仓库**不包含**任何 `.webm` / 形象素材（体积 50MB+，不进 git）。素材放在独立素材仓库
  [dsh-aurabot-qq-mods](https://github.com/accomplish07zrh-eng/dsh-aurabot-qq-mods)（同为 CC BY-NC-SA 4.0），
  插件启动发现 default 包缺失时**自动下载落位**到数据目录 `packs/`（地址可在面板换镜像）。
  重新分发素材（含该素材仓库）须遵守其许可：署名 + 非商业 + 相同方式共享。

## Mieksido/surfcore — 目的引擎（MIT）

- 项目：<https://github.com/Mieksido/surfcore>
- 许可：MIT
- 移植范围：`src/purpose/engine.js` 的纯逻辑核心（配置归一化、排程、素材摘要、目标假设、
  候选选择、提示词构建、回执解析、状态迁移）移植自该项目的 `src/purpose-engine.js`，
  并按 Aurabot 的模块与配置语境做了改写（接线层 `src/purpose/module.js`、独立模块
  `src/modules/purpose/index.js` 是我们为 Aurabot 新写的，不属于移植范围）。

其原许可全文如下：

```text
MIT License

Copyright (c) 2026 Derpyu520 and qq-bridge / QSH contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 其他

- `README.md` 的「致谢」一节还列出了在 DSH 插件机制上参考过思路的其他插件（MIT），那些只参考了踩坑经验，未复制代码。
