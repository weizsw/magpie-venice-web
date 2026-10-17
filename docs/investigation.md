# Venice 网页协议调查

调查日期：2026-10-15。目标：用户指定的 `https://venice.ai/chat/agent` 中 DeepSeek V4.1 Flash Uncensored；Magpie 0.1.1247，macOS。

## 已观察到的事实

| 问题 | 结论 | 依据 |
| --- | --- | --- |
| 模型标识 | `deepseek-v4-1-flash-free`，名称 `DeepSeek V4.1 Flash Uncensored` | 用户已登录 Safari 页面的模型选择器及真实 GET 配置响应 |
| 普通模型区别 | `deepseek-v4-1-flash` 是单独条目，`usesCredits: true`；目标条目为 false | GET `/api/v2/agents/configuration_options` |
| 上下文 | 524,288 tokens | 真实生成的 `response.output_text.done.context_metadata.max_context_length`，配置文案为 512K |
| 网页后端 | `https://outerface.venice.ai` | Safari Performance 资源记录、真实请求成功；使用 `venice.ai/api/...` 返回 404 |
| 会话认证 | `window.Clerk.session.getToken()`，刷新使用 `{skipCache:true}` | 发布脚本及已登录页面实际执行；刷新成功后仍可聊天 |
| 客户端凭证 | POST `/api/app/user/client_attestation/mint`，JSON `{env:{}}`；响应 token 放 `x-venice-client-attestation` | 发布脚本中的客户端实现及同样调用的聊天成功 |
| 用户自定义指令入口 | POST `/api/inference/chat/agents/ad-hoc` | 发布脚本 schema 及真实 POST 成功 |
| 通用 Agent 入口 | POST `/api/inference/chat/agents/venice?agentModelId=deepseek-v4-1-flash-free` | 发布脚本及真实 POST 成功 |
| SSE | `event:` 指定事件名，`data:` 不一定有 `type` 字段，末尾 `[DONE]` | 真实回复；转换器保留事件名再读取 JSON |
| 自定义工具 | 含 `clientTools` 请求被接受，但模型尝试函数时后端返回未识别工具，继续生成解释文字 | 真实 `lookup_weather` 探针的 `veniceai:tool_call_generation.in_progress` 中 `Unrecognized` |
| 工具替代方案 | 通过系统提示词要求严格 JSON，再转 OpenAI 工具调用可完成往返 | 真实 required tool_choice 返回 Paris 参数；提交模拟天气后得到 `19°C and sunny` |

## 请求形状

发布的 core chunk `3av91i1aecon5.js` 中 `uC` 为 ad-hoc 的 schema，`u7` 为通用 Agent 请求 schema。网页消息使用 Responses 风格 item，而不是普通 Chat Completions。文本 part 在实际网页历史转换中使用 `output_text`，用户消息也如此；误用 `input_text` 的首个探针返回 500，修正后成功。

```json
{
  "modelId": "deepseek-v4-1-flash-free",
  "systemPrompt": {"instructions": "Reply concisely."},
  "messages": [{
    "id": "generated UUID",
    "type": "message",
    "status": "completed",
    "role": "user",
    "content": [{"type": "output_text", "text": "Reply with exactly ADHOC_OK", "annotations": []}]
  }],
  "tools": [],
  "clientTools": [],
  "reasoningMode": "disabled"
}
```

相关头：`Authorization: Bearer <Clerk JWT>`、`x-venice-request-timestamp-ms`、`x-venice-middleface-version: 0.1.1128`、`x-venice-client-attestation`。浏览器 fetch 使用 `credentials: include`。实现不把原始 token 或 Cookie 导出给 Magpie。

## REA 证据

REA 运行了声明的网页导航与等待场景（临时 headless Chrome），没有在用户 Safari 会话中登录或操作：

- `ev_b4a48861cc9ada19f0afe22d9021f9cfb79b4688bf7c637c1687636db85c21e5`：`capture_browser_scenario`，打开目标网页，等待 6 秒，捕获 DOM、可访问性及网络。观察到游客 Agent 页、Clerk 相关页面资源。其网络事件达到预算，660 个事件被丢弃，部分 body 不可用；不用于证明登录态或完整网络请求集合。
- `ev_cf48298a92f76c8219153239a29eaf0b3af8877c8de6f48414c5bf0fe6089f66`：`list_browser_targets`，专用 Chrome 的初始 target 列表为空，仅证明当时没有 HTTP(S) target。

REA 完整导出保存在本机临时文件 `/tmp/venice-rea-investigation.json`。它没有提交进仓库。网页静态脚本分析使用公开下载的发布文件；这些是静态推断依据，并不证明相关分支在真实会话执行。

REA 的被动工具不提供原始凭证。早期已登录 Safari 探针用于确认请求结构，最终实现按用户要求切换到 Chrome；Safari 代码已移除。

Chrome 补充证据：

- `ev_234718c9858693ecfdb7fa802f601b7bbd39d455e86ab9732226fd2e3b646f5a`：REA 在插件专用 Chrome 中列出唯一 Venice Agent target。
- `ev_12f65eb77bcd776bf9893f87a5f86b51c54a3135cc9df2fa76e73218a109d527`：REA 被动检查该页面；仅覆盖附加窗口，无历史网络、原始 Cookie 或 token。

最终 Chrome 登录态、聊天、强制刷新及工具往返通过本项目 `lib/session.mjs` 和 `lib/chrome.mjs` 独立验证，不冒称为 REA 证据。插件 Chrome 使用独立持久配置，用户在正常窗口手动登录成功；与被工具策略拒绝附加的个人默认 Chrome 配置分开。

## 实现选择与边界

采用跨平台 Chrome CDP 传输：独立持久浏览器配置 → Clerk SDK 领取短期 token → 后端客户端凭证签发 → 网页聊天 → 原始 SSE → Chat Completions。最终方案按用户要求使用 Chrome。浏览器用系统可执行文件直接启动，不带 Playwright 自动化启动参数；登录成功且关闭重开后会话保留。

- 登录持久化由 Chrome 的独立持久配置负责；Magpie 只保存用户 ID 和会话引用。刷新调度使用 `auth.refresh`；网页 fetch 对 HTTP 401 再刷新一次。不使用假造的 refresh token 调用未经观察的接口。
- 插件根据保存的 uid 检查当前账号；当前仅支持一个 Chrome 配置中的登录账号，不承诺多账号隔离。
- 不尝试通过页面 UI 发送文本；请求不修改本地网页对话数据库，不创建 UI 对话。
- 文字聊天持续流式转换。模拟工具信封缓冲至完成后解析，避免把不完整 JSON 发给 Agent。
- 输出 32,768 是插件保守声明值；网页后端未在此调查中确认精确生成上限。
- 实际服务返回的用量、套餐期限未解析。`free: true` 只来自模型目录 `usesCredits:false`；不等于无限速率。
- 没有验证长期空闲、多天登录失效、Chrome 被系统暂停、跨平台运行和图片上传。已验证强制领取新 token，不能据此承诺永不需要重新登录。
- 代理通过 Chrome/系统网络，不能沿用 Magpie 的单账号 fetch 代理。

## 验证清单

已完成：

- 已登录页面显示目标模型；真实配置响应核对名称和 ID。
- Agent endpoint 返回 `VENICE_OK`，ad-hoc 返回 `ADHOC_OK`。
- 插件 loader 的非流式和流式请求均返回 `PLUGIN_OK`。
- `auth.refresh` 强制领取新 token 成功。
- 工具模拟完成调用与结果续聊，工具参数为原始 JSON。
- Node 和 Bun 协议测试：UTF-8/CRLF 分片、错误/截断、工具历史与参数、非法工具名、附件拒绝、取消、插件声明。
- 独立 XDG 配置的 Magpie 插件添加、登录、provider test 通过（约 2.9 秒）。

参考设计：[Magpie 官方插件文档](https://usemagpie.ai/docs/zh/plugins)、[Gemini Web 插件](https://github.com/BUKOWSKIREAL/magpie-gemini-web)、[Muse Web 插件](https://github.com/JohnWangggg/magpie-muse-web)。未复制参考项目代码。

最终 Chrome 验证：

- 普通 Chrome 专用持久配置登录成功，重启浏览器后仍为 signedIn。
- 非流式 `VENICE_OK`、流式 `CHROME_STREAM_OK`、强制 token 刷新成功。
- Chrome 下工具调用和结果续聊成功。
- Chrome 下 Magpie 沙箱登录及 provider test 成功（约 2.5 秒）。
- Windows / Linux 路径与启动逻辑已实现，但未在这些系统进行真实登录测试。

## Cookie 独立传输补充验证

用户提出无痕登录后复制 Cookie 的方案。已读取插件专用 Chrome 的 Cookie 到单次探针进程内存，不将其写入仓库或报告，并断开 CDP 后直接使用 Node fetch：

- Clerk Frontend API 域为 `clerk.venice.ai`。`__client` 是其 HttpOnly 长期客户端凭证，与 Venice 域的短期 `__session` 不同。
- POST `/v1/client/sessions/<session-id>/tokens?__clerk_api_version=2026-05-12&_clerk_js_version=6.39.0`，表单 `organization_id=&tab_state=focused&force_origin=true`，带 Clerk 域 Cookie，返回 200 和有效期 60 秒的 JWT。
- 使用 Venice 域 Cookie、浏览器 User-Agent、Origin/Referer 和上述 JWT，直接请求 outerface 的 attestation mint、模型目录，均返回 200。最初只传 Bearer 的目录探针返回 403，补齐请求环境后成功；不能据此认定每个头都必需。
- 直接聊天探针完成完整 SSE，返回 `COOKIE_DIRECT_OK`，续签/attestation/聊天状态均为 200。

结论：Cookie 导入并独立请求有实测基础，可以实现无需浏览器承担请求的传输方式。当前交付代码尚未实现 Cookie 导入、Set-Cookie 持久化与轮换、跨进程刷新互斥；不能将单次探针成功说成长期保活已验证。无痕导入需要覆盖 Clerk 和 Venice 两个域，不能只依赖 Venice 页面请求头中的 Cookie；直接退出账号会撤销会话，关闭窗口与退出登录不同。多天续期、Cloudflare clearance 到期和客户端 IP/指纹变化仍未验证。

## Cookie 模式切换与过期测试（最终实现）

2026-10-15 补充：已实现 `lib/cookies.mjs` 并迁移本机 Magpie 账号。默认不连接 Chrome。Clerk Cookie 的 RFC6265 作用域、过期、删除与 Set-Cookie 轮换由 tough-cookie 处理，账号文件权限 600、目录 700；按账号跨进程锁保护续期和更新，原子替换写盘。

真实验证边界：

- 只将 `__client` 导入隔离账号目录，关闭插件 Chrome 后换 token、attestation 与聊天均成功。
- 后续探针在旧 JWT 自然过期后换得新 JWT，返回 `COOKIE_VERIFIED_OK`。
- 移除全部 Cloudflare Cookie，及在本地 jar 放入已过期 cf_clearance，均能续签并聊天。后者验证的是客户端不发送过期 Cookie，不能模拟服务器未来主动发起的交互挑战。
- Bun fetch 下触发 Cloudflare，Node fetch 配合真实浏览器 User-Agent 通过。系统 curl 的完整聊天未稳定通过，因此最终采用本机 Node 子进程处理 HTTP，不使用 curl。Node 路径可配置；没有静默安装运行时。
- 手动导入只有 Cookie 而使用通用 User-Agent 时，宿主测试触发验证。补入登录浏览器的真实 User-Agent 后，沙箱和日常 Magpie provider test 通过（最终约 3.3 秒）。手动登录现在要求填写 User-Agent。
- 单次探针没有把凭证写到仓库、命令参数或日志。Cookie 导入通过 stdin，后台 HTTP 同样通过 stdin传递请求，原始响应只回到插件。
- 16 项 Node 测试涵盖协议、Cookie 作用域/过期/轮换、并发刷新、服务器拒绝和 challenge；Bun 跳过 Playwright launch 集成，其余测试运行。

多天自然观察尚未完成。已启动 72 小时观察窗口，每 6 小时强制续签并读取模型目录，不发聊天；首次结果 HTTP 200。状态保存在本机 `venice-web/observation`，到期后脚本停止网络请求。该观察持续使用凭证，可验证持续保活，不能证明完全空闲多天仍可恢复，也不证明不同IP/指纹下不会被挑战。

## 用量与推理补充（2026-10-16）

网页 SSE 不提供标准 OpenAI 用量对象。已实测确认：

- `response.output_text.done` 带 `context_metadata.total_tokens`，但这是本轮上下文总占用（例如固定约 2963，与回复长度无关），不能当作本次请求的 `prompt_tokens`/`completion_tokens`，因此没有采用。
- 改为本地估算：CJK 按字符计，其余按词与标点计，长词按约 3.8 字符一个 token；消息、工具定义计入 prompt。流式在结束块和额外的 `choices:[]` 块给出 `usage`，非流式在响应体给出。真实 Magpie 代理实测日志从 `in:0,out:0` 变为 `in:18,out:5`、`in:19,out:62`，与流式/非流式都吻合。
- 这是估算，不是 Venice 的服务端计数，也不代表计费。目标模型 `usesCredits:false`，没有费用。

推理实测：

- 请求 schema 只接受 `reasoningMode: "disabled" | "adaptive" | "enabled"`，没有数值梯度。
- 关闭时只出现 `output_index:1` 的 `message` 项；开启时先出现 `output_index:0` 的 `reasoning` 项，再出现 `message`。
- 关键发现：开启推理后，思考内容也是以 `response.output_text.delta` 发送，区别只在项的 `type`。早期实现会把它当作正文输出。现已按 `output_item.added` 记录每个 `output_index` 的项类型，把推理 delta 转入 `reasoning_content`。真实代理实测：思考进入 `reasoning_content`，正文不含思考，日志显示 `reasoning: 18`。
- `reasoning_effort` 映射为上述三种模式作为模型 variant。`high` 映射到 `enabled` 是能力映射，不是精确梯度，网页不提供 low/medium/high。
