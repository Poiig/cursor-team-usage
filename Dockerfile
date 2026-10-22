# 名册与密钥走 volume，不进镜像层。
# 插件按 extension/package.json 的版本号打包，不注入 git sha。
FROM node:20-alpine AS extension-build

WORKDIR /app

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
