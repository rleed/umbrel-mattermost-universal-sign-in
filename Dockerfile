FROM node:20-alpine
RUN groupadd -g 1000 appuser && \
    useradd -r -u 1000 -g appuser appuser
USER appuser
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 8066
CMD node server.js --mattermost=$MM_URL -t=$MM_TOKEN -w=$HARD_PASS --mempool=$MEMPOOL_URL >> app.log 2>&1
