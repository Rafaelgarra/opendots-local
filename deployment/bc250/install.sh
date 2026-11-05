#!/usr/bin/env bash
set -euo pipefail
umask 077
bc_root="${HOME}/.local/share/opendots-bc250"
bc_source="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
bc_bind="${BC_LAN_ADDRESS:-127.0.0.1}"
bc_dns="${BC_DNS_NAME:-bc250-server.local}"
[[ "$bc_bind" =~ ^[0-9.]+$ && "$bc_dns" =~ ^[A-Za-z0-9.-]+$ ]] || { echo 'Invalid address or DNS name.' >&2; exit 1; }
mkdir -p "$bc_root/code" "$bc_root/private" "$bc_root/data" "${HOME}/.config/systemd/user"
chmod 700 "$bc_root" "$bc_root/private" "$bc_root/data"
for bc_file in bc-service-main.js bc-service.js local-history.js; do
  install -m 600 "$bc_source/code/$bc_file" "$bc_root/code/$bc_file"
done
printf '{"type":"module"}\n' > "$bc_root/code/package.json"
if [[ ! -f "$bc_root/private/token" ]]; then openssl rand -hex 32 > "$bc_root/private/token"; fi
if [[ ! -f "$bc_root/private/server.pem" ]]; then
  openssl req -x509 -newkey rsa:3072 -nodes -keyout "$bc_root/private/ca.key" -out "$bc_root/private/ca.pem" -days 1825 -subj '/CN=OpenDots BC250 private CA' -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign,cRLSign'
  openssl req -new -newkey rsa:3072 -nodes -keyout "$bc_root/private/server.key" -out "$bc_root/private/server.csr" -subj "/CN=$bc_dns"
  printf 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\nsubjectAltName=DNS:%s,IP:%s,IP:127.0.0.1,DNS:localhost\n' "$bc_dns" "$bc_bind" > "$bc_root/private/server.ext"
  openssl x509 -req -in "$bc_root/private/server.csr" -CA "$bc_root/private/ca.pem" -CAkey "$bc_root/private/ca.key" -CAcreateserial -out "$bc_root/private/server.pem" -days 365 -extfile "$bc_root/private/server.ext"
fi
cat > "$bc_root/service.env" <<EOF
BC_DATABASE_PATH=$bc_root/data/history.sqlite
BC_TOKEN_FILE=$bc_root/private/token
BC_TLS_CERT_FILE=$bc_root/private/server.pem
BC_TLS_KEY_FILE=$bc_root/private/server.key
BC_HOST=$bc_bind
BC_PORT=44311
BC_QWEN_URL=http://127.0.0.1:11434/v1/
BC_QWEN_MODEL=agente
EOF
cat > "${HOME}/.config/systemd/user/opendots-bc250.service" <<EOF
[Unit]
Description=OpenDots BC250 history and Qwen HTTPS endpoint
After=network-online.target
[Service]
WorkingDirectory=$bc_root
ExecStart=/usr/bin/node --env-file=$bc_root/service.env $bc_root/code/bc-service-main.js
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=true
[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now opendots-bc250.service
echo "BC-250 endpoint: https://$bc_dns:44311"
echo "Private token: $bc_root/private/token (do not publish)"
echo "Client trust certificate: $bc_root/private/ca.pem"
echo 'If blocked by the firewall, allow TCP 44311 only from the approved client IP using the BC-250 administrator account. Do not expose the port on the router.'
