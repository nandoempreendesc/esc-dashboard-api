FROM php:8.2-cli
WORKDIR /app
COPY . .
CMD php -S 0.0.0.0:${PORT:-10000} -t /app
