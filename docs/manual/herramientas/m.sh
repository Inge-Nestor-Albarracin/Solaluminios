#!/usr/bin/env bash
# Client of driver.mjs:  m.sh eval < script.js | m.sh shot NAME [SELECTOR] [PAD] | m.sh goto URL | m.sh viewport JSON | m.sh quit
D=http://127.0.0.1:9444
case "$1" in
  eval) curl -s -X POST "$D/eval" --data-binary @- ;;
  shot) curl -s -G -X POST "$D/shot" --data-urlencode "name=$2" ${3:+--data-urlencode "selector=$3"} ${4:+--data-urlencode "pad=$4"} ${FULL:+--data-urlencode "full=1"} ;;
  goto) curl -s -X POST "$D/goto" --data-binary "$2" ;;
  viewport) curl -s -X POST "$D/viewport" --data-binary "$2" ;;
  quit) curl -s -X POST "$D/quit" ;;
esac
echo
