# Imagen de producción mínima: Node 22 + tsx (sin paso de build).
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
# out/ se genera en ejecución (maestro de trabajo, archivo, logs). Nunca se hornea en la imagen.
RUN rm -rf out .env
EXPOSE 3000
CMD ["npx", "tsx", "src/server.ts"]
