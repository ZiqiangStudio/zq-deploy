FROM node:24-alpine

RUN apk add --no-cache bash docker-cli docker-cli-compose jq
WORKDIR /app
COPY agent.mjs .
CMD ["node", "agent.mjs"]
