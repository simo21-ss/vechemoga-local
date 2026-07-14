#!/bin/sh
# Remove containers, volumes, and the built local images. Thin alias for ./run.sh clean.
exec "$(dirname "$0")/run.sh" clean
