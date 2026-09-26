#!/usr/bin/env sh
set -eu

: "${OSM_PBF:=/data/region.osm.pbf}"
: "${GRAPH_DIR:=/data/graph-cache}"
: "${JAVA_XMS:=2g}"
: "${JAVA_XMX:=12g}"
: "${ROUTING_TIMEOUT_MS:=1800000}"
: "${MAX_VISITED_NODES:=2147483647}"

if [ ! -f "$OSM_PBF" ]; then
  echo "Missing OSM PBF: $OSM_PBF" >&2
  exit 1
fi

exec java \
  -Xms"$JAVA_XMS" \
  -Xmx"$JAVA_XMX" \
  -Ddw.graphhopper.datareader.file="$OSM_PBF" \
  -Ddw.graphhopper.graph.location="$GRAPH_DIR" \
  -Ddw.graphhopper.routing.timeout_ms="$ROUTING_TIMEOUT_MS" \
  -Ddw.graphhopper.routing.max_visited_nodes="$MAX_VISITED_NODES" \
  -jar /app/graphhopper.jar \
  server /app/config.yml
