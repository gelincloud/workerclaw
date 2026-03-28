#!/bin/bash
# WorkerClaw Docker 部署初始化脚本
# 在服务器上运行此脚本完成一键部署
#
# 用法: bash init-config.sh

set -e

CONFIG_DIR="$(dirname "$0")"
DATA_DIR="$CONFIG_DIR/docker-data"
CONFIG_FILE="$DATA_DIR/config.json"
ENV_FILE="$CONFIG_DIR/.env"

echo "🦐 WorkerClaw Docker 部署初始化"
echo "=============================="
echo ""

# 检查 Docker
if ! command -v docker &>/dev/null; then
  echo "❌ Docker 未安装，请先安装 Docker"
  exit 1
fi

if ! docker compose version &>/dev/null; then
  echo "❌ Docker Compose 未安装"
  exit 1
fi

echo "✅ Docker $(docker --version | grep -oP '\d+\.\d+\.\d+')"
echo ""

# 创建数据目录
mkdir -p "$DATA_DIR"

# 检查是否已有配置
if [ -f "$CONFIG_FILE" ]; then
  echo "📄 已有配置文件: $CONFIG_FILE"
  BOT_NAME=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$CONFIG_FILE','utf8')).personality?.name || '未知')" 2>/dev/null)
  BOT_ID=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$CONFIG_FILE','utf8')).platform?.botId || '未注册')" 2>/dev/null)
  echo "   Bot 名称: $BOT_NAME"
  echo "   Bot ID: $BOT_ID"
  echo ""
  read -p "是否重新配置？(y/N): " confirm
  if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
    echo "保持现有配置，跳过。"
    exit 0
  fi
fi

# 收集配置信息
echo "📝 请输入配置信息："
echo ""

# LLM 配置
echo "── LLM 服务 ──"
if [ -f "$ENV_FILE" ]; then
  source "$ENV_FILE"
fi

read -p "API Base URL [${LLM_BASE_URL:-https://integrate.api.nvidia.com/v1}]: " input_url
LLM_BASE_URL="${input_url:-${LLM_BASE_URL:-https://integrate.api.nvidia.com/v1}}"

read -p "API Key [${LLM_API_KEY:0:8}...]: " input_key
LLM_API_KEY="${input_key:-$LLM_API_KEY}"

read -p "模型名称 [${LLM_MODEL:-z-ai/glm5}]: " input_model
LLM_MODEL="${input_model:-${LLM_MODEL:-z-ai/glm5}}"

if [ -z "$LLM_API_KEY" ]; then
  echo "❌ API Key 不能为空"
  exit 1
fi

echo ""

# Bot 配置
echo "── Bot 信息 ──"
read -p "Bot 名称 [小工虾]: " bot_name
bot_name="${bot_name:-小工虾}"

read -p "Bot 语气 [专业、友好、高效]: " bot_tone
bot_tone="${bot_tone:-专业、友好、高效}"

read -p "Bot 简介 [智工坊平台的打工虾]: " bot_bio
bot_bio="${bot_bio:-智工坊平台的打工虾}"

echo ""

# 平台配置
echo "── 平台连接 ──"
read -p "平台 API URL [https://www.miniabc.top]: " api_url
api_url="${api_url:-https://www.miniabc.top}"

ws_url="${api_url}/ws/openclaw"

# 生成配置文件
echo "📄 生成配置文件..."

cat > "$CONFIG_FILE" << EOFCONFIG
{
  "id": "worker-docker-001",
  "name": "WorkerClaw-Docker",
  "platform": {
    "apiUrl": "${api_url}",
    "wsUrl": "${ws_url}",
    "botId": "",
    "token": "",
    "agentName": "${bot_name}",
    "reconnect": {
      "maxRetries": 5,
      "baseDelayMs": 1000,
      "maxDelayMs": 30000
    }
  },
  "llm": {
    "provider": "openai-compatible",
    "model": "${LLM_MODEL}",
    "apiKey": "\${WC_LLM_API_KEY}",
    "baseUrl": "\${WC_LLM_BASE_URL}",
    "safety": {
      "maxTokens": 4096,
      "temperature": 0.7,
      "topP": 0.9
    },
    "retry": {
      "maxRetries": 2,
      "backoffMs": 3000
    }
  },
  "personality": {
    "name": "${bot_name}",
    "tone": "${bot_tone}",
    "bio": "${bot_bio}"
  }
}
EOFCONFIG

# 生成 .env 文件
cat > "$ENV_FILE" << EOFENV
LLM_API_KEY=${LLM_API_KEY}
LLM_BASE_URL=${LLM_BASE_URL}
LLM_MODEL=${LLM_MODEL}
EOFENV

# 修复权限
chmod 600 "$ENV_FILE"

echo "✅ 配置文件已生成:"
echo "   配置: $CONFIG_FILE"
echo "   环境变量: $ENV_FILE"
echo ""

# 尝试自动注册 Bot
echo "🔑 尝试自动注册 Bot..."
AGENT_ID="agent-docker-$(date +%s)"

REGISTER_RESPONSE=$(curl -s --max-time 15 "${api_url}/api/openclaw/register" \
  -H "Content-Type: application/json" \
  -d "{
    \"agentId\": \"${AGENT_ID}\",
    \"agentName\": \"${bot_name}\",
    \"capabilities\": [\"text_reply\", \"qa\", \"search_summary\", \"writing\", \"translation\", \"image_gen\", \"code_dev\"],
    \"autoPostTweet\": true
  }" 2>&1)

if echo "$REGISTER_RESPONSE" | jq -e '.botId' >/dev/null 2>&1; then
  BOT_ID=$(echo "$REGISTER_RESPONSE" | jq -r '.botId')
  TOKEN=$(echo "$REGISTER_RESPONSE" | jq -r '.token')

  # 更新配置文件中的 botId 和 token
  if command -v jq &>/dev/null; then
    jq --arg bid "$BOT_ID" --arg tok "$TOKEN" \
      '.platform.botId = $bid | .platform.token = $tok' \
      "$CONFIG_FILE" > "$CONFIG_FILE.tmp" && mv "$CONFIG_FILE.tmp" "$CONFIG_FILE"
  else
    # 没有 jq，用 node
    node -e "
      const fs = require('fs');
      const c = JSON.parse(fs.readFileSync('$CONFIG_FILE','utf8'));
      c.platform.botId = '$BOT_ID';
      c.platform.token = '$TOKEN';
      fs.writeFileSync('$CONFIG_FILE', JSON.stringify(c, null, 2));
    "
  fi

  echo "✅ Bot 注册成功!"
  echo "   Bot ID: $BOT_ID"
  echo "   Token: ${TOKEN:0:16}..."
  echo ""
else
  echo "⚠️ 自动注册失败（服务器可能不可达）"
  echo "   响应: ${REGISTER_RESPONSE:0:200}"
  echo ""
  echo "   你可以稍后手动注册，或直接填写 Bot ID 和 Token:"
  read -p "   Bot ID: " manual_bot_id
  read -p "   Token: " manual_token

  if [ -n "$manual_bot_id" ] && [ -n "$manual_token" ]; then
    if command -v jq &>/dev/null; then
      jq --arg bid "$manual_bot_id" --arg tok "$manual_token" \
        '.platform.botId = $bid | .platform.token = $tok' \
        "$CONFIG_FILE" > "$CONFIG_FILE.tmp" && mv "$CONFIG_FILE.tmp" "$CONFIG_FILE"
    else
      node -e "
        const fs = require('fs');
        const c = JSON.parse(fs.readFileSync('$CONFIG_FILE','utf8'));
        c.platform.botId = '$manual_bot_id';
        c.platform.token = '$manual_token';
        fs.writeFileSync('$CONFIG_FILE', JSON.stringify(c, null, 2));
      " 2>/dev/null || echo "⚠️ 需要安装 jq 或 node 来更新配置"
    fi
    echo "✅ 已手动配置 Bot"
  fi
fi

echo ""
echo "=============================="
echo "🚀 初始化完成！"
echo ""
echo "启动命令:"
echo "  docker compose up -d"
echo ""
echo "查看日志:"
echo "  docker compose logs -f"
echo ""
echo "停止:"
echo "  docker compose down"
echo ""
