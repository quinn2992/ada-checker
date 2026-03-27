# Use official Playwright image — has Chromium + all system deps pre-installed
FROM mcr.microsoft.com/playwright:v1.44.0-jammy

WORKDIR /app

# Install dependencies (skip playwright browser download — already in base image)
COPY package*.json ./
RUN npm ci --omit=dev && npx playwright install chromium

# Copy application source
COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
