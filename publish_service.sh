#!/bin/bash
set -euo pipefail

# script taken and slightly modified from https://www.devwithimagination.com/2020/02/02/running-homebridge-on-docker-without-host-network-mode/

function call_dns_sd {

  local name=$1
  local accessory_category=$2
  local mac_address=$3
  local port=$4
  local setup_id=$5
  local sh=$(echo -n ${setup_id}${mac_address} | openssl dgst -binary -sha512 | head -c 4 | base64)

  dns-sd -R test_homebridge _hap._tcp. local ${port} id=${mac_address} md=${name} ff=0 pv=1.1 ci=2 sh=${sh} c#=1 s#=1 sf=1
}

# Find the running homebridge container
CONTAINER=$(sudo docker ps | grep homebridge | cut -d " " -f1)


if [ -z "$CONTAINER" ]; then
  echo "No running homebridge container found"
  exit 1
fi

# Get configuration values out of the container configuration file
CONFIG=$(sudo docker exec "$CONTAINER" cat /homebridge-connexoon/homebridge-home/config.json)
NAME=$(echo "$CONFIG" | jq -r .bridge.name)
MAC=$(echo "$CONFIG" | jq -r .bridge.username)
PORT=$(echo "$CONFIG" | jq -r .bridge.port)

ACCESSORY_CONFIG=$(sudo docker exec "$CONTAINER" cat /homebridge-connexoon/homebridge-home/persist/AccessoryInfo.${MAC//:/}.json)
SETUPID=$(echo "$ACCESSORY_CONFIG" | jq -r .setupID)
CATEGORY=$(echo "$ACCESSORY_CONFIG" | jq -r .category)

# accessory category 2=bridge
call_dns_sd "$NAME" $CATEGORY "$MAC" "$PORT" "$SETUPID"

done