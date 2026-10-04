#!/usr/bin/env bash
# End-to-end demo of OmniNode with agents that need no external tools.
#
#   ./demo.sh
#
# It exercises: init → config → run (research fan-out → plan → execute)
# → status → plan show → audit. Only Node.js is required.
set -euo pipefail
cd "$(dirname "$0")"

command -v node >/dev/null || { echo "node is required"; exit 1; }
OMNINODE="${OMNINODE:-npx --yes @hilbras/omninode}"

run() { echo -e "\n$ $OMNINODE $*"; $OMNINODE "$@"; echo; }

echo "== 1. Initialize the project =="
run init --name "Demo Audit" --force

echo "== 2. Register two 'researcher' agents that echo their task =="
run agent add --name researcher1 --command node \
  --arg=-e "--arg=let b='';process.stdin.on('data',d=>b+=d);process.stdin.on('end',()=>process.stdout.write('R1 analyzed the code'))"
run agent add --name researcher2 --command node \
  --arg=-e "--arg=let b='';process.stdin.on('data',d=>b+=d);process.stdin.on('end',()=>process.stdout.write('R2 independently found: no rate limiting'))"

echo "== 3. Register an execution agent =="
run agent add --name executor --command node --arg=-e "--arg=process.stdout.write('Fixes applied and tests green')"

echo "== 4. Add the demo pipeline (memory + heuristic planner) =="
cat >> omninode.yaml <<'YAML'

  memory:
    provider: local

  planner:
    kind: heuristic

  pipelines:
    - id: demo-audit
      name: Demo multi-AI audit
      steps:
        - id: research
          kind: research
          agents: [researcher1, researcher2]
        - id: plan
          kind: plan
        - id: execute
          kind: execute
          agent: executor
YAML

echo "== 5. Run the whole workflow in one command =="
run run demo-audit "audit the authentication module"

echo "== 6. Inspect the state =="
run status
run report combined
run plan list

echo "== 7. Audit trail =="
run audit -n 5

echo "Demo complete. Clean up with: rm -rf .omninode omninode.yaml"