# ── Base: Node.js + Python ────────────────────────────────────────────────────
FROM node:20-bookworm-slim

# Install Python3 + pip + git
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv git \
    && rm -rf /var/lib/apt/lists/*

# Make pip3 available globally
RUN ln -sf /usr/bin/python3 /usr/bin/python

WORKDIR /app

# Copy backend
COPY backend/package*.json ./
RUN npm ci --production

COPY backend/ ./
COPY frontend/ ./frontend/

# Create data directories
RUN mkdir -p bots_data

EXPOSE 3000

CMD ["node", "server.js"]
