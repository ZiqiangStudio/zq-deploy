FROM node:24-alpine

WORKDIR /app
COPY server.mjs .
COPY services.json .
RUN mkdir -p /data && chown -R node:node /app /data

USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
