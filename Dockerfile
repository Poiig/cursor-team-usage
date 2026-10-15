# 名册与密钥走 volume，不进镜像层。
# 构建阶段打好 Reporter 基座 VSIX（含构建号）；运行时再按 ACCESS_KEY 注入。
FROM node:20-alpine AS extension-build

WORKDIR /app

ARG BUILD_NUMBER=local
ENV BUILD_NUMBER=$BUILD_NUMBER

COPY scripts ./scripts
COPY extension ./extension

WORKDIR /app/extension
RUN npm ci

WORKDIR /app
RUN node scripts/build-extension-asset.mjs \
  && test -f assets/reporter-base.vsix

# --- runtime ---
FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache python3 \
  && ln -sf python3 /usr/bin/python

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY --from=extension-build /app/assets ./assets

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3780

EXPOSE 3780

VOLUME ["/app/data"]

CMD ["node", "src/server.js"]
