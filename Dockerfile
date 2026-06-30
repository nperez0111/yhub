FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && \
    apt-get install -y curl && \
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y nodejs && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install --omit=dev
COPY src/ ./src/
COPY bin/ ./bin/

ARG BUILD_SHA=""
ENV BUILD_SHA=${BUILD_SHA} \
    PORT=4400

EXPOSE 4400

CMD ["node", "./bin/yhub.js"]
