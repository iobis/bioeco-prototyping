# bioeco-graph

## Setup
### Blazegraph, Elasticsearch, Kibana

```bash
docker compose up -d
```

Check Kibana at <http://localhost:5601/>.

```bash
# password
docker exec -it elasticsearch /usr/share/elasticsearch/bin/elasticsearch-reset-password -u elastic
# token
docker exec -it elasticsearch /usr/share/elasticsearch/bin/elasticsearch-create-enrollment-token -s kibana
# verification code
docker logs -f kibana
```

## Load data
### BioEco portal graph
#### Load graph into Blazegraph

First convert the graph from `bioeco-export/bioeco_graph.jsonld` into Turtle.

```bash
python convert_jsonld_ttl.py 
```

Then load into Blazegraph.

```bash
bash load_blazegraph.sh
```

Check the data at <http://localhost:9999/blazegraph/#query>:

```sparql
SELECT ?subject ?predicate ?object
WHERE {
  ?subject ?predicate ?object .
}
```

#### Load data into Elastic

```bash
python bioeco_load_elastic.py
```
