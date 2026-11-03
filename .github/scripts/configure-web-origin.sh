#!/usr/bin/env bash
set -euo pipefail

: "${RESOURCE_GROUP:?}"
: "${FUNCTION_APP_NAME:?}"
: "${SITE_URL:?The Static Web App deployment must return its actual URL.}"
: "${PRIMARY_SITE_URL:?}"
: "${API_URL:?}"
: "${GITHUB_STEP_SUMMARY:?}"

origins=("$PRIMARY_SITE_URL")
if [[ "$SITE_URL" != "$PRIMARY_SITE_URL" ]]; then
  origins+=("$SITE_URL")
fi

az functionapp cors add \
  --resource-group "$RESOURCE_GROUP" \
  --name "$FUNCTION_APP_NAME" \
  --allowed-origins "${origins[@]}" \
  --only-show-errors --output none

for origin in "${origins[@]}"; do
  verified=false
  for attempt in $(seq 1 12); do
    if headers="$(curl --fail --silent --show-error --max-time 20 \
      --request OPTIONS --dump-header - --output /dev/null \
      --header "Origin: $origin" \
      --header 'Access-Control-Request-Method: POST' \
      --header 'Access-Control-Request-Headers: content-type,authorization' \
      "$API_URL/api/v1/scans/web")" &&
      printf '%s\n' "$headers" | tr -d '\r' | awk -v origin="$origin" '
        tolower($1) == "access-control-allow-origin:" && $2 == origin { originAllowed = 1 }
        tolower($1) == "access-control-allow-methods:" && tolower($0) ~ /(^|[,[:space:]])post([,[:space:]]|$)/ { methodAllowed = 1 }
        tolower($1) == "access-control-allow-headers:" {
          headers = tolower($0)
          contentTypeAllowed = headers ~ /(^|[,[:space:]])content-type([,[:space:]]|$)/
          authorizationAllowed = headers ~ /(^|[,[:space:]])authorization([,[:space:]]|$)/
        }
        END { exit !(originAllowed && methodAllowed && contentTypeAllowed && authorizationAllowed) }
      '; then
      verified=true
      break
    fi
    sleep 5
  done
  if [[ "$verified" != true ]]; then
    echo "Function API CORS preflight failed for $origin." >&2
    exit 1
  fi
done

printf '### AccessiWeb deployment\n\n- Frontend: %s\n- API health: %s/api/v1/health\n' \
  "$SITE_URL" "$API_URL" >> "$GITHUB_STEP_SUMMARY"
