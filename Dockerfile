FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache wget ffmpeg python3 py3-pip postgresql16-client
RUN python3 -m venv /venv && /venv/bin/pip install gdown && rm -rf /root/.cache
ENV PATH="/venv/bin:$PATH"
COPY --from=builder /app/node_modules ./node_modules
COPY db ./db
COPY src ./src
COPY views ./views
COPY public ./public
COPY scripts ./scripts
COPY locales ./locales
COPY test ./test
COPY package.json ./
RUN chmod +x scripts/start.sh
RUN mkdir -p /app/media && chmod 777 /app/media
# Media PROTETTI: cartella dedicata, MAI servita da express.static (unico
# accesso: route media-protected con autorizzazione). 700 = solo l'utente
# del processo può leggerla/elencarla.
RUN mkdir -p /app/media-protected && chmod 700 /app/media-protected
EXPOSE 3000
CMD ["sh", "scripts/start.sh"]
