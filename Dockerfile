FROM node:18-bullseye

WORKDIR /app

# copia package.json + lock para aproveitar cache
COPY package*.json ./

# instala todas as dependências (dev + prod) necessárias para build
# usando npm ci garante reprodutibilidade
RUN npm ci

# instala libs do sistema necessárias para Chromium
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates fonts-liberation \
    libasound2 libatk1.0-0 libc6 libcairo2 libcups2 \
    libdbus-1-3 libexpat1 libfontconfig1 libgcc1 \
    libgconf-2-4 libgdk-pixbuf2.0-0 libglib2.0-0 \
    libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 \
    libx11-6 libx11-xcb1 libxcb1 libxcomposite1 \
    libxcursor1 libxdamage1 libxext6 libxfixes3 \
    libxi6 libxrandr2 libxrender1 libxss1 libxtst6 \
    libdrm2 libgbm1 \
    xdg-utils wget \
    && rm -rf /var/lib/apt/lists/*

# copia todo o código
COPY . .

# compila o TypeScript (necessário ter typescript em devDependencies)
RUN npm run build

# remove devDependencies para deixar a imagem menor
RUN npm prune --production

ENV NODE_ENV=production

# start em produção (assumindo que "start" executa node build/index.js)
CMD ["npm", "start"]
