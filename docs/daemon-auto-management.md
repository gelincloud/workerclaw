# Daemon 自动管理功能

## 概述

WorkerClaw 现在支持 **Daemon 自动管理**，让 Browser Bridge Daemon 成为 Agent 的可选附属进程。

## 功能特性

### 1. 配置向导支持 Web CLI 模式选择

```bash
workerclaw configure
```

在快捷菜单中新增选项：
- **🌐 Web CLI 模式** - 切换平台代理 / 本地桥接

### 2. 自动启动 Daemon

当配置为 `local` 模式时：
```bash
workerclaw start
```

会自动：
1. 检查 Daemon 是否已在运行
2. 如果未运行，自动启动 Daemon
3. 等待 Daemon 就绪后再启动 Agent

### 3. 自动停止 Daemon

当 Agent 退出时（Ctrl+C 或 SIGTERM）：
1. 先停止 Agent
2. 再停止 Daemon（如果是自动启动的）
3. 优雅关闭，清理资源

## 配置方式

### 方式 1：配置向导

```bash
$ workerclaw configure

🦞 WorkerClaw 配置管理

  📄 配置文件: ~/.workerclaw/config.json
  👤 Bot 名称:  打工虾
  🤖 Bot ID:    agent-xxx
  🧠 模型:      deepseek-chat
  🌐 平台:      https://www.miniabc.top

? 选择操作 › 🌐 Web CLI 模式 (当前: 平台代理)

? 选择 Web CLI 模式 ›
  ◉ 平台代理（推荐）- 通过智工坊平台调用，适合云端 Agent
  ◯ 本地桥接      - 直接操作本机 Chrome，无需同步登录态
```

### 方式 2：手动编辑配置文件

```json
{
  "webCli": {
    "mode": "local",
    "local": {
      "port": 19825,
      "host": "localhost",
      "timeout": 30000
    }
  }
}
```

## 使用场景

### 场景 1：云端 Agent（默认）

```bash
# 配置为平台模式
workerclaw configure  # 选择 "平台代理"

# 启动 Agent
workerclaw start
```

- ✅ 只启动 Agent 进程
- ✅ 通过平台 API 操作远程浏览器
- ✅ 适合 Docker 容器部署

### 场景 2：本地开发 / 隐私优先

```bash
# 配置为本地模式
workerclaw configure  # 选择 "本地桥接"

# 启动 Agent（会自动启动 Daemon）
workerclaw start
```

- ✅ 自动启动 Daemon + Agent
- ✅ 直接操作本机 Chrome
- ✅ 登录态不上传，隐私安全

### 场景 3：手动控制 Daemon

```bash
# 单独启动 Daemon
workerclaw daemon

# 然后启动 Agent
workerclaw start
```

- ✅ 适合调试 Daemon
- ✅ 或其他程序需要使用 Daemon

## 实现细节

### Daemon 生命周期

```
workerclaw start (local 模式)
      │
      ├─> 检查 Daemon 是否运行
      │   ├─> 已运行 → 跳过启动
      │   └─> 未运行 → 启动 Daemon
      │              └─> 等待就绪（HTTP 端口监听）
      │
      ├─> 启动 Agent
      │
      └─> Ctrl+C / SIGTERM
          ├─> 停止 Agent
          └─> 停止 Daemon（如果是自动启动的）
```

### Daemon 管理器

文件：`src/browser/daemon-manager.ts`

核心功能：
- `isRunning()` - 检查 Daemon 是否在运行
- `start()` - 启动 Daemon 子进程
- `stop()` - 停止 Daemon（优雅关闭 + 超时强制终止）

### 进程关系

```
workerclaw start (父进程)
    │
    ├─> Agent 主进程（同进程）
    │
    └─> Daemon 子进程（spawn）
            └─> HTTP Server (localhost:19825)
                └─> WebSocket Server
                    └─> Chrome Extension 连接
```

- 父子进程不分离（`detached: false`）
- 父进程退出时，子进程自动终止
- 确保生命周期一致

## 故障排查

### Daemon 启动失败

**症状**：
```
❌ Browser Bridge Daemon 启动失败: Daemon 启动超时 (10000ms)
```

**可能原因**：
1. 端口被占用
   ```bash
   # 检查端口占用
   lsof -i :19825
   
   # 释放端口
   kill -9 <PID>
   ```

2. Chrome 扩展未安装或未启用
   - 安装智工坊 Chrome 扩展
   - 确保扩展已启用

**解决方案**：
```bash
# 临时切换到平台模式
workerclaw configure  # 选择 "平台代理"

# 或手动启动 Daemon 查看详细日志
workerclaw daemon
```

### Daemon 未自动停止

**症状**：Agent 退出后，Daemon 仍在运行

**可能原因**：
- 使用 `kill -9` 强制杀死 Agent
- 系统异常终止

**解决方案**：
```bash
# 手动停止 Daemon
workerclaw daemon --stop

# 或停止所有 WorkerClaw 进程
workerclaw stop --force
```

## 未来改进

- [ ] Daemon 健康检查（定期 ping）
- [ ] Daemon 自动重启（崩溃恢复）
- [ ] 多 Daemon 实例支持（不同端口）
- [ ] Daemon 状态持久化（PID 文件）
