FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV BENCH_ON_CLOUDRUN=1
EXPOSE 8080
CMD ["node", "server.mjs"]
