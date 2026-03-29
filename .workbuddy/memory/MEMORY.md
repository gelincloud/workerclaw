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
- **主要功能**: 用户系统(双身份+RSA加密)、社交(Tweets/点赞/评论/关注/私信)、任务市场(发单/接单/报酬结算/余额)、等级系统(星/月/太阳/皇冠,最高256级)、实时通信(WebSocket)
- **部署**: 服务器 82.156.86.246, 路径 /root/bot-social, PM2 bot-social, HTTPS
- **数据库**: SQLite `./data/bots.db`，表: bots, tweets, tweet_likes, tweet_comments, tasks, messages, follows, transactions, experience_genes, experience_capsules, experience_reports
- **SSH**: root@82.156.86.246, 密钥 ~/.ssh/id_ed25519

### 项目2: MiniABC OpenClaw 插件 (`/Users/admin/WorkBuddy/openclaw-miniabc-channel`)
- **包名**: `@glin_1/miniabc`, 当前版本 2.0.14
- **类型**: OpenClaw Channel Plugin
- **核心功能**: 自动接单(多维度评估)、智能活跃行为(推文/浏览/评论/点赞)、任务管理、余额查询、Onboarding自动注册、技能扫描
- **源码**: 17个ts文件 (channel.ts/api.ts/config.ts/task-manager.ts/task-executor.ts等)
- **兼容方案**: sdk-compat.ts 内联实现+异步import热替换, 支持 modern/legacy SDK

### 项目3: WorkerClaw 公域 Agent 框架 (`/Users/admin/WorkBuddy/workerclaw`)
- **名称**: WorkerClaw - 公域 AI Agent 框架，专为"打工虾"设计
- **技术栈**: TypeScript 5.5 + Node.js 20+ (ESM)
- **定位**: 公域任务执行框架（区别于 OpenClaw 的个人宠物虾模式）
- **核心哲学**: "Trust the Platform, Verify Everything Else"
- **五层架构**: 接入层→安全审查层→任务管理层→Agent执行引擎→技能层
- **安全审查**: 速率限制→来源验证→内容安全扫描→权限分级(read_only/limited/standard/elevated)
- **沙箱**: 命令/文件系统/网络/浏览器(Process级轻量)
- **设计文档**: `workerclaw-design.md`
- **npm包**: `workerclaw`, 当前版本 0.9.0
- **配置文件**: ~/.workerclaw/config.json

### OpenClaw 平台信息
- **版本**: 2026.3.24 (中文汉化版 `@qingchencloud/openclaw-zh`)
- **安装路径**: `/usr/local/lib/node_modules/@qingchencloud/openclaw-zh/`
- **CLI**: `/usr/local/bin/openclaw`, 配置目录 `~/.openclaw/`
- **Plugin SDK**: `openclaw/plugin-sdk/*` (子路径导入), 旧 `openclaw/extension-api` 已移除

## WorkerClaw 版本历史 (2026-03-28)

| 版本 | 内容 |
|------|------|
| v0.2.0 | Phase 1-5 完成(核心骨架→安全→任务管理→智能行为→CLI) |
| v0.3.1 | WebSocket协议修复(对齐服务端auth/heartbeat/payload) |
| v0.3.2~3.3 | CLI配置体验优化 |
| v0.3.4~3.5 | 名称重复修复+版本号动态读取+Token完整性 |
| v0.3.6 | 消息处理全面修复(四路分发+私信/评论自动回复) |
| v0.3.7 | LLM工具过滤+金额阈值+API对齐服务端(takeTask/submitWork) |
| v0.4.0 | 经验基因系统(8个文件: 本地经验池+信号检测+搜索+封装+Hub) |
| v0.4.1 | AgentEngine+TaskManager经验集成+语义搜索+TF-IDF |
| v0.4.2 | takeTask await+消息去重+LLM拒绝检测+未知类型评分修正 |
| v0.5.0 | 文件附件支持(uploadFile+submitWorkWithFiles) |
| v0.6.0 | 拒收后续行动(LLM决策: resubmit/apologize/arbitrate/cancel) |
| v0.7.0 | Playwright浏览器技能(navigate/extract/screenshot) |
| v0.7.1 | 私信意图检测+任务引导规则+getActiveTaskIds |
| v0.8.0 | 智能评估v2(技能感知+描述分析)+拒绝/延迟时私信通知发单人 |
| v0.8.1 | 成果质量审核(checkOutputQuality)+找图任务引导+假工具调用检测+buildOutputs增强 |
| v0.8.2 | heartbeat/testConnection 404修复(改用GET /api/bot/:id, heartbeat改为no-op) |
| v0.8.3 | 质量失败自动降级(tryAutoRemediation)+任务失败时cancelTake释放接单状态 |
| v0.9.0 | 浏览器会话隔离(BrowserSessionManager)+交互工具(click/fill/wait)+共享Browser进程 |
| v0.10.0 | 任务估价与讨价还价(PriceRange配置+estimatePrice+price_inquiry意图+LLM智能报价) |
| v0.10.1 | 公共聊天室消息响应(chat_message处理+sendChatMessage+@提及检测) |
| v0.10.2 | WebSocket发送聊天消息(wsClient注入+sendChatMessage优先走WS回退HTTP) |

## v0.10.4 ~ v0.10.6 版本历史 (2026-03-29)

| 版本 | 内容 |
|------|------|
| v0.10.4 | Docker CLI 管理命令(status/skills/experience 支持 -c 参数, docker-entrypoint 增加子命令) |
| v0.10.5 | experience 命令支持 -c 配置文件路径参数 |
| v0.10.6 | 智能活跃行为功能完善(绑定平台API回调+发推/浏览/评论+configure选项+Docker配置) |
| v0.10.7 | 智能活跃扩展: 新增发博客/聊天室发言/空闲行为(7种行为类型+blog/chat API+personality支持) |

## 智工坊服务端 API 备忘
- 任务: POST /api/task/:id/take, POST /api/task/:id/submit, POST /api/task/:id/cancel-take, POST /api/task/:id/apply-arbitration
- 文件: POST /api/cos/upload (base64)
- 私信: POST /api/messages (senderId, receiverId, content)
- 评论: POST /api/tweets/:id/comments
- 经验Hub: POST /api/experience/genes, GET /api/experience/genes/search, GET /api/experience/stats, POST /api/experience/report
- 认证: X-Bot-Id header + botId 存在性检查
- WebSocket: wss://www.miniabc.top/ws/openclaw, 认证 `{ type: 'auth', payload: { botId, token } }`, 心跳 `{ type: 'heartbeat' }`
