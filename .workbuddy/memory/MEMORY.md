# MEMORY.md - 跨会话长期记忆

> 2026-04-03 整理：合并旧版本流水记录，保留仍然有效的长期信息与项目约定。

## 用户信息
- 用户邮箱：glin_1@qq.com
- GitHub：gelincloud
- 偏好：中文沟通
- 智工坊主域名：https://www.miniabc.top

## 项目 1：智工坊网站平台（`/Users/admin/WorkBuddy/20260310201629`）
- 定位：AI Agent 社交任务平台（MiniABC）
- 技术栈：Node.js + Express + SQLite(sql.js) + WebSocket + 原生 HTML/CSS/JS
- 主要角色：塘主（发任务/付费）→ 养虾人（运营 Agent）→ 打工虾（执行任务）
- 主要功能：用户系统、社交流、任务市场、余额结算、等级系统、实时通信
- 部署：`82.156.86.246:/root/bot-social`，PM2 进程 `bot-social`
- 核心数据库：`./data/bots.db`
- 对象存储：腾讯云 COS，bucket `miniabc-1259638100`，region `ap-guangzhou`
- WorkerClaw 控制台：`/console.html`，支持购买/启动/停止/重启实例、Web 终端、日志查看
- 控制台相关表：`wc_instances`、`wc_orders`
- 控制台相关 WS：`/ws/console/terminal`、`/ws/console/logs`

## 项目 2：MiniABC OpenClaw 插件（`/Users/admin/WorkBuddy/openclaw-miniabc-channel`）
- 包名：`@glin_1/miniabc`
- 当前记忆版本：`2.0.14`
- 类型：OpenClaw Channel Plugin
- 作用：自动接单、任务管理、智能活跃行为、余额查询、自动注册、技能扫描
- 兼容策略：`sdk-compat.ts` 做 modern/legacy SDK 兼容

## 项目 3：WorkerClaw（`/Users/admin/WorkBuddy/workerclaw`）
- 定位：公域 AI Agent 框架，面向“打工虾”
- 技术栈：TypeScript 5.5 + Node.js 20+（ESM）
- 核心哲学：Trust the Platform, Verify Everything Else
- 五层结构：接入层 → 安全审查层 → 任务管理层 → Agent 执行引擎 → 技能层
- 权限分级：`read_only / limited / standard / elevated`
- 配置文件：`~/.workerclaw/config.json`
- 当前记忆版本：`0.14.0`
- 当前已实现的重要能力：
  - 多 Provider LLM 配置
  - 经验基因系统
  - 浏览器技能与会话隔离
  - 文件上传、仲裁参与、活跃行为、租赁模式
  - OpenCLI 公共 API 工具集成（v0.14.0）

### WorkerClaw 阶段三架构方向（重要）
- 目标方向是 **平台中心化 web_cli**，而不是长期在 Agent 端维护大量直连网站工具。
- 理想链路：`Agent -> 平台 /api/cli/:site/:cmd -> 平台执行引擎(fetch/browser/auth) -> 返回结果`
- 平台侧负责：
  - 公网请求代理
  - 浏览器池 / headless Chromium 共享
  - 登录态注入（塘主账号）
  - 速率限制、缓存、审计、计费
- Agent 侧应尽量轻：优先保留通用 `web_cli`，减少对站点细节和浏览器资源的承担。

## OpenClaw 平台信息
- 版本：2026.3.24（`@qingchencloud/openclaw-zh`）
- 安装路径：`/usr/local/lib/node_modules/@qingchencloud/openclaw-zh/`
- CLI：`/usr/local/bin/openclaw`
- 配置目录：`~/.openclaw/`
- Plugin SDK：`openclaw/plugin-sdk/*`

## 服务端 API / 协议备忘
- 任务：`POST /api/task/:id/take`、`/submit`、`/cancel-take`、`/apply-arbitration`
- 文件：`POST /api/cos/upload`
- 私信：`POST /api/messages`
- 评论：`POST /api/tweets/:id/comments`
- 经验 Hub：`POST /api/experience/genes`、`GET /api/experience/genes/search`、`GET /api/experience/stats`、`POST /api/experience/report`
- Bot 认证：`X-Bot-Id` + botId 存在性校验
- WebSocket：`wss://www.miniabc.top/ws/openclaw`，认证 payload 为 `{ botId, token }`

## 稳定运维约定
- `data/bots.db` 不应提交到 git；`.gitignore` 已忽略 `data/`
- 服务器更新代码避免使用 `git reset --hard`；优先 `git pull` 或 `git stash + pull`
- WorkerClaw 容器自动更新修复结论：
  - `AUTO_UPDATE=true`
  - 重启应使用 `docker compose down && docker compose up -d`
- 若改动 `Dockerfile` 或 `docker-entrypoint.sh`，需要 `docker compose up -d --build`
- 纯 npm 包代码更新时，容器启动会自动 `npm install -g workerclaw` 拉取最新版；Dockerfile 未变通常不必重建镜像

## 近期关键版本备忘
- `v0.12.0`：租赁模式适配
- `v0.12.3`：内置工具执行器实现
- `v0.13.0`：多 LLM 提供商适配器系统
- `v0.13.16`：Docker 配置路径统一到 `~/.workerclaw/config.json`
- `v0.13.21`：多 Provider 端点配置支持（CLI / init-config.sh / console.html）
- `v0.14.0`：OpenCLI 公共 API 工具集成 + `web_cli` + 平台 CLI 代理入口（过渡版）
- `v0.15.0`：阶段三平台中心化架构 — 命令注册表 + 三引擎分发（fetch/browser/auth）+ 缓存/限流/审计 + 凭据管理 + `web_cli_describe` 命令发现
- `v0.15.1`：阶段三完善 — 浏览器池 Context Pool + 更多 auth 命令(知乎/B站/Twitter) + Chrome 扩展 + CLI 管理面板 + 直连工具收缩为 debug-only
- `v0.16.0`：私有虾消息处理重构 — 主人(renterId)私信直接执行不走任务流，外部人员私信礼貌拒绝，不参与聊天室；ownerId 仅从服务器拉取不可本地配置
- `v0.16.1`：被租用虾自动变私有虾 — isPrivateMode 扩展为 config.mode==='private' OR rentalState.active，被租用时停止社交行为，到期后自动恢复
- `v0.16.3`：私有虾主人指令直接执行 — isOwner 增加 config.ownerId（私有虾直接购买无租赁），handleOwnerDirectMessage 用 executeTask 真正执行工具调用
- `v0.16.5`：修复 config 传递 — TaskManagerConfig 新增 mode/ownerId，WorkerClaw 创建 TaskManager 时传入
- `v0.16.6`：LLM 限速自动切换端点 — 重试时切换到下一个端点，429 触发 60s 冷却自动跳过
- **踩坑备忘**：旧私有虾实例 config 中可能没有 `mode` 和 `ownerId`，需要手动补后重启
- **v0.17.0**：定时任务调度器 — RecurringTaskScheduler（cron 解析、频率限制、执行历史持久化）、私有虾主人私信指令管理定时任务（自然语言+精确格式）、私有虾模式自动启动调度器替代社交行为
- **v0.17.1**（进行中）：微博 PR 能力增强 — 平台新增 weibo/hot_search(fetch)、weibo/retweet(auth)、weibo/comment(auth)、weibo/like(auth) 四个命令；Agent 本地新增 weibo_hot_search + weibo_search 工具；Agent prompt 自动识别微博推广任务并附加热搜话题结合引导策略
