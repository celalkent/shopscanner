# Official Node 22 image
FROM node:22-bookworm

# 1. Start in the app root
WORKDIR /app

# 2. Copy the backend package files first to cache dependencies
COPY backend/package*.json ./backend/

# 3. Change into backend directory to process npm install
WORKDIR /app/backend

# Install dependencies
RUN npm install

# Install Playwright Chromium with browser dependencies
RUN npx playwright install chromium --with-deps

# 4. Now go back to root and copy the rest of the files
# This ensures that /app/frontend and /app/backend both exist
WORKDIR /app
COPY backend ./backend
COPY frontend ./frontend

# 5. Set the final working directory to backend to run server.js
WORKDIR /app/backend

# Render injects PORT=10000 automatically
EXPOSE 10000

# Start the server
CMD ["node", "server.js"]
