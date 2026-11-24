#!/usr/bin/env bash
# Build the exact worker that this Go client speaks to. Only build time needs network access.
set -euo pipefail
root=$(cd -- "$(dirname -- "$0")/../.." && pwd)
mkdir -p "$root/go/.bin"
bin=$root/go/.bin
source=$bin/monty-v1.6.0-source
revision=3f89dcbf82071896efb5e3ded507db4191e8d829
if [[ ! -d $source ]]; then
  clone=$(mktemp -d "$bin/.monty-source.XXXXXX")
  trap 'rm -rf -- "$clone"' EXIT
  git clone --depth 1 --branch v1.6.0 https://github.com/pydantic/monty.git "$clone"
  [[ $(git -C "$clone" rev-parse HEAD) == "$revision" ]]
  mv -- "$clone" "$source"
fi
if [[ $(git -C "$source" rev-parse HEAD) != "$revision" || -n $(git -C "$source" status --porcelain) ]]; then
  echo "Monty source in $source does not match the clean v1.6.0 revision $revision" >&2
  exit 1
fi
(
  cd "$root/rust"
  CARGO_TARGET_DIR="$bin/monty-target" mise exec -- cargo build --manifest-path "$source/Cargo.toml" --locked --release -p monty-runtime --bin monty
)
# Publish atomically, so an agent starting a run never sees a partial binary.
worker=$(mktemp "$bin/.monty-worker.XXXXXX")
trap 'rm -f -- "$worker"' EXIT
install -m 755 "$bin/monty-target/release/monty" "$worker"
mv -f -- "$worker" "$bin/monty"
