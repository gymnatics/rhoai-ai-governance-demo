#!/usr/bin/env bash
# Render docs/RUN-THROUGH.html with this cluster's URLs -> RUN-THROUGH.local.html (repo root, git-ignored).
# Only the URL placeholders are replaced (the page's own JavaScript `${...}` stays intact).
source "$(dirname "$0")/lib.sh"
python3 -I - "$REPO_DIR/docs/RUN-THROUGH.html" "$REPO_DIR/RUN-THROUGH.local.html" <<'EOF'
import os, sys
s = open(sys.argv[1]).read()
for k in ("DASH_URL", "CONSOLE_URL", "RECEIVER_URL", "MAAS_URL", "NEMO_URL"):
    s = s.replace("${%s}" % k, os.environ[k])
open(sys.argv[2], "w").write(s)
EOF
ok "run-through for this cluster: $REPO_DIR/RUN-THROUGH.local.html"
