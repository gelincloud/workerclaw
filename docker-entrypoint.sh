#!/bin/bash
set -e

# WorkerClaw Docker 入口脚本

CONFIG_FILE="${CONFIG_FILE:-/app/data/config.json}"

case "${1:-start}" in
  start)
    echo "🦐 WorkerClaw 启动中..."
    echo "   配置: $CONFIG_FILE"
    echo "   时区: $(date +%Z)"
    echo ""

    # 自动检查并更新 workerclaw
    if [ "${AUTO_UPDATE:-true}" = "true" ]; then
      echo "📦 检查 workerclaw 更新..."
      CURRENT_VERSION=$(workerclaw --version 2>/dev/null | head -1)
      LATEST_VERSION=$(npm view workerclaw version 2>/dev/null)
      if [ "$CURRENT_VERSION" != "$LATEST_VERSION" ] && [ -n "$LATEST_VERSION" ]; then
        echo "⬆️  发现新版本: ${CURRENT_VERSION:-未知} → $LATEST_VERSION"
        npm install -g workerclaw@latest --registry https://registry.npmjs.org
        echo "✅ 已更新到 $LATEST_VERSION"
      else
        echo "✅ 已是最新版本 $CURRENT_VERSION"
      fi
      echo ""
    fi

    # 检查 Chromium
    if command -v chromium &>/dev/null; then
      echo "✅ Chromium: $(chromium --version 2>/dev/null || echo '已安装')"
    else
      echo "⚠️ Chromium 未找到，浏览器功能不可用"
    fi
    echo ""

    # 启动 WorkerClaw（-c 传入配置文件路径）
    exec npx workerclaw start -c "$CONFIG_FILE"
    ;;

  status)
    exec npx workerclaw status -c "$CONFIG_FILE"
    ;;

  skills)
    exec npx workerclaw skills "${@:2}"
    ;;

  experience)
    exec npx workerclaw experience "${@:2}"
    ;;

  configure)
    # 在容器内修改配置（自动传入正确的配置文件路径）
    exec npx workerclaw configure -c "$CONFIG_FILE"
    ;;

  shell)
    exec /bin/bash
    ;;

  *)
    echo "用法: docker compose run --rm workerclaw [命令]"
    echo "  start              启动 WorkerClaw（默认）"
    echo "  status             查看运行状态"
    echo "  skills [list]      查看技能列表"
    echo "  experience [list]  查看经验基因"
    echo "  configure          配置管理（改名字/改模型/改Key/改平台/全部重配）"
    echo "  shell              进入容器 shell"
    echo ""
    echo "或者用 docker exec 在运行中的容器内执行："
    echo "  docker exec workerclaw workerclaw status -c /app/data/config.json"
    echo "  docker exec workerclaw workerclaw skills list"
    echo "  docker exec -it workerclaw workerclaw configure -c /app/data/config.json"
    exit 1
    ;;
esac
