#!/bin/sh
# Stop the stack, keep the data. Thin alias for ./run.sh stop.
exec "$(dirname "$0")/run.sh" stop
