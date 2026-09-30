FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git openssh-client tmux curl ca-certificates util-linux \
 && rm -rf /var/lib/apt/lists/*
RUN npm i -g pnpm@11.28.2
