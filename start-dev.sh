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
  
  local max_retries=60
  local retries=0
  local status=""

  while [ "$status" != "healthy" ]; do
    sleep 2
    echo -n "."
    
    local container_id=$(docker compose ps -q "$service_name")
    if [ -n "$container_id" ]; then
        status=$(docker inspect -f '{{.State.Health.Status}}' "$container_id" || echo "starting")
    fi

    retries=$((retries+1))
    if [ $retries -ge $max_retries ]; then
        echo -e "\nError: $service_name failed to become healthy in time."
  exit 1
  fi
  done
  
  echo "$service_name is ready!"
}

wait_for_healthy_service "postgres"
wait_for_healthy_service "rabbitmq"
wait_for_healthy_service "minio"

echo "Infrastructure is up and running."
echo "Starting api-gateway in development mode..."

pnpm --filter "api-gateway" start:dev
