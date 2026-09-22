FROM node:20-slim

# Install Python and dependencies required for scraper
RUN apt-get update && \
    apt-get install -y python3 python3-pip --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Node dependencies
COPY backend/package*.json ./backend/
RUN cd backend && npm ci --omit=dev

# Install Python dependencies
COPY scraper/requirements.txt ./scraper/
RUN pip3 install --no-cache-dir --break-system-packages -r scraper/requirements.txt

# Copy application source
COPY backend ./backend
COPY scraper ./scraper

WORKDIR /app/backend
ENV NODE_ENV=production
CMD ["node", "src/server.js"]
