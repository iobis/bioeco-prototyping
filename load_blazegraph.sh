#!/bin/bash

ENDPOINT=http://localhost:9999/blazegraph/namespace/kb/sparql

curl -X POST $ENDPOINT --data-urlencode 'update=DROP ALL;'
curl -X POST $ENDPOINT -H 'Content-Type: application/x-turtle' --data-binary @data/bioeco_graph.ttl
curl -X POST $ENDPOINT -H 'Content-Type: application/x-turtle' --data-binary @data/mbo_graph.ttl
