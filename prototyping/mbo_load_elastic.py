from SPARQLWrapper import SPARQLWrapper, JSON
from elasticsearch import BadRequestError
from shapely import wkt, buffer, MultiPolygon
from shapely.geometry import mapping
import h3
from elasticsearch.helpers import bulk
from util import create_mapping, create_es_client
import urllib3
import logging

dataset_index = "dataset"
grid_index = "dataset_grid"
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
logging.basicConfig(level=logging.INFO)
logging.getLogger("elastic_transport.transport").setLevel(logging.WARNING)

# elastic

client = create_es_client()

create_mapping(client, dataset_index, {
    "mappings": {
        "properties": {
            "id": {"type": "keyword"},
            "name": {"type": "keyword"},
            "project": {"type": "keyword"},
            "geometry": {"type": "geo_shape"}
        }
    }
})

create_mapping(client, grid_index, {
    "mappings": {
        "properties": {
            "dataset": {"type": "keyword"},
            "geometry": {"type": "geo_point"}
        }
    }
})

# sparql

sparql = SPARQLWrapper("http://localhost:9999/blazegraph/namespace/kb/sparql")

query = """
    PREFIX schema: <http://schema.org/>
    PREFIX geosparql: <http://www.opengis.net/ont/geosparql#>

    SELECT ?id ?name ?geometry (GROUP_CONCAT(DISTINCT ?project; SEPARATOR=",") AS ?project)
    WHERE {
    ?dataset a schema:Dataset ;
            schema:name ?name .
    OPTIONAL {
        ?dataset geosparql:hasGeometry ?g .
        ?g geosparql:asWKT ?geometry .
    }
    OPTIONAL {
        ?dataset schema:funder ?funder .
        ?funder schema:identifier ?project .
    }
    BIND(STR(?dataset) AS ?id)
    }
    GROUP BY ?id ?name ?geometry
"""

sparql.setQuery(query)
sparql.setReturnFormat(JSON)
results = sparql.query().convert()

for i, result in enumerate(results["results"]["bindings"]):
    dataset = {k: v["value"] for k, v in result.items()}

    logging.info(f"Loading dataset {dataset['name']} ({i + 1}/{len(results['results']['bindings'])})")

    if "project" in dataset:
        dataset["project"] = dataset["project"].split(",")

    cells = []
    if "geometry" in dataset:
        geometry = wkt.loads(dataset["geometry"])
        geojson = mapping(geometry)
        dataset["geometry"] = geojson
        buff = buffer(geometry, 0.1)
        if buff.geom_type == "Polygon":
            buff = MultiPolygon([buff])
        for poly in buff.geoms:
            cells.extend(
                h3.polyfill(
                    mapping(poly),
                    res=5,
                    geo_json_conformant=True
                )
            )
    try:
        response = client.index(index=dataset_index, document=dataset)
    except BadRequestError as e:
        logging.error(e)

    if cells:
        cells = list(set(cells))
        actions = []
        for cell in list(set(cells)):
            # TODO: use rectangular instead of hex to match kibana aggregation?
            cell_geometry = h3.h3_to_geo(cell)
            doc = {
                "dataset": dataset["name"],
                "geometry": tuple(reversed(cell_geometry))
            }
            action = {
                "_index": grid_index,
                "_source": doc
            }
            actions.append(action)
        try:
            bulk(client, actions, refresh="false")
        except BadRequestError as e:
            print(e)
