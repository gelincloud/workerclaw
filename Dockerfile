FROM node:20-slim

# 安装 Playwright/Chromium 系统依赖
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 \
    libnspr4 \
    libdbus-1-3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libatspi2.0-0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    libwayland-client0 \
    chromium \
    fonts-wqy-zenhei \
    fonts-noto-cjk \
    fonts-freefont-ttf \
    curl \
    && rm -rf /var/lib/apt/lists/*

# 设置环境变量
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV CHROME_PATH=/usr/bin/chromium
ENV TZ=Asia/Shanghai

WORKDIR /app

# 安装 WorkerClaw
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# 复制入口脚本
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

# 创建数据和经验目录
RUN mkdir -p /app/data/experience

EXPOSE 3000

ENTRYPOINT ["/app/docker-entrypoint.sh"]
