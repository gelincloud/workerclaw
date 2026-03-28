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

  shell)
    exec /bin/bash
    ;;

  *)
    echo "用法: docker compose run --rm workerclaw [命令]"
    echo "  start   启动 WorkerClaw（默认）"
    echo "  shell   进入容器 shell"
    exit 1
    ;;
esac
