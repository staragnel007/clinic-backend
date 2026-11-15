FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV DATA_DIR=/data TRUST_PROXY=1 NODE_ENV=production
VOLUME /data
EXPOSE 3000
CMD ["node","server.js"]
