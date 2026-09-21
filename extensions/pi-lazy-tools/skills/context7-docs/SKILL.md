---
name: context7-docs
description: 查询库、框架、SDK、CLI 的当前文档、配置与 API 示例时使用；按需启用 Context7 工具，避免依赖过时记忆。
---

# Context7 文档

当 `resolve-library-id` 或 `query-docs` 不可见时，先调用 `load_capability({"name":"docs"})`，在下一次模型请求中使用实际工具定义。

1. 调用 `resolve-library-id`，依据名称、官方来源和覆盖度选择库 ID；用户已明确提供 `/org/project` 或版本 ID 时可跳过。
2. 调用 `query-docs`，每次聚焦一个具体概念，依据返回文档回答并标明所用库 ID。
3. 每个问题中，两种工具各最多调用三次；不能把密钥、密码、个人数据或私有代码放入查询。

复用已安装扩展的认证与接口；不要复制 API 客户端或在配置里写入明文密钥。工具未注册或认证失败时明确报告，不自动安装或绕过权限。
