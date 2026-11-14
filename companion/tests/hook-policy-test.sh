#!/usr/bin/env bash
# Hook-level tests for the handoff-auto creation policy (Claude Code side).
set -u
HOOK="$(cd "$(dirname "$0")/.." && pwd)/claude-hook.cjs"
CFG=/tmp/handoff-cc-config.json
cat > "$CFG" <<'JSON'
{ "autoTakeover": true, "writeOnExit": true,
  "claude": { "model": false, "optInNotice": true, "takeoverConfirm": true, "takeoverMode": "inject" } }
JSON
export HANDOFF_AUTO_CONFIG="$CFG"

rm -rf /tmp/cc-fresh /tmp/cc-existing
mkdir -p /tmp/cc-fresh /tmp/cc-existing
printf '## pi — 2026-10-01\n\nprior round\n\nCANARY-HANDOFF-BODY-9f3a\n' > /tmp/cc-existing/handoff.md

mk_transcript () { # $1 = path  $2 = start timestamp
  cat > "$1" <<JSONL
{"type":"user","timestamp":"$2","message":{"role":"user","content":"do the thing"}}
{"type":"assistant","timestamp":"$2","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}
JSONL
}
OLD=$(date -u -d '2 hours ago' +%Y-%m-%dT%H:%M:%S.000Z)
mk_transcript /tmp/cc-fresh-transcript.jsonl "$OLD"

echo "=== 1) session-start, fresh workspace (expect the opt-in notice)"
echo "{\"cwd\":\"/tmp/cc-fresh\",\"source\":\"startup\",\"session_id\":\"s1\"}" | node "$HOOK" session-start

echo
echo "=== 2) session-start, workspace with a handoff (expect the takeover context)"
echo "    (takeoverMode=inject here: the default 'verify' mode adds a model-written brief,"
echo "     which is model-dependent; the pointer contract is what this checks)"
CTX=$(echo "{\"cwd\":\"/tmp/cc-existing\",\"source\":\"startup\",\"session_id\":\"s2\"}" | node "$HOOK" session-start)
echo "$CTX" | head -c 400
echo
if echo "$CTX" | grep -q "CANARY-HANDOFF-BODY-9f3a"; then
  echo "    FAIL: the handoff document was inlined into the injected context"
else
  echo "    OK: the document body is not inlined (pointer only)"
fi
if echo "$CTX" | grep -q "/tmp/cc-existing/handoff.md"; then
  echo "    OK: the context points at the file"
else
  echo "    FAIL: the context does not point at the file"
fi

echo
echo "=== 3) session-end, fresh workspace (expect NO handoff.md + a systemMessage)"
echo "{\"cwd\":\"/tmp/cc-fresh\",\"reason\":\"prompt_input_exit\",\"session_id\":\"s1\",\"transcript_path\":\"/tmp/cc-fresh-transcript.jsonl\"}" | node "$HOOK" session-end
echo "handoff.md created? $([ -f /tmp/cc-fresh/handoff.md ] && echo YES-BUG || echo no)"

echo
echo "=== 4) session-end, workspace with an existing handoff (expect a new round appended)"
echo "{\"cwd\":\"/tmp/cc-existing\",\"reason\":\"prompt_input_exit\",\"session_id\":\"s3\",\"transcript_path\":\"/tmp/cc-fresh-transcript.jsonl\"}" | node "$HOOK" session-end
echo "rounds now: $(grep -c '^## ' /tmp/cc-existing/handoff.md)"

echo
echo "=== 5) session-end again in the same session (expect: no second round)"
echo "{\"cwd\":\"/tmp/cc-existing\",\"reason\":\"prompt_input_exit\",\"session_id\":\"s3\",\"transcript_path\":\"/tmp/cc-fresh-transcript.jsonl\"}" | node "$HOOK" session-end
echo "rounds now: $(grep -c '^## ' /tmp/cc-existing/handoff.md)"
