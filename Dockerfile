FROM node:22-slim

WORKDIR /app

# Install dependencies and build production frontend
COPY package.json ./
RUN npm install --no-audit --no-fund

COPY . .
RUN npm run build && npm prune --omit=dev

# Hugging Face Spaces runs containers as non-root UID 1000
RUN mkdir -p /app/storage/rooms && chown -R 1000:1000 /app
USER 1000

ENV NODE_ENV=production
ENV PORT=7860

EXPOSE 7860

CMD ["npm", "start"]
