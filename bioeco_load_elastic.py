from SPARQLWrapper import SPARQLWrapper, JSON
from elasticsearch import BadRequestError
from shapely import wkt, buffer, MultiPolygon
from shapely.geometry import mapping
import h3
from elasticsearch.helpers import bulk
from util import create_mapping, create_es_client
import urllib3
import logging
from h3 import LatLngPoly

project_index = "project"
grid_index = "project_grid"
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
logging.basicConfig(level=logging.INFO)
logging.getLogger("elastic_transport.transport").setLevel(logging.WARNING)

# elastic

client = create_es_client()

create_mapping(client, project_index, {
    "mappings": {
        "properties": {
            "name": {"type": "keyword"},
            "id": {"type": "keyword"},
            "geometry": {"type": "geo_shape"}
        }
    }
})

create_mapping(client, grid_index, {
    "mappings": {
        "properties": {
            "project": {"type": "keyword"},
            "geometry": {"type": "geo_point"}
        }
    }
})

# sparql

sparql = SPARQLWrapper("http://localhost:9999/blazegraph/namespace/kb/sparql")

query = """
    PREFIX schema: <http://schema.org/>
    PREFIX geosparql: <http://www.opengis.net/ont/geosparql#>

    SELECT ?id ?name ?geometry
    WHERE {
    ?project a schema:ResearchProject ;
            schema:name ?name .
    OPTIONAL {
        ?project geosparql:hasGeometry ?g .
        ?g geosparql:asWKT ?geometry .
    }
    BIND(STR(?project) AS ?id)
    }
"""

sparql.setQuery(query)
sparql.setReturnFormat(JSON)
results = sparql.query().convert()

for i, result in enumerate(results["results"]["bindings"]):
    project = {k: v["value"] for k, v in result.items()}
    logging.info(f"Loading project {project['name']} ({i + 1}/{len(results['results']['bindings'])})")

    cells = []
    if "geometry" in project:
        geometry = wkt.loads(project["geometry"])
        geojson = mapping(geometry)
        project["geometry"] = geojson
        buff = buffer(geometry, 0.1)
        if buff.geom_type == "Polygon":
            buff = MultiPolygon([buff])
        for poly in buff.geoms:
            outer_latlng = [(y, x) for x, y in poly.exterior.coords]
            holes_latlng = [[(y, x) for x, y in interior.coords] for interior in poly.interiors]
            latlng_poly = LatLngPoly(outer_latlng, *holes_latlng)
            cells.extend(
                h3.polygon_to_cells(
                    latlng_poly,
                    res=5
                )
            )
    try:
        response = client.index(index=project_index, document=project)
    except BadRequestError as e:
        logging.error(e)

    if cells:
        cells = list(set(cells))
        actions = []
        for cell in list(set(cells)):
            # TODO: use rectangular instead of hex to match kibana aggregation?
            ll = h3.cell_to_latlng(cell)
            doc = {
                "project": project["name"],
                "geometry": tuple(reversed(ll))
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
