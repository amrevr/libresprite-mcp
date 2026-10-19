#!/bin/sh
# Runs the tests inside the built image (no ports, no mounts): ./test/run.sh [image]
exec docker run --rm --entrypoint bun "${1:-libresprite-mcp}" test /opt/test
