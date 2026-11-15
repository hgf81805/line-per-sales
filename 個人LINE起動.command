#!/bin/zsh
cd -- "$(dirname -- "$0")"
exec python3 app.py --personal --port 8767
