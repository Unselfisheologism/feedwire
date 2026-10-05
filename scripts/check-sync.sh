#!/bin/sh
# The dashboard and schema are copied into both packages. Fail if they drift.
set -e
cd "$(dirname "$0")/.."
cmp node/dashboard.html python/superfeedback/dashboard.html
cmp spec/feedback.schema.json node/feedback.schema.json
cmp spec/feedback.schema.json python/superfeedback/feedback.schema.json
echo "copies in sync"
