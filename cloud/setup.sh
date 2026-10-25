#!/bin/sh
# Claude Pet for cloud sessions. `claude-pet cloud setup` prints the line that runs this from
# the cloud environment's setup script. It installs a hook that sends each session's status,
# encrypted, through an ntfy topic to the pet on your computer.
#
#   sh setup.sh <base url of this repository> <topic> <key> [ntfy server]
set -e
BASE="$1"
TOPIC="$2"
KEY="$3"
SERVER="${4:-https://ntfy.sh}"
DIR="$HOME/.claude-pet-cloud"

mkdir -p "$DIR/src/hook" "$DIR/src/shared"
for f in src/hook/cloud-hook.js src/hook/pet-hook.js src/shared/config.js src/shared/seal.js; do
  curl -fsSL "$BASE/$f" -o "$DIR/$f"
done
umask 077
# base: where the hook downloads newer versions of itself from
printf '{"server":"%s","topic":"%s","key":"%s","base":"%s"}\n' "$SERVER" "$TOPIC" "$KEY" "$BASE" > "$DIR/config.json"
node "$DIR/src/hook/cloud-hook.js" --install
