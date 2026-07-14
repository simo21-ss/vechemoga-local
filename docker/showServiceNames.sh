#!/bin/sh
# List every service in the stack.
docker compose -f "$(dirname "$0")/docker-compose.yml" config --services
