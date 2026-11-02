FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY README.md ./README.md

RUN mkdir -p /app/data && chown -R node:node /app
USER node

CMD ["npm", "start"]
