# 贡献指南

感谢你有意参与 DND5e classpack 的贡献！本指南说明如何向本项目提交内容修改。

## 重要：本仓库存的是 JSON 源码，不是 ldb

这个模块在 Foundry VTT 里运行时使用的是编译后的 LevelDB 数据库（`.ldb`），但**本仓库存储的是 item 的 JSON 源码**。数据流向如下：

```
游戏内修改（生成 / 更新 .ldb）
        │   tools/pull-from-foundry.mjs  ← 手动拉回
        ▼
JSON 源码（由git追踪）
        │   .github/workflows/release.yml  ← 发布时自动
        ▼
.ldb + dnd5e_classpack.zip（release 资源，自动生成）
```

因此：

- **不要**手动提交 `.ldb`、`CURRENT`、`MANIFEST-*`、`LOG`、`LOCK` 等编译产物（已在 `.gitignore` 中忽略）。
- **不要**提交 `*.zip`、`.DS_Store` 等自动生成文件。
- 所有内容修改都应落在 `dnd5e_classpack/packs/<包名>/*.json` 里。

## 仓库结构

```
dnd5e_classpack/
  module.json                    # 模块清单（版本、依赖、包定义）
  packs/
    <包名>/
      <名称>_<id>.json           # 普通条目
      <文件夹名>_<id>/           # 文件夹（子目录）
        _Folder.json             # 文件夹定义
        <条目>.json
tools/
  pull-from-foundry.mjs          # 游戏内改动 → JSON
  repackage.mjs                  # JSON 重新命名 / 本地验证
  lib/pack-utils.mjs             # 共享的命名与 CLI 辅助
.github/
  workflows/release.yml          # 发布时 JSON → ldb → zip
```

## 环境准备

需要 Node.js 18+（推荐 22）以及官方 Foundry VTT CLI：

```bash
npm install -g @foundryvtt/foundryvtt-cli
```

## 工作流程

### 方式 A：在游戏内修改

1. 在 Foundry VTT 里正常编辑合集包条目。
2. **退出 Foundry VTT 或是退出当前世界**（它运行时会锁定每个 pack 的 `LOCK` 文件）。
3. 把改动拉回 JSON：

   ```bash
   node tools/pull-from-foundry.mjs --data "<Foundry 数据目录>"
   ```

   Foundry 数据目录可在 Foundry 设置页的 “User Data” 处查看；脚本也会尝试自动探测。

   默认会**忽略 `_stats` 元数据的变更**（修改时间、修改者等），避免污染 diff。如需连同 `_stats` 一起同步：

   ```bash
   node tools/pull-from-foundry.mjs --data "<Foundry 数据目录>" --include-stats
   ```

   只同步单个包：

   ```bash
   node tools/pull-from-foundry.mjs --data "<Foundry 数据目录>" --pack races-item
   ```

4. 检查差异并提交：

   ```bash
   git status
   git diff
   git add -A
   git commit -m "同步游戏内改动"
   ```

### 方式 B：直接编辑 JSON

1. 直接编辑 `dnd5e_classpack/packs/<包名>/` 下的 `.json` 文件。
2. （可选）本地验证能否正常打包，并用统一命名规则重命名：

   ```bash
   node tools/repackage.mjs            # 全部包
   node tools/repackage.mjs races-item # 单个包
   ```

   该脚本会把 JSON 打包回 ldb 再解包，用「保留中文 + `_id`」的命名重新生成文件。

   若只想打包成 ldb 在游戏里测试（产物已被 `.gitignore` 忽略）：

   ```bash
   cd dnd5e_classpack
   fvtt package pack -n <包名> --inputDirectory packs/<包名> --outputDirectory packs --recursive
   ```

3. 提交并推送。

## 文件与文件夹命名规范

- 普通条目：`<名称>_<id>.json`，例如 `EGW 荒洲探险家指南_RH2MA271O9rDo87z.json`。
- 文件夹：以子目录 + `_Folder.json` 表示，目录名为 `<名称>_<id>`。

命名由工具脚本统一处理（见 `tools/lib/pack-utils.mjs` 的 `transformName` / `transformFolderName`）。**打包器不读取文件名或目录名**，只读取 JSON 内容里的 `_id` / `_key` / `folder` 字段，所以文件名仅供人阅读，可安全地保留中文。

请勿手工把中文名改回下划线形式（如 `EGW_______xxx.json`），那会丢失可读性。

## 提交与 PR

- 一个提交尽量只做一件事。
- 提交信息用简洁的中文描述，例如 `添加新模组中的十八个新子职`。
- 涉及内容增改时，同步更新 `dnd5e_classpack/CHANGELOG.md`。
- 发起 Pull Request 前，填写 PR 模板中的核对清单、类别、描述与更新日志。

## 发布流程（维护者）

发布由 GitHub Actions 自动完成：

1. 在 GitHub 上创建 Release，tag 建议使用 `vX.Y.Z` 格式。
2. `.github/workflows/release.yml` 会自动：
   - 用 `fvtt package pack --recursive` 把 JSON 打包回 `.ldb`；
   - 删除 JSON、生成 `dnd5e_classpack.zip`；
   - 按 tag 更新 `module.json` 的 `version`（去掉前导 `v`），并把 `download` 固定到对应 tag；
   - 把 `module.json` 与 zip 附加到 release。
3. `manifest` 字段始终指向 `latest`，以便 Foundry 自动发现新版本。

如需手动验证打包，可在 Actions 页面用 `workflow_dispatch` 触发（可留空 tag，仅构建不上传）。

发布包默认只包含当前模块引用的 `Nicons` 图片，仓库中的原图保留。`tools/release-icons.mjs` 在编译合集、移除 JSON 之前扫描条目、AE、描述、宏及脚本引用，再按清单复制发布目录；动态构造的路径会保守保留对应目录。新增内容引用旧图标后，下次打包会自动带上。

已有世界或角色里的旧物品副本可能仍引用未被当前模块使用的图片。需要兼容这些副本时，可在手动发布中勾选 `keep_all_icons`，包含全部旧图标。本地可用 `node tools/release-icons.mjs --plan reports/release-icons.json` 查看保留与排除清单。
