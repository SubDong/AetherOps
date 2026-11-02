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

# 4. 安装 pnpm（10，与 .github/workflows 和 .cnb.yml 对齐）
#    镜像里必须用同一个大版本：pnpm 9 不认 pnpm-workspace.yaml 里的 allowBuilds /
#    patchedDependencies（只能回落到 package.json 的 pnpm 字段），而 --frozen-lockfile
#    一旦判锁文件与声明不一致就直接失败，版本不对齐会让同一个仓库在 CI 绿、在 Docker 红
#    实测：pnpm 12 写的锁（patchedDependencies 是单行 hash）会被 pnpm 10 + frozen 判为
#    ERR_PNPM_LOCKFILE_CONFIG_MISMATCH，所以仓库里的锁统一由 pnpm 10 生成
RUN npm install -g pnpm@10 --registry=https://registry.npmmirror.com

# 5. 复制依赖文件
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches

# 6. 安装依赖 (frozen-lockfile：pnpm-lock.yaml 是唯一事实，声明与锁不一致就构建失败，
#    不允许安装器悄悄重解析依赖 —— @cicctencent/agent-core 是黑盒引擎，版本变了行为就可能变，
#    镜像必须能对得上号。升级版本走 pnpm run upgrade-pin，改完把 package.json 和 lock 一起提交)
#    放行原生模块的编译脚本仍需 approve-builds
RUN pnpm install --frozen-lockfile
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

# 生产环境只需要 pnpm（版本跟构建阶段一致，否则同一个 lock 可能被另个大版本判为不合）
RUN npm install -g pnpm@10 --registry=https://registry.npmmirror.com

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