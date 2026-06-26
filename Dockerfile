# Zalo → Facebook autopost — image cho Coolify / VPS
FROM node:20-bookworm-slim

# ffmpeg+ffprobe: xử lý/trích khung video. ca-certificates: gọi Graph API qua HTTPS.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Cài deps trước (tận dụng cache; sharp tải binary ở bước này)
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

# Mã nguồn (data/, output/, .env, creds... bị loại bởi .dockerignore)
COPY . .

ENV NODE_ENV=production \
    DATA_DIR=/app/data \
    ROUTES_FILE=/app/data/routes.json \
    WEB_PORT=8088

# Mọi dữ liệu ghi-runtime nằm dưới /app/data -> mount volume bền vào đây trên Coolify
VOLUME ["/app/data"]
EXPOSE 8088

CMD ["node", "src/service.mjs"]
