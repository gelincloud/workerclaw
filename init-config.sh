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
  BOT_NAME=$(python3 -c "import json; d=json.load(open('$CONFIG_FILE')); print(d.get('personality',{}).get('name','未知'))" 2>/dev/null)
  BOT_ID=$(python3 -c "import json; d=json.load(open('$CONFIG_FILE')); print(d.get('platform',{}).get('botId','未注册'))" 2>/dev/null)
  LLM_MODEL_CUR=$(python3 -c "import json; d=json.load(open('$CONFIG_FILE')); print(d.get('llm',{}).get('model','未知'))" 2>/dev/null)
  echo "   Bot 名称: $BOT_NAME"
  echo "   Bot ID: $BOT_ID"
  echo "   模型: $LLM_MODEL_CUR"
  echo ""
  echo "   1) 完全重新配置（包括重新注册 Bot）"
  echo "   2) 仅修改 Bot 名称"
  echo "   3) 仅修改大模型配置"
  echo "   4) 仅修改 LLM API Key"
  echo "   5) 仅修改平台地址"
  echo "   6) 保持现有配置，跳过"
  echo ""
  read -p "   请选择 [6]: " config_choice
  config_choice="${config_choice:-6}"

  case "$config_choice" in
    2)
      BOT_ID_CUR=$(python3 -c "import json; d=json.load(open('$CONFIG_FILE')); print(d.get('platform',{}).get('botId',''))" 2>/dev/null)
      BOT_TOKEN=$(python3 -c "import json; d=json.load(open('$CONFIG_FILE')); print(d.get('platform',{}).get('token',''))" 2>/dev/null)
      read -p "   新的 Bot 名称 [$BOT_NAME]: " new_name
      new_name="${new_name:-$BOT_NAME}"
      python3 -c "
import json
cfg_path = '${CONFIG_FILE}'
with open(cfg_path, 'r') as f:
    c = json.load(f)
c['personality']['name'] = '${new_name}'
c['platform']['agentName'] = '${new_name}'
with open(cfg_path, 'w') as f:
    json.dump(c, f, indent=2, ensure_ascii=False)
print('✅ Bot 名称已更新为: ${new_name}')
"
      # 同步名字到平台服务器（带 token 认证）
      if [ -n "$BOT_ID_CUR" ] && [ -n "$BOT_TOKEN" ]; then
        # 从配置文件读取平台地址（走快捷菜单时 api_url 变量可能未定义）
        API_URL_FROM_CFG=$(python3 -c "import json; d=json.load(open('$CONFIG_FILE')); print(d.get('platform',{}).get('apiUrl',''))" 2>/dev/null)
        BOT_API_URL="${API_URL_FROM_CFG:-https://www.miniabc.top}"
        echo "   同步名称到平台服务器..."
        if command -v curl &>/dev/null; then
          SYNC_RESULT=$(curl -s --max-time 10 -X PUT "${BOT_API_URL}/api/bot/${BOT_ID_CUR}/profile" \
            -H "Content-Type: application/json" \
            -H "X-Bot-Id: ${BOT_ID_CUR}" \
            -H "X-Bot-Token: ${BOT_TOKEN}" \
            -d "{\"nickname\":\"${new_name}\"}" 2>&1)
        elif command -v wget &>/dev/null; then
          SYNC_RESULT=$(wget -qO- --timeout=10 \
            --header="Content-Type: application/json" \
            --header="X-Bot-Id: ${BOT_ID_CUR}" \
            --header="X-Bot-Token: ${BOT_TOKEN}" \
            --post-data="{\"nickname\":\"${new_name}\"}" \
            "${BOT_API_URL}/api/bot/${BOT_ID_CUR}/profile" 2>&1)
        fi
        if echo "$SYNC_RESULT" | grep -q '"success"'; then
          echo "   ✅ 平台服务器已同步"
        else
          echo "   ⚠️ 平台同步失败（响应: ${SYNC_RESULT:0:100}）"
          echo "   💡 名称会在容器启动连接平台后自动生效，不影响使用"
        fi
      else
        echo "   ⚠️ 未找到 Bot ID 或 Token，跳过平台同步"
      fi
      echo ""
      echo "   重启容器生效: docker compose restart"
      exit 0
      ;;
    3)
      echo "   当前模型: $LLM_MODEL_CUR"
      read -p "   新的 API Base URL: " new_url
      read -p "   新的模型名称 [$LLM_MODEL_CUR]: " new_model
      new_model="${new_model:-$LLM_MODEL_CUR}"
      python3 -c "
import json
cfg_path = '${CONFIG_FILE}'
with open(cfg_path, 'r') as f:
    c = json.load(f)
new_url = '${new_url}'
if new_url:
    c['llm']['baseUrl'] = '\${WC_LLM_BASE_URL}'
    # 更新 .env
    env_path = '${ENV_FILE}'
    with open(env_path, 'r') as f:
        lines = f.readlines()
    with open(env_path, 'w') as f:
        for line in lines:
            if line.startswith('WC_LLM_BASE_URL=') or line.startswith('LLM_BASE_URL='):
                prefix = line.split('=')[0] + '='
                f.write(prefix + new_url + '\n')
            else:
                f.write(line)
c['llm']['model'] = '${new_model}'
with open(cfg_path, 'w') as f:
    json.dump(c, f, indent=2, ensure_ascii=False)
print('✅ 模型配置已更新')
print('   模型: ${new_model}')
" 2>/dev/null
      echo ""
      echo "   重启容器生效: docker compose restart"
      exit 0
      ;;
    4)
      if [ -f "$ENV_FILE" ]; then
        source "$ENV_FILE"
      fi
      read -p "   新的 API Key [${LLM_API_KEY:0:8}...]: " new_key
      new_key="${new_key:-$LLM_API_KEY}"
      if [ -z "$new_key" ]; then
        echo "❌ API Key 不能为空"
        exit 1
      fi
      # 更新 .env
      python3 -c "
env_path = '${ENV_FILE}'
new_key = '${new_key}'
with open(env_path, 'r') as f:
    lines = f.readlines()
with open(env_path, 'w') as f:
    for line in lines:
        if line.startswith('WC_LLM_API_KEY=') or line.startswith('LLM_API_KEY='):
            prefix = line.split('=')[0] + '='
            f.write(prefix + new_key + '\n')
        else:
            f.write(line)
print('✅ API Key 已更新')
"
      echo ""
      echo "   重启容器生效: docker compose restart"
      exit 0
      ;;
    5)
      API_URL_CUR=$(python3 -c "import json; d=json.load(open('$CONFIG_FILE')); print(d.get('platform',{}).get('apiUrl',''))" 2>/dev/null)
      WS_URL_CUR=$(python3 -c "import json; d=json.load(open('$CONFIG_FILE')); print(d.get('platform',{}).get('wsUrl',''))" 2>/dev/null)
      echo "   当前平台 API: $API_URL_CUR"
      echo "   当前平台 WS:  $WS_URL_CUR"
      read -p "   新的平台 API 地址 [$API_URL_CUR]: " new_api_url
      new_api_url="${new_api_url:-$API_URL_CUR}"
      read -p "   新的平台 WebSocket 地址 [$WS_URL_CUR]: " new_ws_url
      new_ws_url="${new_ws_url:-$WS_URL_CUR}"
      python3 -c "
import json
cfg_path = '${CONFIG_FILE}'
with open(cfg_path, 'r') as f:
    c = json.load(f)
c['platform']['apiUrl'] = '${new_api_url}'
c['platform']['wsUrl'] = '${new_ws_url}'
with open(cfg_path, 'w') as f:
    json.dump(c, f, indent=2, ensure_ascii=False)
print('✅ 平台地址已更新')
print('   API: ${new_api_url}')
print('   WS:  ${new_ws_url}')
" 2>/dev/null
      echo ""
      echo "   重启容器生效: docker compose restart"
      exit 0
      ;;
    6)
      echo "保持现有配置，跳过。"
      exit 0
      ;;
    *)
      # 选择1，继续完整重新配置
      echo "→ 完全重新配置（将重新注册 Bot）"
      echo ""
      ;;
  esac
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

# 多端点配置
ENDPOINTS_JSON=""
read -p "是否配置多个 LLM 端点？（用于 API Key 轮换或多 Provider 混用）[y/N]: " multi_ep
if [ "$multi_ep" = "y" ] || [ "$multi_ep" = "Y" ]; then
  ENDPOINTS_ARRAY="[]"
  
  # 添加主端点
  MAIN_EP="{\"name\":\"主端点\",\"apiKey\":\"${LLM_API_KEY}\",\"baseUrl\":\"${LLM_BASE_URL}\",\"model\":\"${LLM_MODEL}\",\"weight\":1}"
  ENDPOINTS_ARRAY=$(python3 -c "import json; arr=json.loads('$ENDPOINTS_ARRAY'); arr.append($MAIN_EP); print(json.dumps(arr))")
  
  ep_index=1
  while true; do
    echo ""
    echo "── 配置第 $((ep_index + 1)) 个端点 ──"
    read -p "继续添加？[Y/n]: " continue_add
    if [ "$continue_add" = "n" ] || [ "$continue_add" = "N" ]; then
      break
    fi
    
    read -p "端点名称 [端点${ep_index}]: " ep_name
    ep_name="${ep_name:-端点${ep_index}}"
    
    read -p "API Base URL [${LLM_BASE_URL}]: " ep_url
    ep_url="${ep_url:-$LLM_BASE_URL}"
    
    read -p "API Key: " ep_key
    if [ -z "$ep_key" ]; then
      echo "跳过（API Key 为空）"
      continue
    fi
    
    read -p "模型名称 [${LLM_MODEL}]: " ep_model
    ep_model="${ep_model:-$LLM_MODEL}"
    
    read -p "权重 [1]: " ep_weight
    ep_weight="${ep_weight:-1}"
    
    # 添加到数组（使用 python3 处理 JSON）
    NEW_EP="{\"name\":\"${ep_name}\",\"apiKey\":\"${ep_key}\",\"baseUrl\":\"${ep_url}\",\"model\":\"${ep_model}\",\"weight\":${ep_weight}}"
    ENDPOINTS_ARRAY=$(python3 -c "import json; arr=json.loads('$ENDPOINTS_ARRAY'); arr.append($NEW_EP); print(json.dumps(arr))")
    
    ep_index=$((ep_index + 1))
    
    # 最多 10 个端点
    if [ $ep_index -ge 10 ]; then
      echo "已达到最大端点数量（10个）"
      break
    fi
  done
  
  # 生成 endpoints JSON 字符串
  ENDPOINTS_JSON=", \"endpoints\": ${ENDPOINTS_ARRAY}"
fi

# Bot 配置
echo "── Bot 信息 ──"
# 随机生成默认 Bot 名称（避免所有 bot 都叫小工虾）
RANDOM_NAMES=("小工虾" "打工人" "摸鱼侠" "螺丝钉" "搬砖喵" "码农虾" "打工蟹" "键盘侠" "摸鱼虾" "奋斗虾" "社畜侠" "卷王虾" "佛系虾" "加班侠" "摸虾侠" "咸鱼侠" "搬砖侠" "码字侠" "冲浪侠" "躺平侠" "早起虾")
RANDOM_NAME="${RANDOM_NAMES[$((RANDOM % ${#RANDOM_NAMES[@]}))]}"
# 追加随机数字让名字更独特
RANDOM_NUM=$((RANDOM % 900 + 100))
DEFAULT_BOT_NAME="${RANDOM_NAME}${RANDOM_NUM}"

read -p "Bot 名称 [${DEFAULT_BOT_NAME}]: " bot_name
bot_name="${bot_name:-$DEFAULT_BOT_NAME}"

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
    }${ENDPOINTS_JSON}
  },
  "security": {
    "rateLimit": {
      "maxMessagesPerMinute": 30,
      "maxConcurrentTasks": 3
    },
    "contentScan": {
      "promptInjection": { "enabled": true },
      "maliciousCommands": { "enabled": true },
      "piiProtection": { "enabled": false, "action": "warn" },
      "resourceExhaustion": {
        "maxOutputTokens": 8000,
        "maxToolCallsPerTask": 20,
        "maxTotalDurationMs": 300000
      }
    },
    "sandbox": {
      "workDir": "./data/sandbox",
      "commandTimeoutMs": 30000,
      "taskTimeoutMs": 300000,
      "maxMemoryMB": 512,
      "maxOutputKB": 1024,
      "deniedPaths": ["/etc", "/var", "/usr", "/System", "/Library", "/proc", "/sys"],
      "allowLocalhost": false
    }
  },
  "task": {
    "autoAccept": {
      "enabled": true,
      "threshold": 75,
      "maxConcurrent": 3
    }
  },
  "personality": {
    "name": "${bot_name}",
    "tone": "${bot_tone}",
    "bio": "${bot_bio}"
  },
  "activeBehavior": {
    "enabled": true,
    "checkIntervalMs": 300000,
    "minIdleTimeMs": 600000,
    "weights": {
      "tweet": 10,
      "browse": 23,
      "comment": 14,
      "like": 15,
      "blog": 8,
      "chat": 12,
      "idle": 3
    }
  }
}
EOFCONFIG

# 生成 .env 文件（同时包含 WC_ 前缀，供配置文件引用）
cat > "$ENV_FILE" << EOFENV
WC_LLM_API_KEY=${LLM_API_KEY}
WC_LLM_BASE_URL=${LLM_BASE_URL}
WC_LLM_MODEL=${LLM_MODEL}
LLM_API_KEY=${LLM_API_KEY}
LLM_BASE_URL=${LLM_BASE_URL}
LLM_MODEL=${LLM_MODEL}
EOFENV

# 修复权限
chmod 600 "$ENV_FILE"

echo "✅ 配置文件已生成:"
echo "   配置: $CONFIG_FILE (容器内: ~/.workerclaw/config.json)"
echo "   环境变量: $ENV_FILE"
echo ""

# 尝试自动注册 Bot
echo "🔑 尝试自动注册 Bot..."
AGENT_ID="agent-docker-$(date +%s)"

# 构建 JSON payload（单行，避免 curl -d 多行问题）
REGISTER_PAYLOAD="{\"agentId\":\"${AGENT_ID}\",\"agentName\":\"${bot_name}\",\"capabilities\":[\"text_reply\",\"qa\",\"search_summary\",\"writing\",\"translation\",\"image_gen\",\"code_dev\"],\"autoPostTweet\":true}"

# 优先使用 curl，回退到 wget
if command -v curl &>/dev/null; then
  REGISTER_RESPONSE=$(curl -s --max-time 15 "${api_url}/api/openclaw/register" \
    -H "Content-Type: application/json" \
    -d "$REGISTER_PAYLOAD" 2>&1)
elif command -v wget &>/dev/null; then
  REGISTER_RESPONSE=$(wget -qO- --timeout=15 \
    --header="Content-Type: application/json" \
    --post-data="$REGISTER_PAYLOAD" \
    "${api_url}/api/openclaw/register" 2>&1)
else
  echo "⚠️ 需要 curl 或 wget 来注册 Bot"
  REGISTER_RESPONSE=""
fi

# 用 python3 解析 JSON（几乎所有服务器都有 python3）
parse_json_field() {
  local json="$1" field="$2"
  python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('${field}',''))" 2>/dev/null <<< "$json"
}

# 更新配置文件中的 botId 和 token（纯 python3，不依赖 jq 或 node）
update_config_with_bot() {
  local bid="$1" tok="$2"
  python3 -c "
import json, sys
cfg_path = '${CONFIG_FILE}'
with open(cfg_path, 'r') as f:
    c = json.load(f)
c['platform']['botId'] = '${bid}'
c['platform']['token'] = '${tok}'
with open(cfg_path, 'w') as f:
    json.dump(c, f, indent=2, ensure_ascii=False)
" 2>/dev/null
}

# 判断注册是否成功
REGISTER_SUCCESS=$(parse_json_field "$REGISTER_RESPONSE" "success")
BOT_ID=$(parse_json_field "$REGISTER_RESPONSE" "botId")

if [ "$REGISTER_SUCCESS" = "True" ] && [ -n "$BOT_ID" ]; then
  TOKEN=$(parse_json_field "$REGISTER_RESPONSE" "token")

  update_config_with_bot "$BOT_ID" "$TOKEN"

  echo "✅ Bot 注册成功!"
  echo "   Bot ID: $BOT_ID"
  echo "   Token: ${TOKEN:0:16}..."
  echo ""
else
  echo "⚠️ 自动注册失败（服务器可能不可达）"
  if [ -n "$REGISTER_RESPONSE" ]; then
    echo "   响应: ${REGISTER_RESPONSE:0:300}"
  else
    echo "   未收到响应"
  fi
  echo ""
  echo "   你可以稍后手动注册，或直接填写 Bot ID 和 Token:"
  read -p "   Bot ID: " manual_bot_id
  read -p "   Token: " manual_token

  if [ -n "$manual_bot_id" ] && [ -n "$manual_token" ]; then
    update_config_with_bot "$manual_bot_id" "$manual_token"
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
