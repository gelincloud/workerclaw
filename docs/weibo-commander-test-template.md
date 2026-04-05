# 微博运营指挥官 - 测试模板使用指南

## 📋 概述

测试模板（`test`）用于快速验证微博 API 和系统稳定性，通过高频次任务执行来检测潜在问题。

## 🎯 适用场景

- 开发环境测试
- API 稳定性验证
- 凭据有效性检查
- 系统错误监控

## ⚙️ 配置方法

### 方法一：修改配置文件

在 `workerclaw.config.json` 中设置：

```json
{
  "weiboCommander": {
    "enabled": true,
    "ownerId": "your-owner-id",
    "templateId": "test",
    "collection": {
      "intervalMs": 600000,
      "collectTrending": true,
      "collectInteractions": true
    },
    "automation": {
      "autoPost": false,
      "autoReply": false,
      "maxPostsPerDay": 0,
      "maxRepliesPerDay": 0
    }
  }
}
```

### 方法二：环境变量

```bash
export WEIBO_COMMANDER_TEMPLATE=test
```

## 📅 任务安排

测试模板包含 3 个任务，每 10 分钟执行一次：

| 任务ID | 类型 | 执行频率 | 描述 |
|--------|------|----------|------|
| `test-check-me` | analyze_data | */10 * * * | 检查微博登录态 |
| `test-browse-trends` | browse_trends | */10 * * * | 获取微博热搜榜 |
| `test-check-mentions` | check_mentions | */10 * * * | 检查微博@提及 |

## 🧪 测试任务详情

### 1. test-check-me
- **目的**: 验证微博登录态是否有效
- **API调用**: `weibo me`
- **预期结果**: 返回用户基本信息
- **失败场景**: HTTP 400/401/403 → 凭据失效或API限制

### 2. test-browse-trends
- **目的**: 测试热搜API是否正常
- **API调用**: `weibo hot_search`
- **预期结果**: 返回热搜列表（前5条）
- **失败场景**: 网络错误、API变更

### 3. test-check-mentions
- **目的**: 测试@提及API是否正常
- **API调用**: `weibo mentions`
- **预期结果**: 返回@提及数量
- **失败场景**: 权限不足、API限制

## 📊 监控方法

### Docker 日志监控

```bash
# 实时查看日志
docker logs -f <container-id>

# 过滤测试任务日志
docker logs <container-id> 2>&1 | grep "【测试任务】"

# 查看错误日志
docker logs <container-id> 2>&1 | grep -i "error\|fail\|http 4"
```

### 平台日志监控

在服务器上查看平台日志：

```bash
ssh root@82.156.86.246
pm2 logs bot-social | grep -i "weibo"
```

### 关键指标

- **成功率**: 应保持 100%
- **HTTP 状态码**: 应全部为 200
- **响应时间**: 应 < 5秒
- **错误类型**: 记录具体错误信息

## ⚠️ 注意事项

1. **仅用于测试**: 测试模板不会实际发布或回复，仅调用API
2. **频率限制**: 每10分钟一次，每小时6次，避免触发微博限流
3. **监控时长**: 建议测试1-2小时后切回标准模板
4. **数据安全**: 测试任务不会修改账号数据

## 🔄 切换回标准模板

测试完成后，修改配置：

```json
{
  "weiboCommander": {
    "templateId": "standard"  // 或删除此行使用默认值
  }
}
```

然后重启实例：

```bash
docker compose restart
```

## 🐛 常见问题排查

### 问题1：所有测试任务失败

**可能原因**:
- 微博凭据失效
- 平台API地址错误
- 网络连接问题

**排查步骤**:
1. 检查凭据状态：访问 `https://www.miniabc.top/cli-dashboard.html`
2. 验证平台连接：检查 `platformApiUrl` 配置
3. 查看平台日志：`pm2 logs bot-social`

### 问题2：部分任务失败

**可能原因**:
- 特定API被限制
- 微博接口变更
- 临时网络波动

**排查步骤**:
1. 记录失败的API端点
2. 手动测试该API
3. 检查微博API文档是否有更新

### 问题3：间歇性失败

**可能原因**:
- 微博反爬机制
- 请求频率过高
- IP被临时限制

**解决方案**:
- 降低执行频率（如改为每15分钟）
- 增加请求间隔
- 联系平台管理员调整策略

## 📈 测试报告示例

```
=== 微博运营指挥官测试报告 ===
测试时间: 2026-04-06 00:30 - 01:30 (1小时)
测试模板: test
执行次数: 18次 (3任务 × 6次/小时)

✅ 成功: 17次 (94.4%)
❌ 失败: 1次 (5.6%)

失败详情:
- 01:15 test-check-mentions: HTTP 429 (频率限制)

结论: API基本稳定，建议降低mentions任务频率
```

## 🔗 相关资源

- [微博运营指挥官文档](./weibo-commander.md)
- [WorkerClaw 配置说明](../README.md)
- [平台 CLI 文档](../../20260310201629/README.md)

---

**版本**: workerclaw@0.18.16  
**更新时间**: 2026-04-06
