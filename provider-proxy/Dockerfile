# syntax=docker/dockerfile:1
# An image for the provider proxy-mock, so it can be deployed somewhere that can't bind-mount
# this repo's source. The local stack does NOT use this file — docker-compose.yml mounts
# provider-proxy.mjs read-only into a stock node image instead, which needs no build step and
# picks up an edit on restart. This exists for VecheMogaInfra to build and propagate to dev.
#
# There is nothing to install and no build stage: the script is Node built-ins only, which is
# the whole point of the no-dependencies rule (see ../CLAUDE.md).
#
# Build (context is this directory):  docker build -t vechemoga-provider-proxy .

# Base pinned by digest for reproducible rebuilds (node:20-alpine).
# Refresh: docker buildx imagetools inspect node:20-alpine
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293
WORKDIR /app
COPY provider-proxy.mjs ./
# `node` (uid 1000) ships with the image; the proxy needs no write access to anything.
USER node
EXPOSE 1080
# PROXY_UPSTREAM_URL is deliberately NOT set here. Unset means unmatched traffic is stubbed
# and journaled rather than forwarded, so an image that escapes into an environment nobody
# configured cannot mail a real person. Setting it is an opt-in, per-deployment decision.
CMD ["node", "provider-proxy.mjs"]
