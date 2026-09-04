#!/bin/sh
set -eu

mode=${1:?"usage: run_conv26.sh baseline|memory|memory-consolidate"}
shift

case "$mode" in
  baseline|memory|memory-consolidate) ;;
  *)
    echo "mode must be baseline, memory, or memory-consolidate" >&2
    exit 2
    ;;
esac

: "${DSH_SOURCE:?export DSH_SOURCE=/absolute/path/to/deepseek-harness first}"

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
question_limit=${QUESTION_LIMIT:-100}
qa_concurrency=${QA_CONCURRENCY:-4}
run_root=${LOCOMO_RUN_ROOT:-${TMPDIR:-/tmp}/dsh-memory-locomo-runs}
result_root=${LOCOMO_RESULT_ROOT:-$script_dir/.tmp/results}

[ -f "$script_dir/data/locomo10.json" ] || {
  echo "LoCoMo data not found: $script_dir/data/locomo10.json" >&2
  exit 2
}
[ -x "$script_dir/.venv/bin/python" ] || {
  echo "Python environment not found: $script_dir/.venv/bin/python" >&2
  exit 2
}

mkdir -p "$result_root"

exec "$script_dir/.venv/bin/python" "$script_dir/run.py" "$mode" \
  --data "$script_dir/data/locomo10.json" \
  --sample conv-26 \
  --question-limit "$question_limit" \
  --qa-concurrency "$qa_concurrency" \
  --run-dir "$run_root/conv-26-$mode-$question_limit-v4" \
  --output "$result_root/conv-26-$mode-$question_limit-v4.jsonl" \
  --dsh-source "$DSH_SOURCE" \
  "$@"
