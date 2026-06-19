## bioeco-portal

### Loading data into Elasticsearch

Two loaders share `scripts/util.py` (indices, EOV vocabulary, geometry normalization, indexing):

- **`scripts/load_data.py`** — flat directory of per-program JSON/JSON-LD files (legacy graph export).
- **`scripts/load_eov_metadata_data.py`** — EOV metadata app export under `data/eov-metadata-app-front-entries/jsonFiles/` (one subdirectory per programme). Logs structured import issues (missing geometry, unknown EOV URLs, invalid JSON, etc.).

Both write to the `project` and `project_grid` indices in Elasticsearch.

- **Prerequisites**
  - Elasticsearch running and reachable.
  - `ELASTIC_PASSWORD` set in your environment for the `elastic` user.

- **Basic usage**

```bash
python scripts/load_data.py \
  --input /path/to/bioeco_graph.jsonld \
  --es-url http://localhost:9200
```

**EOV metadata app export** (default input path is `data/eov-metadata-app-front-entries/jsonFiles`):

```bash
python scripts/load_eov_metadata_data.py \
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

### Adjusting Elasticsearch memory usage

- **Limit Elasticsearch JVM heap**  
  In `docker-compose.yml` and `docker-compose.prod.yml`, under the `elasticsearch` service, set `ES_JAVA_OPTS`:

  ```yaml
  services:
    elasticsearch:
      environment:
        - discovery.type=single-node
        - ELASTIC_PASSWORD=${ELASTIC_PASSWORD}
        - xpack.security.http.ssl.enabled=false
        - ES_JAVA_OPTS=-Xms1g -Xmx1g
  ```

  Adjust `1g` up or down depending on how much RAM you want Elasticsearch to use.

- **Optional: add a container memory limit**  
  To hard‑cap total container memory in dev:

  ```yaml
  services:
    elasticsearch:
      mem_limit: 2g
  ```

  After changing these settings, run `docker compose down` and then `docker compose up --build` for them to take effect.