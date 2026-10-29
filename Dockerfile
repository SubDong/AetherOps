# ============================================
# 构建阶段
# ============================================
FROM node:22-slim AS build-stage

WORKDIR /app

# 1. 更换 Debian 软件源为阿里云，解决 403 和网络超时问题
RUN sed -i 's@deb.debian.org@mirrors.aliyun.com@g' /etc/apt/sources.list.d/debian.sources

# 2. 安装编译工具 (加入 --fix-missing 防止个别包下载失败)
RUN apt-get update && apt-get install -y --fix-missing python3 make g++ && rm -rf /var/lib/apt/lists/*

# 3. 设置 Electron 的国内镜像源，解决下载中断问题
ENV ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
ENV ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/

# 4. 安装 pnpm 并指定 v9 版本
RUN npm install -g pnpm@9 --registry=https://registry.npmmirror.com

# 5. 复制依赖文件
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches

# 6. 安装依赖 (去掉严格锁校验，并放行原生模块的编译脚本)
RUN pnpm install --no-frozen-lockfile
RUN pnpm approve-builds || true

# 7. 复制源码并构建
COPY . .
RUN pnpm run build

# ============================================
# 生产阶段 (运行环境)
# ============================================
FROM node:22-slim AS production-stage

WORKDIR /app

# 设置生产环境变量和时区，强制监听 0.0.0.0 以便外部访问
ENV NODE_ENV=production
ENV TZ=Asia/Shanghai
ENV HOST=0.0.0.0

# 生产环境只需要 pnpm
RUN npm install -g pnpm@9 --registry=https://registry.npmmirror.com

# 从构建阶段复制产物 (去掉了不存在的 view 目录)
COPY --from=build-stage /app/dist ./dist
COPY --from=build-stage /app/node_modules ./node_modules
COPY --from=build-stage /app/package.json ./package.json
COPY --from=build-stage /app/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=build-stage /app/patches ./patches
COPY --from=build-stage /app/server.js ./server.js
COPY --from=build-stage /app/bin ./bin
COPY --from=build-stage /app/public ./public
# 内置技能：SkillService 从 process.cwd()/data/skills 读取（容器内 cwd = /app），
# 不拷进来会导致镜像里的技能列表为空，只剩用户自己写在数据目录下的技能
COPY --from=build-stage /app/data/skills ./data/skills

# 数据默认落在 $HOME/.aetherops（本镜像即 /root/.aetherops，含 config.json、连接配置、
# 加密密钥、审计日志）。声明 VOLUME 后，即使忘记 -v，数据也进命名卷而不是容器可写层，
# 不会因容器重建被静默丢弃。若用 AETHEROPS_DATA_DIR 改了路径，就要改成挂那个路径。
VOLUME ["/root/.aetherops"]

# 暴露端口
EXPOSE 9802

# 启动命令
CMD ["node", "server.js"]