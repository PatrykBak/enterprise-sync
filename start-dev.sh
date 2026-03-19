#!/bin/bash
set -e

echo "Starting Docker infrastructure..."

# Copy default .env if it doesn't exist
if [ ! -f .env ]; then
    echo ".env file not found. Copying from .env.example..."
    cp .env.example .env
fi

docker compose up -d

wait_for_healthy_service() {
  local service_name=$1
  echo "Waiting for $service_name to be healthy..."
  
  local container_id=$(docker compose ps -q $service_name)
  
  status=$(docker inspect --format "{{json .State.Health.Status }}" $container_id)
  while [ "$status" != "\"healthy\"" ]; do
    if [ "$status" == "\"unhealthy\"" ]; then
      echo "Error: $service_name is unhealthy!"
      exit 1
    fi
    sleep 2
    echo -n "."
    status=$(docker inspect --format "{{json .State.Health.Status }}" $container_id)
  done
  
  echo "$service_name is ready!"
}

wait_for_healthy_service "postgres"
wait_for_healthy_service "rabbitmq"
wait_for_healthy_service "minio"

echo "Infrastructure is up and running."
echo "Starting api-gateway in development mode..."

pnpm --filter "api-gateway" start:dev
