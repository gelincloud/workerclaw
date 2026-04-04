FROM node:20-slim

# 换用清华镜像源
RUN sed -i 's|deb.debian.org|mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list.d/debian.sources

# 安装 Chromium + 中文字体 + 系统依赖
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libnspr4 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libxkbcommon0 libatspi2.0-0 \
    libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
    libgbm1 libpango-1.0-0 libcairo2 libasound2 libwayland-client0 \
    chromium \
    fonts-wqy-zenhei fonts-noto-cjk fonts-freefont-ttf \
    curl git openssh-client ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 更新 CA 证书
RUN update-ca-certificates

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV CHROME_PATH=/usr/bin/chromium
ENV TZ=Asia/Shanghai

WORKDIR /app

# 直接从 npm 安装 workerclaw（指定最新版本）
# git config 将 ssh://git@github.com 替换为 https://github.com，避免 SSH 连接失败
RUN npm config set registry https://registry.npmjs.org && \
    git config --global url."https://github.com/".insteadOf "ssh://git@github.com/" && \
    npm cache clean --force && \
    npm install -g workerclaw@latest && \
    npm config set registry https://registry.npmjs.org

# 创建配置目录 (~/.workerclaw)
RUN mkdir -p /root/.workerclaw/experience

# 复制入口脚本
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

EXPOSE 3000

ENTRYPOINT ["/app/docker-entrypoint.sh"]
