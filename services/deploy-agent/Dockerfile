FROM node:22-alpine

RUN apk add --no-cache bash docker-cli
WORKDIR /app
COPY agent.mjs .
CMD ["node", "agent.mjs"]
