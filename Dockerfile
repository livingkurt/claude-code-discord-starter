FROM node:22-bookworm-slim

# Core system deps: tmux for session management, openssh-client for SSH from crons
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates tmux git openssh-client \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI globally
RUN npm install -g @anthropic-ai/claude-code

# Create dirs for the 'node' user (uid 1000) and set ownership
RUN mkdir -p /home/node/.claude /workspace /config && \
    chown -R node:node /home/node /workspace

WORKDIR /workspace
USER node
ENV HOME=/home/node

# start.sh and restart-loop.sh are volume-mounted at runtime (see docker-compose.yml)
# so you can edit them without rebuilding the image
COPY --chown=node:node start.sh /start.sh
COPY --chown=node:node restart-loop.sh /restart-loop.sh
RUN chmod +x /start.sh /restart-loop.sh

CMD ["/start.sh"]
