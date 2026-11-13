FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN mkdir -p /data/uploads && chown -R node:node /data
ENV UPLOAD_DIR=/data/uploads
EXPOSE 3000
CMD ["sh", "docker-entrypoint.sh"]
