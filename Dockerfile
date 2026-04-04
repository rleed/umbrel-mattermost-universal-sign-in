FROM node:20-alpine
RUN mkdir -p /data && chown -R 1000:1000 /data
USER node
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 8066
CMD node server.js --mattermost $MM_URL -t $MM_TOKEN -w $HARD_PASS --mempool $MEMPOOL_URL >> /data/app.log 2>&1
