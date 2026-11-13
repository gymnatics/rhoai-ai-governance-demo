#!/usr/bin/env bash
# Optional (F1/B6 per-request usage records): S3 bucket + Secret for the MaaS "usage" LokiStack.
# Either set LOKI_S3_ENDPOINT, LOKI_S3_BUCKET, LOKI_S3_ACCESS_KEY, LOKI_S3_SECRET_KEY in config/demo.env,
# or have the rhoai-toolkit in-cluster SeaweedFS (namespace s3-storage) and the bucket is created there.
# Credentials go straight from source to the new Secret; nothing is printed.
source "$(dirname "$0")/lib.sh"
: "${LOKI_S3_BUCKET:=loki-usage}"
if [ -z "${LOKI_S3_ENDPOINT:-}" ]; then
  POD=$(oc get pod -n s3-storage -o name 2>/dev/null | grep seaweedfs | head -1 || true)
  [ -n "$POD" ] || die "no LOKI_S3_* settings and no SeaweedFS in s3-storage; configure object storage first"
  echo "s3.bucket.create -name $LOKI_S3_BUCKET" | oc exec -i -n s3-storage "$POD" -- weed shell -master=localhost:9333 >/dev/null 2>&1 || true
  oc get secret seaweedfs-s3-config -n s3-storage -o jsonpath='{.data.s3\.json}' | base64 -d | python3 -c '
import json, os, subprocess, sys
c = json.load(sys.stdin)["identities"][0]["credentials"][0]
m = {"apiVersion": "v1", "kind": "Secret", "metadata": {"name": "loki-usage-s3", "namespace": os.environ["MONITORING_NS"],
     "labels": {"app.kubernetes.io/part-of": os.environ["PART_OF"]}},
     "stringData": {"endpoint": "http://seaweedfs-s3.s3-storage.svc.cluster.local:8333", "bucketnames": os.environ.get("LOKI_S3_BUCKET", "loki-usage"),
                    "region": "us-east-1", "access_key_id": c["accessKey"], "access_key_secret": c["secretKey"], "forcepathstyle": "true"}}
subprocess.run(["oc", "apply", "-f", "-"], input=json.dumps(m).encode(), check=True, stdout=subprocess.DEVNULL)'
else
  oc create secret generic loki-usage-s3 -n "$MONITORING_NS" --from-literal=endpoint="$LOKI_S3_ENDPOINT" --from-literal=bucketnames="$LOKI_S3_BUCKET" \
    --from-literal=region="${LOKI_S3_REGION:-us-east-1}" --from-literal=access_key_id="$LOKI_S3_ACCESS_KEY" \
    --from-literal=access_key_secret="$LOKI_S3_SECRET_KEY" --dry-run=client -o yaml | oc apply -f - >/dev/null
  oc label secret loki-usage-s3 -n "$MONITORING_NS" app.kubernetes.io/part-of="$PART_OF" --overwrite >/dev/null
fi
ok "secret $MONITORING_NS/loki-usage-s3 (bucket $LOKI_S3_BUCKET)"
