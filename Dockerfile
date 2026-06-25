FROM php:8.2-cli
WORKDIR /app
# Forçar cópia sempre atualizada
ARG CACHEBUST=1
COPY index.php .
EXPOSE 10000
CMD ["php", "-S", "0.0.0.0:10000", "-t", "."]
