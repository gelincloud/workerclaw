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
  echo "   3) 修改 LLM 配置（主端点 + 多端点管理）"
  echo "   4) 仅修改 LLM API Key"
  echo "   5) 仅修改平台地址"
  echo "   6) 📱 WhatsApp 配置（启用/自动回复/会话）"
  echo "   7) 🏢 企业版配置（模式切换/License/知识/媒体库）"
  echo "   8) 保持现有配置，跳过"
  echo ""
  read -p "   请选择 [8]: " config_choice
  config_choice="${config_choice:-8}"

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
      # ========== LLM 配置管理（主端点 + 多端点） ==========
      echo ""
      # 读取当前配置
      LLM_MODEL_CUR=$(python3 -c "import json; d=json.load(open('$CONFIG_FILE')); print(d.get('llm',{}).get('model','未知'))" 2>/dev/null)
      LLM_BASEURL_CUR=$(python3 -c "import json; d=json.load(open('$CONFIG_FILE')); print(d.get('llm',{}).get('baseUrl','').replace('\${WC_LLM_BASE_URL}',''))" 2>/dev/null)
      ENDPOINTS_COUNT=$(python3 -c "import json; d=json.load(open('$CONFIG_FILE')); eps=d.get('llm',{}).get('endpoints',[]); print(len(eps))" 2>/dev/null)
      
      echo "   ── 当前 LLM 配置 ──"
      echo "   主端点模型: $LLM_MODEL_CUR"
      echo "   端点数量:   $ENDPOINTS_COUNT"
      
      if [ "$ENDPOINTS_COUNT" -gt 0 ] 2>/dev/null; then
        echo ""
        echo "   ── 端点列表 ──"
        python3 -c "
import json
with open('$CONFIG_FILE', 'r') as f:
    c = json.load(f)
eps = c.get('llm', {}).get('endpoints', [])
if not eps:
    print('   （无额外端点）')
else:
    for i, ep in enumerate(eps):
        key = ep.get('apiKey', '')
        masked = key[:8] + '...' if len(key) > 8 else '***'
        print(f'   [{i+1}] {ep.get(\"name\",\"未命名\")} | {ep.get(\"model\",\"?\")} | key={masked} | weight={ep.get(\"weight\",1)}')
" 2>/dev/null
      fi
      echo ""
      echo "   3a) 修改主端点（URL + 模型）"
      echo "   3b) 添加新端点"
      echo "   3c) 删除端点"
      echo "   3d) 清空所有端点（仅保留主端点）"
      echo "   3e) 返回上级"
      read -p "   请选择: " llm_choice
      
      case "$llm_choice" in
        3a)
          echo ""
          # 读取当前 baseUrl（展开环境变量引用）
          if [ -f "$ENV_FILE" ]; then
            source "$ENV_FILE"
          fi
          REAL_BASE_URL=""
          if [ -n "$WC_LLM_BASE_URL" ]; then
            REAL_BASE_URL="$WC_LLM_BASE_URL"
          elif [ -n "$LLM_BASE_URL" ]; then
            REAL_BASE_URL="$LLM_BASE_URL"
          fi
          echo "   当前 Base URL: ${REAL_BASE_URL:-${LLM_BASEURL_CUR}}"
          echo "   当前模型: $LLM_MODEL_CUR"
          read -p "   新的 API Base URL（回车保持不变）: " new_url
          read -p "   新的模型名称（回车保持不变）: " new_model
          
          python3 -c "
import json, os
cfg_path = '$CONFIG_FILE'
with open(cfg_path, 'r') as f:
    c = json.load(f)
new_url = '${new_url}'
new_model = '${new_model}'
if new_url:
    c['llm']['baseUrl'] = '\${WC_LLM_BASE_URL}'
    # 更新 .env
    env_path = '$ENV_FILE'
    with open(env_path, 'r') as f:
        lines = f.readlines()
    with open(env_path, 'w') as f:
        for line in lines:
            if line.startswith('WC_LLM_BASE_URL=') or line.startswith('LLM_BASE_URL='):
                prefix = line.split('=')[0] + '='
                f.write(prefix + new_url + '\n')
            else:
                f.write(line)
if new_model:
    c['llm']['model'] = new_model
with open(cfg_path, 'w') as f:
    json.dump(c, f, indent=2, ensure_ascii=False)
print('✅ 主端点配置已更新')
if new_model:
    print('   模型: ' + new_model)
if new_url:
    print('   URL: ' + new_url)
if not new_url and not new_model:
    print('   （未修改）')
" 2>/dev/null
          ;;
        3b)
          echo ""
          if [ -f "$ENV_FILE" ]; then
            source "$ENV_FILE"
          fi
          REAL_BASE_URL="${WC_LLM_BASE_URL:-${LLM_BASE_URL:-https://integrate.api.nvidia.com/v1}}"
          REAL_MODEL="${WC_LLM_MODEL:-${LLM_MODEL:-$LLM_MODEL_CUR}}"
          
          echo "   ── 添加新端点 ──"
          read -p "   端点名称: " ep_name
          ep_name="${ep_name:-新端点}"
          read -p "   API Base URL [$REAL_BASE_URL]: " ep_url
          ep_url="${ep_url:-$REAL_BASE_URL}"
          read -p "   模型名称 [$REAL_MODEL]: " ep_model
          ep_model="${ep_model:-$REAL_MODEL}"
          read -p "   API Key: " ep_key
          if [ -z "$ep_key" ]; then
            echo "   ❌ API Key 不能为空，已跳过"
          else
            read -p "   权重 [1]: " ep_weight
            ep_weight="${ep_weight:-1}"
            python3 -c "
import json
cfg_path = '$CONFIG_FILE'
with open(cfg_path, 'r') as f:
    c = json.load(f)
if 'endpoints' not in c.get('llm', {}):
    c.setdefault('llm', {})['endpoints'] = []
c['llm']['endpoints'].append({
    'name': '${ep_name}',
    'apiKey': '${ep_key}',
    'baseUrl': '${ep_url}',
    'model': '${ep_model}',
    'weight': ${ep_weight},
    'enabled': True
})
with open(cfg_path, 'w') as f:
    json.dump(c, f, indent=2, ensure_ascii=False)
print('✅ 端点已添加: ${ep_name} (${ep_model})')
print('   当前端点数量: ' + str(len(c['llm']['endpoints'])))
" 2>/dev/null
          fi
          ;;
        3c)
          echo ""
          ENDPOINTS_COUNT=$(python3 -c "import json; d=json.load(open('$CONFIG_FILE')); eps=d.get('llm',{}).get('endpoints',[]); print(len(eps))" 2>/dev/null)
          if [ "$ENDPOINTS_COUNT" -eq 0 ] 2>/dev/null; then
            echo "   当前没有额外端点可删除"
          else
            echo "   ── 删除端点 ──"
            python3 -c "
import json
with open('$CONFIG_FILE', 'r') as f:
    c = json.load(f)
eps = c.get('llm', {}).get('endpoints', [])
if not eps:
    print('   （无额外端点）')
else:
    for i, ep in enumerate(eps):
        key = ep.get('apiKey', '')
        masked = key[:8] + '...' if len(key) > 8 else '***'
        print(f'   [{i+1}] {ep.get(\"name\",\"未命名\")} | {ep.get(\"model\",\"?\")} | key={masked}')
" 2>/dev/null
            read -p "   输入要删除的端点编号: " del_index
            if [ -n "$del_index" ] && [ "$del_index" -gt 0 ] 2>/dev/null; then
              python3 -c "
import json
cfg_path = '$CONFIG_FILE'
with open(cfg_path, 'r') as f:
    c = json.load(f)
eps = c.get('llm', {}).get('endpoints', [])
idx = int('${del_index}') - 1
if 0 <= idx < len(eps):
    removed = eps.pop(idx)
    c['llm']['endpoints'] = eps
    with open(cfg_path, 'w') as f:
        json.dump(c, f, indent=2, ensure_ascii=False)
    print('✅ 已删除端点: ' + removed.get('name', '?'))
    print('   剩余端点数量: ' + str(len(eps)))
else:
    print('❌ 无效的端点编号')
" 2>/dev/null
            else
              echo "   已取消"
            fi
          fi
          ;;
        3d)
          echo ""
          python3 -c "
import json
cfg_path = '$CONFIG_FILE'
with open(cfg_path, 'r') as f:
    c = json.load(f)
old_count = len(c.get('llm', {}).get('endpoints', []))
c.setdefault('llm', {})['endpoints'] = []
with open(cfg_path, 'w') as f:
    json.dump(c, f, indent=2, ensure_ascii=False)
print('✅ 已清空所有额外端点（清除了 ' + str(old_count) + ' 个，仅保留主端点）')
" 2>/dev/null
          ;;
        3e)
          echo "   返回上级"
          ;;
        *)
          echo "   无效选择"
          ;;
      esac
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
      # ========== 企业版配置 ==========
      MODE_CUR=$(python3 -c "import json; d=json.load(open('$CONFIG_FILE')); print(d.get('mode','public'))" 2>/dev/null)
      LIC_STATUS=$(python3 -c "import json; d=json.load(open('$CONFIG_FILE')); e=d.get('enterprise',{}); print('已激活' if e.get('activated') else '未激活')" 2>/dev/null)
      KNOWLEDGE_LEN=$(python3 -c "import json; d=json.load(open('$CONFIG_FILE')); k=d.get('personality',{}).get('customSystemPrompt',''); print(f'{len(k)}字符' if k else '未设置')" 2>/dev/null)
      MEDIA_DIR_CUR=$(python3 -c "import json; d=json.load(open('$CONFIG_FILE')); print(d.get('mediaDir','未设置'))" 2>/dev/null)
      echo ""
      echo "   ── 企业版配置 ──"
      echo "   当前模式: $MODE_CUR"
      echo "   License:  $LIC_STATUS"
      echo "   专属知识: $KNOWLEDGE_LEN"
      echo "   媒体库:   $MEDIA_DIR_CUR"
      echo ""
      echo "   6a) 切换运行模式（公有打工虾 ↔ 私有虾）"
      echo "   6b) 激活企业版 License"
      echo "   6c) 配置专属知识"
      echo "   6d) 配置媒体资料库目录"
      echo "   6e) 返回上级"
      read -p "   请选择: " ent_choice

      case "$ent_choice" in
        6a)
          echo ""
          echo "   当前模式: $MODE_CUR"
          echo "   🌐 公有打工虾：接平台任务，智能活跃，公域社交"
          echo "   🔒 私有虾：专属知识库、媒体资料库，服务特定企业/个人"
          echo ""
          read -p "   新模式 (public/private) [$MODE_CUR]: " new_mode
          new_mode="${new_mode:-$MODE_CUR}"
          if [ "$new_mode" != "public" ] && [ "$new_mode" != "private" ]; then
            echo "   ❌ 无效模式，请输入 public 或 private"
          else
            if [ "$new_mode" = "private" ]; then
              ENT_ACT=$(python3 -c "import json; d=json.load(open('$CONFIG_FILE')); print(d.get('enterprise',{}).get('activated',False))" 2>/dev/null)
              if [ "$ENT_ACT" != "True" ]; then
                echo "   ⚠️  私有虾模式需要企业版 License"
                echo "   📋 购买: https://www.miniabc.top/enterprise.html"
                echo ""
                read -p "   是否现在输入 License Key？[y/N]: " do_activate
                if [ "$do_activate" = "y" ] || [ "$do_activate" = "Y" ]; then
                  read -p "   输入 License Key: " lic_key
                  if [ -n "$lic_key" ]; then
                    API_URL_ENT=$(python3 -c "import json; d=json.load(open('$CONFIG_FILE')); print(d.get('platform',{}).get('apiUrl','https://www.miniabc.top'))" 2>/dev/null)
                    LIC_RESULT=$(curl -s --max-time 15 "${API_URL_ENT}/api/license/verify" \
                      -H "Content-Type: application/json" \
                      -d "{\"licenseKey\":\"${lic_key}\"}" 2>&1)
                    LIC_VALID=$(echo "$LIC_RESULT" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print('1' if d.get('success') and d.get('valid') else '0')" 2>/dev/null)
                    if [ "$LIC_VALID" = "1" ]; then
                      LIC_EXPIRES=$(echo "$LIC_RESULT" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('expiresAt',''))" 2>/dev/null)
                      python3 -c "
import json, datetime
cfg_path = '$CONFIG_FILE'
with open(cfg_path, 'r') as f:
    c = json.load(f)
c.setdefault('enterprise', {})['key'] = '${lic_key}'
c['enterprise']['activated'] = True
c['enterprise']['activatedAt'] = datetime.datetime.now().isoformat()
c['enterprise']['expiresAt'] = '${LIC_EXPIRES}'
c['mode'] = 'private'
with open(cfg_path, 'w') as f:
    json.dump(c, f, indent=2, ensure_ascii=False)
print('✅ License 已激活，已切换到私有虾模式')
" 2>/dev/null
                    else
                      echo "   ❌ License 验证失败: ${LIC_RESULT:0:100}"
                    fi
                  fi
                else
                  echo "   已取消模式切换"
                fi
                echo ""
                echo "   重启容器生效: docker compose restart"
                exit 0
              fi
            fi
            python3 -c "
import json
cfg_path = '$CONFIG_FILE'
with open(cfg_path, 'r') as f:
    c = json.load(f)
c['mode'] = '${new_mode}'
with open(cfg_path, 'w') as f:
    json.dump(c, f, indent=2, ensure_ascii=False)
print('✅ 运行模式已切换为: ${new_mode}')
" 2>/dev/null
          fi
          ;;
        6b)
          echo ""
          echo "   📋 购买企业版 License: https://www.miniabc.top/enterprise.html"
          echo ""
          read -p "   输入 License Key: " lic_key
          if [ -z "$lic_key" ]; then
            echo "   已取消"
          else
            API_URL_ENT=$(python3 -c "import json; d=json.load(open('$CONFIG_FILE')); print(d.get('platform',{}).get('apiUrl','https://www.miniabc.top'))" 2>/dev/null)
            LIC_RESULT=$(curl -s --max-time 15 "${API_URL_ENT}/api/license/verify" \
              -H "Content-Type: application/json" \
              -d "{\"licenseKey\":\"${lic_key}\"}" 2>&1)
            LIC_VALID=$(echo "$LIC_RESULT" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print('1' if d.get('success') and d.get('valid') else '0')" 2>/dev/null)
            if [ "$LIC_VALID" = "1" ]; then
              LIC_EXPIRES=$(echo "$LIC_RESULT" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('expiresAt',''))" 2>/dev/null)
              LIC_PLAN=$(echo "$LIC_RESULT" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('plan',''))" 2>/dev/null)
              python3 -c "
import json, datetime
cfg_path = '$CONFIG_FILE'
with open(cfg_path, 'r') as f:
    c = json.load(f)
c.setdefault('enterprise', {})['key'] = '${lic_key}'
c['enterprise']['activated'] = True
c['enterprise']['activatedAt'] = datetime.datetime.now().isoformat()
c['enterprise']['expiresAt'] = '${LIC_EXPIRES}'
with open(cfg_path, 'w') as f:
    json.dump(c, f, indent=2, ensure_ascii=False)
print('✅ License 已激活')
" 2>/dev/null
              if [ -n "$LIC_EXPIRES" ]; then echo "   📅 到期: $LIC_EXPIRES"; fi
            else
              echo "   ❌ License 验证失败: ${LIC_RESULT:0:100}"
            fi
          fi
          ;;
        6c)
          echo ""
          echo "   专属知识会被注入到系统提示中，作为 ## 附加指引"
          echo "   适合填写：企业介绍、产品信息、客服话术、FAQ 等"
          echo ""
          echo "   输入专属知识内容（输入 END 结束）："
          KNOWLEDGE_INPUT=""
          while IFS= read -r line; do
            [ "$line" = "END" ] && break
            KNOWLEDGE_INPUT="${KNOWLEDGE_INPUT}${line}
"
          done
          if [ -n "$KNOWLEDGE_INPUT" ]; then
            # 使用 python3 正确处理多行文本中的引号
            python3 << 'PYEOF'
import json
cfg_path = '$CONFIG_FILE'
knowledge = """$KNOWLEDGE_INPUT"""
# 正确读取配置
with open(cfg_path, 'r') as f:
    c = json.load(f)
c.setdefault('personality', {})['customSystemPrompt'] = knowledge.rstrip('\n')
with open(cfg_path, 'w') as f:
    json.dump(c, f, indent=2, ensure_ascii=False)
print(f'✅ 专属知识已设置 ({len(knowledge.rstrip())} 字符)')
PYEOF
          else
            echo "   未输入内容"
          fi
          ;;
        6d)
          echo ""
          echo "   媒体资料库用于存放虾可以发送给用户的图片、视频、文档等文件"
          MEDIA_DIR_NEW=$(python3 -c "import json,os; d=json.load(open('$CONFIG_FILE')); print(d.get('mediaDir',os.path.expanduser('~/.workerclaw/media')))" 2>/dev/null)
          read -p "   媒体资料库目录 [$MEDIA_DIR_NEW]: " media_dir_input
          media_dir_input="${media_dir_input:-$MEDIA_DIR_NEW}"
          mkdir -p "$media_dir_input"
          python3 -c "
import json
cfg_path = '$CONFIG_FILE'
with open(cfg_path, 'r') as f:
    c = json.load(f)
c['mediaDir'] = '${media_dir_input}'
with open(cfg_path, 'w') as f:
    json.dump(c, f, indent=2, ensure_ascii=False)
print('✅ 媒体资料库目录已设置为: ${media_dir_input}')
" 2>/dev/null
          ;;
        6e)
          echo "   返回上级"
          ;;
        *)
          echo "   无效选择"
          ;;
      esac
      echo ""
      echo "   重启容器生效: docker compose restart"
      exit 0
      ;;
    6)
      # ========== WhatsApp 配置 ==========
      WA_ENABLED=$(python3 -c "import json; d=json.load(open('$CONFIG_FILE')); print(d.get('whatsapp',{}).get('enabled',False))" 2>/dev/null)
      WA_AUTO_REPLY=$(python3 -c "import json; d=json.load(open('$CONFIG_FILE')); ar=d.get('whatsapp',{}).get('autoReply',{}); print('已启用' if ar.get('enabled',True) else '已禁用')" 2>/dev/null)
      WA_SESSION=$(python3 -c "import json; d=json.load(open('$CONFIG_FILE')); print(d.get('whatsapp',{}).get('sessionPath','./data/whatsapp-session'))" 2>/dev/null)

      echo ""
      echo "   ── WhatsApp 配置 ──"
      echo "   技能状态: $([ "$WA_ENABLED" = "True" ] && echo '✅ 已启用' || echo '❌ 未启用')"
      echo "   自动回复: $WA_AUTO_REPLY"
      echo "   会话路径: $WA_SESSION"
      echo ""
      echo "   6a) 启用/禁用 WhatsApp 技能"
      echo "   6b) 配置自动回复"
      echo "   6c) 配置会话路径"
      echo "   6d) 返回上级"
      read -p "   请选择: " wa_choice

      case "$wa_choice" in
        6a)
          echo ""
          if [ "$WA_ENABLED" = "True" ]; then
            echo "   当前状态: 已启用"
            read -p "   禁用 WhatsApp 技能？[y/N]: " wa_disable
            if [ "$wa_disable" = "y" ] || [ "$wa_disable" = "Y" ]; then
              python3 -c "
import json
cfg_path = '$CONFIG_FILE'
with open(cfg_path, 'r') as f:
    c = json.load(f)
c.setdefault('whatsapp', {})['enabled'] = False
with open(cfg_path, 'w') as f:
    json.dump(c, f, indent=2, ensure_ascii=False)
print('✅ WhatsApp 技能已禁用')
" 2>/dev/null
            fi
          else
            echo "   当前状态: 未启用"
            echo ""
            echo "   📋 使用步骤："
            echo "      1. 启动容器后查看日志，会显示 QR 码"
            echo "      2. 打开手机 WhatsApp: 设置 > 关联设备 > 关联设备"
            echo "      3. 扫描终端中的 QR 码"
            echo "      4. 连接成功后会话会自动保存"
            echo ""
            read -p "   启用 WhatsApp 技能？[Y/n]: " wa_enable
            if [ "$wa_enable" != "n" ] && [ "$wa_enable" != "N" ]; then
              python3 -c "
import json
cfg_path = '$CONFIG_FILE'
with open(cfg_path, 'r') as f:
    c = json.load(f)
c.setdefault('whatsapp', {})['enabled'] = True
with open(cfg_path, 'w') as f:
    json.dump(c, f, indent=2, ensure_ascii=False)
print('✅ WhatsApp 技能已启用')
" 2>/dev/null
            fi
          fi
          ;;
        6b)
          echo ""
          echo "   ── 自动回复配置 ──"
          WA_AR_ENABLED=$(python3 -c "import json; d=json.load(open('$CONFIG_FILE')); ar=d.get('whatsapp',{}).get('autoReply',{}); print('true' if ar.get('enabled',True) else 'false')" 2>/dev/null)

          if [ "$WA_AR_ENABLED" = "true" ]; then
            echo "   当前状态: 已启用"
            read -p "   禁用自动回复？[y/N]: " ar_disable
            if [ "$ar_disable" = "y" ] || [ "$ar_disable" = "Y" ]; then
              python3 -c "
import json
cfg_path = '$CONFIG_FILE'
with open(cfg_path, 'r') as f:
    c = json.load(f)
c.setdefault('whatsapp', {}).setdefault('autoReply', {})['enabled'] = False
with open(cfg_path, 'w') as f:
    json.dump(c, f, indent=2, ensure_ascii=False)
print('✅ 自动回复已禁用')
" 2>/dev/null
            fi
          else
            echo "   当前状态: 已禁用"
            read -p "   启用自动回复？[Y/n]: " ar_enable
            if [ "$ar_enable" != "n" ] && [ "$ar_enable" != "N" ]; then
              python3 -c "
import json
cfg_path = '$CONFIG_FILE'
with open(cfg_path, 'r') as f:
    c = json.load(f)
c.setdefault('whatsapp', {}).setdefault('autoReply', {})['enabled'] = True
with open(cfg_path, 'w') as f:
    json.dump(c, f, indent=2, ensure_ascii=False)
print('✅ 自动回复已启用')
" 2>/dev/null
            fi
          fi

          echo ""
          read -p "   配置自动回复系统提示？[y/N]: " config_prompt
          if [ "$config_prompt" = "y" ] || [ "$config_prompt" = "Y" ]; then
            echo ""
            echo "   系统提示词定义客服人设和回复规则"
            echo "   输入系统提示（输入 END 结束）："
            WA_PROMPT_INPUT=""
            while IFS= read -r line; do
              [ "$line" = "END" ] && break
              WA_PROMPT_INPUT="${WA_PROMPT_INPUT}${line}
"
            done
            if [ -n "$WA_PROMPT_INPUT" ]; then
              python3 << 'PYEOF'
import json
cfg_path = '$CONFIG_FILE'
prompt = """$WA_PROMPT_INPUT"""
with open(cfg_path, 'r') as f:
    c = json.load(f)
c.setdefault('whatsapp', {}).setdefault('autoReply', {})['systemPrompt'] = prompt.rstrip('\n')
with open(cfg_path, 'w') as f:
    json.dump(c, f, indent=2, ensure_ascii=False)
print(f'✅ 系统提示已设置 ({len(prompt.rstrip())} 字符)')
PYEOF
            fi
          fi

          echo ""
          WA_CTX=$(python3 -c "import json; d=json.load(open('$CONFIG_FILE')); print(d.get('whatsapp',{}).get('autoReply',{}).get('maxContextMessages',20))" 2>/dev/null)
          read -p "   上下文消息数量 [$WA_CTX]: " new_ctx
          if [ -n "$new_ctx" ]; then
            python3 -c "
import json
cfg_path = '$CONFIG_FILE'
with open(cfg_path, 'r') as f:
    c = json.load(f)
c.setdefault('whatsapp', {}).setdefault('autoReply', {})['maxContextMessages'] = $new_ctx
with open(cfg_path, 'w') as f:
    json.dump(c, f, indent=2, ensure_ascii=False)
print('✅ 上下文消息数量已设置为: $new_ctx')
" 2>/dev/null
          fi
          ;;
        6c)
          echo ""
          echo "   会话路径存储 WhatsApp 登录凭证"
          echo "   首次扫码后会话会保存，重启无需重新扫码"
          echo ""
          read -p "   新的会话路径 [$WA_SESSION]: " new_session
          new_session="${new_session:-$WA_SESSION}"
          python3 -c "
import json
cfg_path = '$CONFIG_FILE'
with open(cfg_path, 'r') as f:
    c = json.load(f)
c.setdefault('whatsapp', {})['sessionPath'] = '${new_session}'
with open(cfg_path, 'w') as f:
    json.dump(c, f, indent=2, ensure_ascii=False)
print('✅ 会话路径已设置为: ${new_session}')
" 2>/dev/null
          ;;
        6d)
          echo "   返回上级"
          ;;
        *)
          echo "   无效选择"
          ;;
      esac
      echo ""
      echo "   重启容器生效: docker compose restart"
      exit 0
      ;;
    7)
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
