## bioeco-portal

### Loading data into Elasticsearch

The `scripts/load_data.py` script ingests a JSON/JSON-LD export of the project graph into the `project` and `project_grid` indices in Elasticsearch.

- **Prerequisites**
  - Elasticsearch running and reachable.
  - `ELASTIC_PASSWORD` set in your environment for the `elastic` user.

- **Basic usage**

```bash
python scripts/load_data.py \
  --input /path/to/bioeco_graph.jsonld \
  --es-url http://localhost:9200
```

- **Recreating indices before loading**

```bash
python scripts/load_data.py \
  --input /path/to/bioeco_graph.jsonld \
  --es-url http://localhost:9200 \
  --clear-indexes
```

- **Inspecting indexed documents**

```bash
python scripts/load_data.py \
  --input /path/to/bioeco_graph.jsonld \
  --es-url http://localhost:9200 \
  --print-indexed-json
```