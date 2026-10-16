#!/bin/bash
set -e
# Exercise ordinary global extension discovery while reusing the isolated live-proof harness.
args=()
while (( $# )); do
  case "$1" in
    --no-extensions) shift ;;
    -e|--extension) shift 2 ;;
    --extension=*) shift ;;
    *) args+=("$1"); shift ;;
  esac
done
exec /opt/homebrew/bin/omp "${args[@]}"
