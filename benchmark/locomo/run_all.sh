#!/bin/sh
set -eu

mode=${1:?"usage: run_all.sh baseline|memory|memory-consolidate"}
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
data=${LOCOMO_DATA:-$script_dir/data/locomo10.json}
sample_concurrency=${SAMPLE_CONCURRENCY:-2}
qa_concurrency=${QA_CONCURRENCY:-4}
run_root=${LOCOMO_RUN_ROOT:-${TMPDIR:-/tmp}/dsh-memory-locomo-runs}
result_root=${LOCOMO_RESULT_ROOT:-$script_dir/.tmp/results}/locomo10/$mode
python=$script_dir/.venv/bin/python

[ -f "$data" ] || {
  echo "LoCoMo data not found: $data" >&2
  exit 2
}
[ -x "$python" ] || {
  echo "Python environment not found: $python" >&2
  exit 2
}

case "$sample_concurrency" in
  ''|*[!0-9]*|0)
    echo "SAMPLE_CONCURRENCY must be a positive integer" >&2
    exit 2
    ;;
esac
case "$qa_concurrency" in
  ''|*[!0-9]*|0)
    echo "QA_CONCURRENCY must be a positive integer" >&2
    exit 2
    ;;
esac

mkdir -p "$result_root"

samples='conv-26
conv-30
conv-41
conv-42
conv-43
conv-44
conv-47
conv-48
conv-49
conv-50'

printf '%s\n' "$samples" | xargs -P "$sample_concurrency" -I '{}' \
  "$python" "$script_dir/run.py" "$mode" \
    --data "$data" \
    --sample '{}' \
    --question-limit all \
    --qa-concurrency "$qa_concurrency" \
    --run-dir "$run_root/locomo10-$mode-{}-v4" \
    --output "$result_root/{}-v4.jsonl" \
    --dsh-source "$DSH_SOURCE" \
    "$@"
