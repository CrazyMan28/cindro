FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY server/package.json server/package.json
RUN npm install
COPY server server
RUN npm --workspace server run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package-lock.json* ./
COPY --from=build /app/server/package.json server/package.json
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/server/dist server/dist
EXPOSE 8799
CMD ["node", "server/dist/main.js"]
