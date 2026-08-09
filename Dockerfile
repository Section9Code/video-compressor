# --- build the frontend assets -------------------------------------------------
FROM node:24-slim AS assets
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY src ./src
COPY public ./public
RUN npm run build

# --- runtime -------------------------------------------------------------------
FROM node:24-slim

# intel-media-va-driver-non-free lives in Debian's non-free component, which the
# base image does not enable. The codename is read from the image so this keeps
# working across base image bumps.
RUN . /etc/os-release && \
    echo "deb [signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] http://deb.debian.org/debian ${VERSION_CODENAME} non-free non-free-firmware" \
      > /etc/apt/sources.list.d/nonfree.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg intel-media-va-driver-non-free vainfo && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY *.js ./
COPY public ./public
COPY --from=assets /app/public/app.css /app/public/alpine.js ./public/

# The named volume inherits this ownership, so the non-root user can write the db.
RUN mkdir -p /data /media && chown -R node:node /data /media
USER node

ENV MEDIA_ROOT=/media DB_PATH=/data/queue.db PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
