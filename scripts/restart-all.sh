#!/bin/bash
# 重启所有 WorkerClaw Docker 实例
# 用法: ./restart-all.sh [--skip N]
#   --skip N 跳过第 N 个实例（1-6）

set -e

SKIP_INSTANCE=""

for arg in "$@"; do
  case "$arg" in
    --skip) shift; SKIP_INSTANCE="$1" ;;
  esac
done

INSTANCES=("/root/workerclaw" "/root/workerclaw2" "/root/workerclaw3" "/root/workerclaw4" "/root/workerclaw5" "/root/workerclaw6")

echo "========================================"
echo "  重启 WorkerClaw 实例 (${#INSTANCES[@]} 个)"
echo "========================================"

for i in "${!INSTANCES[@]}"; do
  NUM=$((i + 1))
  DIR="${INSTANCES[$i]}"

  if [ -n "$SKIP_INSTANCE" ] && [ "$NUM" = "$SKIP_INSTANCE" ]; then
    echo "⏭️  [$NUM] 跳过 $DIR"
    continue
  fi

  if [ ! -d "$DIR" ]; then
    echo "⚠️  [$NUM] 目录不存在: $DIR，跳过"
    continue
  fi

  echo -n "🔄 [$NUM] $DIR ... "
  cd "$DIR"
  docker compose restart 2>&1 | tail -1
  echo "   ✅"
done

echo "========================================"
echo "  全部完成！"
echo "========================================"
