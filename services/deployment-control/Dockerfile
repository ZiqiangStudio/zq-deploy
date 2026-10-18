FROM node:22-alpine

WORKDIR /app
COPY server.mjs .
RUN mkdir -p /data && chown -R node:node /app /data

USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
