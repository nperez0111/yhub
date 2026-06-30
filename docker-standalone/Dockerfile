FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && \
    apt-get install -y curl && \
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y nodejs postgresql-16 valkey-server && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install --omit=dev
COPY src/ ./src/
COPY bin/ ./bin/
COPY docker-standalone/entrypoint.sh ./entrypoint.sh

# Pass CORS_ORIGIN at `docker run` time to allow cross-origin browser access (see
# .env.template). It stays unset here: while unset, cross-origin access is closed.
ARG BUILD_SHA=""
ENV BUILD_SHA=${BUILD_SHA} \
    REDIS=redis://localhost:6379 \
    REDIS_PREFIX=yhub \
    POSTGRES=postgres://yhub:yhub@localhost:5432/yhub \
    PORT=4400

VOLUME /data
EXPOSE 4400

ENTRYPOINT ["./entrypoint.sh"]
