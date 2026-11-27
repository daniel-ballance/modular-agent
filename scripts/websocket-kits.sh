#!/usr/bin/env bash
# The plugin and ACP kits in --connect mode against one language's own WebSocket servers:
# its conformance plugin served with --listen (with each Runtime tier as a separate service),
# its named-caller fixture (one listener, several tokens; ADR 0035),
# and `ma --acp --listen` with two actors and a shared history service.
#
#   scripts/websocket-kits.sh rust|typescript [--portable-core]
#
# Needs that language built as scripts/check.sh builds it, and npm ci in conformance/acp.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
language="${1:?usage: websocket-kits.sh rust|typescript [--portable-core]}"
group=websocket-retries
case "${2:-}" in
  "") ;;
  --portable-core) group=core ;;
  *) echo "unknown option: $2" >&2; exit 2 ;;
esac
case "$language" in
  rust) plugin=("$repo/rust/target/debug/modular-agent" --serve-plugin)
    named=("$repo/rust/target/debug/examples/named_callers") ;;
  typescript) plugin=(node "$repo/typescript/packages/plugin-wire/dist/src/serve-cli.js")
    named=("$(command -v node)" "$repo/typescript/scripts/named-callers.mjs") ;;
  *) echo "unknown language: $language" >&2; exit 2 ;;
esac
ma=()
while IFS= read -r arg; do ma+=("$arg"); done < <(node -e '
  const [repo, language] = process.argv.slice(1);
  for (const arg of require(`${repo}/conformance/reference/agents/${language}.json`).command)
    console.log(arg.replaceAll("{repo}", repo));
' "$repo" "$language")
source "$repo/scripts/kit-history.sh"

export TMPDIR="${TMPDIR:-$HOME/.cache/ma-std-tmp}"
mkdir -p "$TMPDIR"
work="$(mktemp -d "$TMPDIR/ws-kits-XXXXXX")"
work="$(cd "$work" && pwd -P)"
pids=()
cleanup() { [ ${#pids[@]} -gt 0 ] && kill "${pids[@]}" 2>/dev/null; wait 2>/dev/null; rm -rf "$work"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
umask 077
export TMPDIR="$work"
openssl rand -hex 32 >"$work/token"

# Start one plugin service on a free port; print its URL once it accepts connections.
service() { # parts (or ""), name, token file, optional project and state directories
  local out="$work/$2.url" log="$work/$2.log"
  local -a settings=()
  if [ -n "$1" ]; then settings+=("MODULAR_AGENT_PLUGIN_PARTS=$1"); fi
  if [ -n "${4:-}" ]; then
    settings+=("MODULAR_AGENT_PLUGIN_PROJECT=$4" "MODULAR_AGENT_PLUGIN_STATE_DIR=$5")
  fi
  local home="$work/$2-home"
  mkdir "$home"
  (
    cd "$home"
    exec env -u MODULAR_AGENT_PLUGIN_PARTS -u MODULAR_AGENT_PLUGIN_PROJECT -u MODULAR_AGENT_PLUGIN_STATE_DIR \
      HOME="$home" XDG_CONFIG_HOME="$home" XDG_DATA_HOME="$home" XDG_STATE_HOME="$home" XDG_CACHE_HOME="$home" \
      "${settings[@]}" "${plugin[@]}" --listen 127.0.0.1:0 --token-file "$3"
  ) >"$out" 2>"$log" &
  local pid=$!
  pids+=("$pid")
  for _ in $(seq 300); do
    [ -s "$out" ] && break
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.1
  done
  [ -s "$out" ] || { echo "the $2 service did not report its URL" >&2; cat "$log" >&2; exit 1; }
  read -r service_url <"$out"
}
binding_kits() {
  service "" full "$work/token"; full=$service_url
  service runtime runtime "$work/token"; runtime=$service_url
  service durable-runtime durable "$work/token"; durable=$service_url

  (cd "$repo/conformance/plugin" && node run.mjs --connect "$full" --token-file "$work/token" \
    --runtime-url "$runtime" --durable-runtime-url "$durable")

  (umask 077 && openssl rand -hex 32 >"$work/second-token")
  mkdir -m 700 "$work"/{project-a,project-b,state-a,state-b,fixture-home}
  service "" a "$work/token" "$work/project-a" "$work/state-a"; first=$service_url
  service "" b "$work/second-token" "$work/project-b" "$work/state-b"; second=$service_url
  (cd "$repo/conformance/plugin" && node run.mjs --connect "$first" --token-file "$work/token" \
    --second-connect "$second" --isolation-checks "$work/second-token" \
    "$work/project-a" "$work/project-b" "$work/fixture-home")

  (cd "$repo/conformance/plugin" && node run.mjs --named-callers -- "${named[@]}")

  printf '\n=== %s: ACP WebSocket core ===\n' "$language"
  printf -v service_command '%q ' "${ma[@]}" --acp --approval off
  (cd "$repo/conformance/acp" && node run.mjs --group core --crash-checks --probe-checks --job-checks \
    --connect "ws://127.0.0.1:$(free_port)/" --token-file "$work/token" \
    --service-command "exec $service_command --listen \"\$MODULAR_AGENT_CONFORMANCE_URL\" --token-file \"\$MODULAR_AGENT_CONFORMANCE_TOKEN_FILE\"") || core_status=$?

}

core_status=0
if [ "$group" = websocket-retries ]; then
  binding_kits
fi
printf '\n=== %s: ACP WebSocket %s with two credentials ===\n' "$language" "$group"
history_service "$language" "$work/history"
openssl rand -hex 32 >"$work/acp-writer-token"
openssl rand -hex 32 >"$work/acp-peer-token"
actor=kit-portable-writer
node -e '
  const [id, group] = process.argv.slice(1);
  const rights = group === "core"
    ? ["watch", "propose", "input", "answer", "approve", "tools", "cancel", "settings", "erase", "grant", "jobs", "delegate", "administer"]
    : ["watch", "input", "settings", "grant"];
  console.log(JSON.stringify({ actors: [
    { tokenFile: "acp-writer-token", actor: { id, kind: "user", rights } },
    { tokenFile: "acp-peer-token", actor: { id: "kit-portable-reopener", kind: "user", rights: ["watch", "input"] } },
  ] }));
' "$actor" "$group" >"$work/acp-policy.json"
printf -v service_command '%q ' "${ma[@]}" --acp --approval off --policy "$work/acp-policy.json"
(cd "$repo/conformance/acp" && MODULAR_AGENT_HISTORY_URL="$history_url" MODULAR_AGENT_HISTORY_TOKEN_FILE="$work/history/token" \
  node run.mjs --group "$group" --portable-checks \
  --connect "ws://127.0.0.1:$(free_port)/" --token-file "$work/acp-writer-token" \
  --actor "$actor" --other-token-file "$work/acp-peer-token" \
  --service-command "exec $service_command --listen \"\$MODULAR_AGENT_CONFORMANCE_URL\"")
exit "$core_status"
