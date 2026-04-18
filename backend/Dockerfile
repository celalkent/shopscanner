# Official Node 22 image
FROM node:22-bookworm

# Install Playwright dependencies manually, as non-root user can't run apt-get via --with-deps easily
# Actually, running as root in Docker build is fine.
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install npm dependencies
RUN npm install

# Install Playwright browsers and Linux dependencies
RUN npx playwright install chromium --with-deps

# Copy all source files
COPY . .

# Start the server
CMD ["node", "server.js"]
