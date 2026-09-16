# 名册与密钥走 volume，不进镜像层。
# SQLite（sql.js）为纯 WASM，无需原生编译工具链。
FROM node:20-alpine

WORKDIR /app

# 本机导入依赖 Python 读 Cursor state.vscdb；容器内一般无 IDE，但脚本保留可用。
RUN apk add --no-cache python3 \
  && ln -sf python3 /usr/bin/python

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public
COPY scripts ./scripts

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3780

EXPOSE 3780

# 名册落在 /app/data，compose 里挂载为 volume。
VOLUME ["/app/data"]

CMD ["node", "src/server.js"]
