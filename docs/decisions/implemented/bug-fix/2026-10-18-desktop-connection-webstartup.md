# Desktop 0.2.1-rc.1 Connection 启动依赖

## Problem

Desktop `0.2.1-rc.1` 的标准 Connection row 使用 `inject: [webStartup]`，其 `trustedHosts` 配置读取 `ctx.webStartup.trustedHosts`。旧插件的 Bundle 覆盖为 `[webRuntime, webServer]`，等待新版不再提供的 `webRuntime`，使必需的 Connection 及下游插件无法激活；同时覆盖掉新配置所需的 `webStartup`。

安装包中的通用 `rpc.handle()` 仍通过调用方 effect 访问 Connection 的 `webServer`，没有该依赖时 Memory RPC 注册失败。Connection 自身 `/api` 的可选 Web fiber 不修复这条注册路径。

## Decision

将标准 Connection 的 Bundle 覆盖更新为 `inject: [webStartup, webServer]`。保留 id 与包名双重匹配、原始配置和模块级 `credentials` 合并，不修改应用归档、用户 profile、认证或记忆数据。

这是对 [旧 Connection 兼容决策](2026-09-10-connection-webserver-injection.md) 的基线更新。回归测试不提供 `webRuntime`，验证 RPC 注册与卸载；独立脚本支持用已安装 macOS Desktop 的真实补丁算法和 Connection 验证，避免仅依赖源码检出或 root service mock。

## Alternatives considered

- 删除整个 Connection 覆盖：当前发布包的通用 RPC 注册仍需 `webServer`，会造成 Memory 页面 RPC 失败。
- 只保留 `webServer`：丢失标准配置需要的 `webStartup`。
- 修改应用或注入假的 `webRuntime`：掩盖旧依赖，没有必要。

## Consequences

更新插件后必须完全重启 Desktop / Web，重新组合 Bundle。旧版只提供 `webRuntime` 的 DSH 不在这一修复的兼容基线内；不增加猜测版本的双路径适配。自定义 Connection 额外依赖仍需由后加载的用户 patch 保留。只有上游修复通用 RPC 注册依赖并通过同级服务提供方验证后，才能移除 `webServer` 覆盖。
