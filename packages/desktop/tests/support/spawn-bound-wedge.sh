#!/bin/bash

set -uo pipefail

trap 'exit 143' TERM

echo "spawn-bound-wedge: trap installed, blocking"

/bin/sleep 5

exit 0
