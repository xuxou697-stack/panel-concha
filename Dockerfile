# Panel Concha: no necesita instalar nada mas que Node
FROM node:22-alpine
WORKDIR /app
COPY server.js ./
COPY public ./public
ENV NODE_ENV=production PORT=3080 TZ=Europe/Madrid
# Los datos (clientes, vendedores, ajustes y copias) viven aqui: hay que montarle un volumen
VOLUME /app/data
EXPOSE 3080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- http://127.0.0.1:3080/api/state || exit 1
CMD ["node", "server.js"]
