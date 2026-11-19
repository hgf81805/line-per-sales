#!/bin/zsh
cd -- "$(dirname -- "$0")"
for py in /opt/homebrew/bin/python3.13 /opt/homebrew/bin/python3 /usr/local/bin/python3 python3; do
  if "$py" -c 'import sys; sys.exit(sys.version_info < (3,10))' 2>/dev/null; then
    exec "$py" app.py
  fi
done
echo "Python 3.10以降が必要です。"
read "?Enterで閉じます"
