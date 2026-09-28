# QuotaHalo 紧凑圆角与刷新展示实施计划

## 1. 调整标记与 CSS

- 将 5 小时详情标签改为“距离重置还剩”。
- 在最终实体皮肤覆盖层中将 `.panel` 外框圆角设为 16px；不改变卡片与控件圆角。
- 将主 `.halo-ring` 由 116px 改为 104px，并将主区域间距相应缩小。
- 将 `.detail-label` 设为 11px。
- 为 `violet` 色卡写入固定紫色背景，保留其余三个固定色值。

## 2. 保留刷新中的已读数据

- 提取“已有成功快照”的判断：仅当 `lastSuccessfulSnapshot` 同时有主额度或周额度时为真。
- 在 `render()` 中：首次加载继续用 loading 状态；已有快照的 loading 改为 ready 渲染快照，避免前台显示“正在读取”。
- 同一规则应用到主窗口和每周额度；刷新按钮的旋转与禁用反馈保留。
- 超时和无可用快照的错误逻辑不变。

## 3. 同步版本与验证

- 版本更新至 0.1.24：`package.json`、`package-lock.json`、`Cargo.toml`、`Cargo.lock` 的 `quota-halo` 包记录、`tauri.conf.json`。
- 运行 Node 语法检查、刷新渲染的静态断言、版本一致性检查与 `git diff --check`。
- 尝试 `npm run build` 与 `cargo check`；如果 crates.io 网络仍不可达，记录为环境限制，不变更锁定依赖。
- 审查仅包含本任务文件，提交为单一 `ui:` Conventional Commit。
