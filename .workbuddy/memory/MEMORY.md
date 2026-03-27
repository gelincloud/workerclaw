# MEMORY.md - 跨会话长期记忆

## 用户信息
- 用户邮箱: glin_1@qq.com
- GitHub: gelincloud
- 智工坊域名: https://www.miniabc.top
- 偏好: 中文沟通

## 项目概览

### 项目1: 智工坊网站平台 (`/Users/admin/WorkBuddy/20260310201629`)
- **名称**: 智工坊 (MiniABC) - AI Agent 社交任务平台
- **技术栈**: Node.js + Express + SQLite(sql.js) + WebSocket + 原生HTML/CSS/JS
- **对象存储**: 腾讯云 COS (bucket: miniabc-1259638100, region: ap-guangzhou)
- **主要功能**:
  - 用户系统: 双身份(AI Agent自动注册 + 人类密钥对注册), RSA-2048加密
  - 社交功能: 信息流(Tweets), 点赞/评论, 关注机制, 私信
  - 任务市场: 发单/接单, 状态管理, 报酬结算, 余额系统(充值/提现/转账)
  - 用户等级系统: 星/月/太阳/皇冠(最高256级), 基于活跃天数
  - 实时通信: WebSocket推送新任务/新消息, 心跳保活
- **页面**: 登录页、个人信息、信息流、任务广场、任务详情、我的发单/接单、消息中心、余额管理
- **部署**: 服务器上通过PM2运行, 支持HTTPS
- **数据库**: SQLite, 存储在 `./data/bots.db`
- **表**: bots, tweets, tweet_likes, tweet_comments, tasks, messages, follows, transactions

### 项目2: MiniABC OpenClaw 插件 (`/Users/admin/WorkBuddy/openclaw-miniabc-channel`)
- **包名**: `@glin_1/miniabc`, 当前版本 2.0.14
- **类型**: OpenClaw Channel Plugin
- **核心功能**:
  - 自动接单: 多维度评估(技能40%+时间25%+经济20%+信誉15%), WebSocket实时接收任务
  - 智能活跃行为: 发推文15%, 浏览35%, 评论20%, 点赞20%, 空闲10%, AI增强内容生成
  - 推文发布、任务管理、余额查询、邮件功能
  - Onboarding流程: 自动注册+欢迎推文
  - 技能扫描(skills/)
- **源码结构** (17个ts文件):
  - `sdk-compat.ts` - SDK兼容层核心(内联实现+异步import热替换)
  - `channel.ts` - 主Channel定义(版本检测、onboarding、setupWizard)
  - `api.ts` - MiniABC API客户端
  - `config.ts` - 配置解析
  - `runtime.ts` - OpenClaw runtime引用
  - `onboarding.ts` - 注册引导流程
  - `setup-wizard.ts` - 配置向导(仅>=3.22版本启用)
  - `task-manager.ts` / `task-executor.ts` / `task-safety-reviewer.ts` - 任务相关
  - `active-behavior.ts` - 智能活跃行为
  - `channel-notify.ts` - 通知功能
  - `personality.ts` - 人格设定
  - `goals.ts` - 目标系统
  - `skill-scanner.ts` - 技能扫描
  - `types.ts` / `sdk-compat-types.ts` - 类型定义
- **新旧版本兼容方案**:
  - `sdk-compat.ts`: 内联实现3个SDK辅助函数作为fallback
  - 模块加载时异步 `import("openclaw/plugin-sdk/core")` → 成功则用modern SDK
  - 失败则尝试 `import("openclaw/plugin-sdk")` → 成功则用legacy SDK
  - 都失败则用内联实现(不影响功能)
  - `channel.ts`: 运行时版本检测决定是否暴露setupWizard(避免<3.24资源耗尽bug)
  - `package.json`: 声明 `openclaw.compatibility.legacy/modern`

### 项目3: WorkerClaw 公域 Agent 框架 (`/Users/admin/WorkBuddy/workerclaw`)
- **名称**: WorkerClaw - 公域 AI Agent 框架，专为"打工虾"设计
- **技术栈**: TypeScript 5.5 + Node.js 20+ (ESM)
- **定位**: 公域任务执行框架（区别于 OpenClaw 的个人宠物虾模式）
- **核心设计哲学**: "Trust the Platform, Verify Everything Else"
- **与 OpenClaw 的核心区别**:
  - 消息模型: 任务推送式（平台→虾）vs 对话式（主人↔虾）
  - 安全模型: Trust-Boundary（审查内容）vs Owner-Centric（保护主人）
  - 权限基础: 四层安全审查+权限分级 vs senderIsOwner白名单
- **五层架构**: 接入层→安全审查层→任务管理层→Agent执行引擎→技能层
- **安全审查四层**: 速率限制→来源验证→内容安全扫描→权限分级
- **权限级别**: read_only / limited / standard / elevated
- **沙箱**: 进程级轻量沙箱（命令/文件系统/网络），参考OpenClaw 2026.3.22安全增强
- **设计文档**: `workerclaw-design.md`
- **实现路径**: 4阶段（核心骨架→安全加固→任务管理→智能行为）
- **当前进度**: 四阶段全部完成（2026-03-28）
  - Phase 1: 核心骨架 MVP 完成
    - 15个源文件 + 4个配置文件，编译零错误
    - 模块: config, logger, events, types, ws-client, msg-parser, rate-limiter, source-verifier, security-gate, task-manager, llm-client, agent-engine, workerclaw主类, cli入口
    - 集成测试 6/6 通过
  - Phase 2: 安全加固完成
    - 新增 6 个源文件 + 50 个安全测试（总计 56/56 通过）
    - 内容扫描器: 提示注入30+模式、恶意命令20+模式、PII检测5种
    - 权限分级: 四级权限(read_only/limited/standard/elevated)、自动分级
    - 命令沙箱: 危险命令阻断、超时、环境变量过滤
    - 文件沙箱: 路径验证、工作目录隔离、路径遍历防护
    - 网络沙箱: URL验证、SSRF防护、域名黑白名单
  - Phase 3: 任务管理完成
    - 新增 7 个源文件 + 49 个任务管理测试（总计 99/99 通过）
    - 任务状态机: 10种状态、合法转换表、历史追踪
    - 任务评估器: 三维度评估（能力50%+容量20%+风险30%），accept/defer/reject 决策
    - 并发控制器: 最大并发、按类型限流、等待队列+优先级调度
    - 工具注册表: 8个内置工具、4级权限过滤
    - 工具执行器: 沙箱内执行、权限检查、超时保护
    - 平台API客户端: 结果上报、状态更新、心跳续约
    - TaskManager完整重构，集成所有Phase 3模块
  - Phase 4: 智能行为完成
    - 新增 14 个源文件 + 45 个测试（总计 144/144 通过）
    - 人格系统: 名称/语气/简介/专业领域/行为偏好/系统提示生成
    - 上下文窗口: token估算、3种截断策略(oldest/middle/summarize)
    - 会话管理: 多轮会话追踪、过期清理、上下文适配
    - 技能系统: 注册表+执行器+3个内置技能(写作/搜索/代码)
    - 智能活跃行为: 频率控制器+行为调度器(推文/浏览/评论/点赞)
    - AgentEngine完整重构: LLM调用循环+工具调用+人格+会话+技能
    - **WorkerClaw 框架四阶段全部完成！**

### OpenClaw 平台信息
- **版本**: 2026.3.24 (中文汉化版 `@qingchencloud/openclaw-zh`)
- **安装路径**: `/usr/local/lib/node_modules/@qingchencloud/openclaw-zh/`
- **CLI路径**: `/usr/local/bin/openclaw` (symlink → openclaw.mjs)
- **配置目录**: `~/.openclaw/`
- **插件SDK目录**: `dist/plugin-sdk/` (包含 core.js, index.js 及各种子路径模块)
- **插件安装**: `openclaw plugins install <package>` (优先ClawHub, 回退npm)

### OpenClaw 2026.3.22 重大架构变更
- **Plugin SDK 变更**:
  - 新公共SDK入口: `openclaw/plugin-sdk/*` (子路径导入)
  - 旧入口 `openclaw/extension-api` 被移除，无兼容shim
  - 内置插件必须用 `api.runtime` 注入方式做host-side操作
  - 外部/社区插件仍可使用根 `openclaw/plugin-sdk` 导入
- **安全增强**:
  - Exec沙箱: 阻止JVM注入(MAVEN_OPTS等)、glibc漏洞利用(GLIBC_TUNABLES)、.NET依赖劫持(DOTNET_ADDITIONAL_DEPS)
  - Voice-call webhook: 拒绝缺失签名的请求, pre-auth body降至64KB/5s, 限制并发
  - Windows安全: 阻止远程file://媒体URL和UNC路径(防SMB凭据泄露)
  - Nostr: 入站DM策略在解密前执行, 预加密速率/大小保护
  - Gateway: ws://默认仅loopback, 需显式opt-in才能开放私有网络
  - macOS LaunchAgent: 默认Umask=63(077), 文件权限更严格
  - Media: 远程错误响应体限制流式cap和超时
- **其他变更**:
  - 插件安装优先ClawHub
  - 新增 `openclaw skills search|install|update`
  - 移除Chrome扩展relay路径
  - 移除nano-banana-pro图像生成skill
  - 移除CLAWDBOT_*/MOLTBOT_*旧环境变量名
  - 新Matrix插件(官方matrix-js-sdk)
