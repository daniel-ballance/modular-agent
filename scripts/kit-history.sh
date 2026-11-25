free_port() {
  node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>console.log(p))})'
}

history_service() { # Language and store directory; sets history_url and tracks the process in pids.
  local history_language="$1" dir="$2" address=127.0.0.1:0 line=""
  local -a service
  mkdir "$dir"
  openssl rand -hex 32 >"$dir/token"
  case "$history_language" in
    rust)
      # The SDK example takes a fixed address and does not print its bound URL.
      address="127.0.0.1:$(free_port)"
      service=(env -u MODULAR_AGENT_KIT_RESTART_PHASE "$repo/rust/target/debug/examples/history_service" "$address" "$dir/token" "$dir/store")
      ;;
    typescript)
      local settings
      settings=$(node -e 'const fs=require("fs"), dir=process.argv[1]; console.log(JSON.stringify({
        dir: `${dir}/store`, token: fs.readFileSync(`${dir}/token`, "utf8").trim(), leaseTtl: 2500,
      }))' "$dir")
      service=(node "$repo/typescript/packages/services/dist/src/serve.js" history "$settings")
      ;;
    go)
      service=("$repo/go/.bin/modular-service" --role history --listen "$address" --token-file "$dir/token" --state "$dir/store" --history-ttl 2500ms)
      ;;
    python)
      service=("$repo/python/.venv/bin/python" -c '
import signal
import sys
from pathlib import Path
from modular_agent import file_history, serve_history

root = Path(sys.argv[1])
listener = serve_history(file_history(root / "store"), address=("127.0.0.1", 0),
                         token_file=root / "token", witness=root / "witness", lease_ttl=2.5)
print(listener.url, flush=True)
signal.pause()
' "$dir")
      ;;
  esac
  HOME="$work" "${service[@]}" >"$dir/url" 2>"$dir/service.log" &
  local pid=$!
  pids+=("$pid")
  for _ in $(seq 300); do
    kill -0 "$pid" 2>/dev/null || break
    if [ "$history_language" = rust ]; then
      if (exec 3<>"/dev/tcp/${address%:*}/${address#*:}") 2>/dev/null; then
        line="http://$address"
        break
      fi
    elif read -r line <"$dir/url"; then
      break
    fi
    sleep 0.1
  done
  if [ -z "$line" ] || ! kill -0 "$pid" 2>/dev/null; then
    echo "the $history_language history service did not start ($dir)" >&2
    tail -n 30 "$dir/service.log" >&2
    return 1
  fi
  case "$line" in
    http://*) history_url="$line" ;;
    *) history_url=$(node -e 'console.log(JSON.parse(process.argv[1]).url)' "$line") ;;
  esac
}
