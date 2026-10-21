FROM node:20-alpine AS builder

WORKDIR /app

# Зависимости и сборка фронтенда
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# Зависимости бэкенда
WORKDIR /app/server
RUN npm ci

# Финальный легковесный образ
FROM node:20-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production

# Копируем собранный статический фронтенд в /app/dist
COPY --from=builder /app/dist /app/dist

# Копируем директорию сервера
COPY --from=builder /app/server /app/server

WORKDIR /app/server

# Создаем директорию для пользовательских загрузок
RUN mkdir -p /app/server/uploads

EXPOSE 3001

CMD ["npm", "start"]
