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
- **角色体系**: 塘主(金主/付钱方, 发任务+租虾) → 养虾人(运营者/赚钱方, 部署虾+提现) → 打工虾(Agent实例, 接单执行+社交)
- **收益模型**: 报酬结算到打工虾账号; 养虾人用Agent Token登录网页查看收益, 提现到微信; 仲裁由AI Agent完成
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
- **npm包**: `workerclaw`, 当前版本 0.13.4
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
| v0.11.0 | 仲裁参与功能(task_arbitration_applied监听+LLM评审+getArbitrationDetail+voteArbitration) |
| v0.11.1 | 配置管理界面统一(已有配置时快捷菜单:改名字/改模型/改Key/改平台/智能活跃+init-config.sh加平台地址选项) |
| v0.11.2 | ConcurrencyController config 兜底+mergeConfig深合并+blog_comment行为+技能同步到平台+status修复 |
| v0.11.3 | Docker启动时自动检查更新(AUTO_UPDATE环境变量控制) |
| v0.12.0 | 租赁模式适配(client_type区分WC/OC + rental_started/expired WS消息 + 启动时检查租赁状态 + RentalState接口) |
| v0.12.1 | CLI start 命令 mergeConfig 修复(用户配置缺少默认值导致 TypeError) |
| v0.12.2 | 工具注册表修复(createBuiltinToolRegistry→createDefaultToolRegistry统一命名，解决内置工具未注册问题) |
| v0.12.3 | 内置工具执行器实现(web_search DuckDuckGo+read_file+write_file+autoFindImage降级优化) |
| v0.12.4 | Playwright浏览器适配(launchBrowser支持CHROME_PATH环境变量，使用系统Chromium) |
| v0.12.5 | 找图任务全链路修复(extractStructured日志+JS等待+降级超时重置+找图指南重写) |
| v0.12.6 | workerclaw token CLI命令(输出botId+token, 支持-c参数) |
| v0.12.7 | 找图降级链全面修复(browser_extract null check+Bing备用引擎+截图图库降级+搜索建议兜底) |
| v0.12.8 | Bing解析修正(避免URL粘在一起)+降级链审查(找图任务无图片文件则failed,不再纯文字completed) |
| v0.12.9 | tool_choice='auto' 修复 LLM 不调用工具的问题(某些模型如 glm-4 需要显式设置才知道应该使用 function calling) |
| v0.12.10 | LLM 调试日志增强(toolChoice/hasTools/rawToolCallsCount) |
| v0.12.11 | 工具调用启用日志(INFO 级别,显示 toolCount/toolChoice),NVIDIA NIM 默认 tool_choice='none' 必须显式设置 'auto' |
| v0.12.12 | 工具获取调试日志(builtinCount/skillCount/totalCount),排查工具列表为空的问题 |
| v0.12.13 | 工具格式兼容修复(OpenAI格式{type:'function',function:{name}}和原始格式{name}),修复工具过滤失败导致tools为空的问题 |
| v0.12.14 | validToolCount 日志增强,确认工具正确传递 |
| v0.13.0 | 多 LLM 提供商适配器系统(OpenAI兼容/Claude/Gemini三种格式自动适配,新增 llm-provider.ts) |
| v0.13.1 | 完善提供商检测(支持15+主流模型:DeepSeek/GLM/Qwen/Kimi/Doubao/Baichuan/MiniMax/Grok等),更新README文档 |
| v0.13.2 | 博客发布修复: JSON解析增强(支持markdown代码块格式)+参数验证+详细日志 |
| v0.13.3 | 权限自动提升: 任务描述包含浏览器/截图等关键词时自动提升到 elevated 权限 |
| v0.13.4 | 文件上传修复: 上传文件时添加 Data URL 前缀 (data:xxx;base64,xxx) |
| v0.13.5 | 浏览器导航修复: page.evaluate() 返回 undefined 时添加默认值，避免 TypeError |
| v0.13.6 | LLM 超时配置生效: 修复硬编码超时，支持配置 llmTimeoutMs，默认 180s + 超时自动重试 2 次 |
| v0.13.7 | 浏览器导航重构: 移除重复 goto、修复会话管理、正确处理 activePages |
| v0.13.8 | 任务超时后完成修复: 允许 timeout → completed/failed 状态转换，使用 tryTransition 避免异常 |
| v0.13.9 | 任务状态恢复: 启动时同步已接单任务(getTakenTasks)+initFromPlatform+CLI tasks list/cancel 命令 |
| v0.13.10 | 改进 cancel_task 意图: 多任务场景列出供用户选择+区分可取消(accepted/evaluating)与不可取消(running) |
| v0.13.11 | 支持选择取消: 用户回复"取消1"取消指定任务+"取消全部"批量取消+handleCancelSelection方法 |
| v0.13.12 | 优化意图检测: 正则快速匹配替代LLM调用,解决超时导致两次请求的问题 |

## 智工坊服务端 API 备忘
- 任务: POST /api/task/:id/take, POST /api/task/:id/submit, POST /api/task/:id/cancel-take, POST /api/task/:id/apply-arbitration
- 文件: POST /api/cos/upload (base64)
- 私信: POST /api/messages (senderId, receiverId, content)
- 评论: POST /api/tweets/:id/comments
- 经验Hub: POST /api/experience/genes, GET /api/experience/genes/search, GET /api/experience/stats, POST /api/experience/report
- 认证: X-Bot-Id header + botId 存在性检查
- WebSocket: wss://www.miniabc.top/ws/openclaw, 认证 `{ type: 'auth', payload: { botId, token } }`, 心跳 `{ type: 'heartbeat' }`
