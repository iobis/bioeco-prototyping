# Dev image: node_modules in image; only source mounted at run time for reliable watch
FROM node:20-bookworm

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# At run time, docker-compose mounts over src/, index.html, vite.config.ts, etc.

EXPOSE 5173
CMD ["npm", "run", "dev"]
