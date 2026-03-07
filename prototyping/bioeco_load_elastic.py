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
from polygon_geohasher.polygon_geohasher import polygon_to_geohashes, geohashes_to_polygon
import geohash
import time
import uuid
from datetime import datetime
import argparse


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
            "id": {"type": "keyword"},
            "uri": {"type": "keyword"},
            "name": {
                "type": "text",
                "fields": {
                    "keyword": {"type": "keyword"}
                }
            },
            "description": {"type": "text"},
            "temporal_coverage": {"type": "date"},
            "start_date": {"type": "date"},
            "end_date": {"type": "date"},
            "start_year": {"type": "integer"},
            "end_year": {"type": "integer"},
            "url": {"type": "keyword"},
            "keywords": {"type": "keyword"},
            "eovs": {
                "type": "nested",
                "properties": {
                    "uri": {"type": "keyword"},
                    "label": {
                        "type": "text",
                        "fields": {"keyword": {"type": "keyword"}}
                    },
                    "code": {"type": "keyword"}
                }
            },
            "readiness_data": {"type": "keyword"},
            "readiness_requirements": {"type": "keyword"},
            "readiness_coordination": {"type": "keyword"},
            "maintenance_frequency": {"type": "keyword"},
            "publishing_principles": {"type": "keyword"},
            "funding_categories": {"type": "keyword"},
            "funding_descriptions": {"type": "text"},
            "additional_properties": {
                "type": "nested",
                "properties": {
                    "name": {"type": "keyword"},
                    "value": {"type": "keyword"}
                }
            },
            "geometry": {"type": "geo_shape"}
        }
    }
})

create_mapping(client, grid_index, {
    "mappings": {
        "properties": {
            "id": {"type": "keyword"},
            "project": {"type": "text"},
            "eov_codes": {"type": "keyword"},
            "start_year": {"type": "integer"},
            "end_year": {"type": "integer"},
            "geometry": {"type": "geo_point"}
        }
    }
})

parser = argparse.ArgumentParser()
parser.add_argument(
    "--limit",
    type=int,
    default=None,
    help="Maximum number of projects to load into Elasticsearch",
)
args = parser.parse_args()
limit = args.limit

# sparql

sparql = SPARQLWrapper("http://localhost:9999/blazegraph/namespace/kb/sparql")

query = """
    PREFIX schema: <http://schema.org/>
    PREFIX geosparql: <http://www.opengis.net/ont/geosparql#>

    SELECT ?id ?name ?description ?geometry ?temporal_coverage ?url
           (GROUP_CONCAT(DISTINCT ?keyword; SEPARATOR=",") AS ?keywords)
           ?readiness_data ?readiness_requirements ?readiness_coordination
           ?maintenance_frequency ?publishing_principles
           (GROUP_CONCAT(DISTINCT ?funding_cat; SEPARATOR=",") AS ?funding_categories)
           (GROUP_CONCAT(DISTINCT ?funding_desc; SEPARATOR="||") AS ?funding_descriptions)
           (GROUP_CONCAT(DISTINCT ?apPair; SEPARATOR="||") AS ?additional_properties)
    WHERE {
      ?project a schema:ResearchProject ;
               schema:name ?name .

      OPTIONAL { ?project schema:description ?description . }
      OPTIONAL { ?project schema:temporalCoverage ?temporal_coverage . }
      OPTIONAL { ?project schema:url ?url . }
      OPTIONAL { ?project schema:keywords ?keyword . }
      OPTIONAL { ?project schema:publishingPrinciples ?publishing_principles . }

      OPTIONAL {
        ?project schema:additionalProperty ?ap1 .
        ?ap1 schema:name "readinessData" .
        ?ap1 schema:value ?readiness_data .
      }
      OPTIONAL {
        ?project schema:additionalProperty ?ap2 .
        ?ap2 schema:name "readinessRequirements" .
        ?ap2 schema:value ?readiness_requirements .
      }
      OPTIONAL {
        ?project schema:additionalProperty ?ap3 .
        ?ap3 schema:name "readinessCoordination" .
        ?ap3 schema:value ?readiness_coordination .
      }
      OPTIONAL {
        ?project schema:additionalProperty ?ap4 .
        ?ap4 schema:name "maintenanceFrequency" .
        ?ap4 schema:value ?maintenance_frequency .
      }

      OPTIONAL {
        ?project schema:funding ?funding .
        OPTIONAL { ?funding schema:category ?funding_cat . }
        OPTIONAL { ?funding schema:description ?funding_desc . }
      }

      OPTIONAL {
        ?project schema:additionalProperty ?ap .
        ?ap schema:name ?apName .
        ?ap schema:value ?apValue .
        BIND(CONCAT(?apName, ":", ?apValue) AS ?apPair)
      }

      OPTIONAL {
        ?project geosparql:hasGeometry ?g .
        ?g geosparql:asWKT ?geometry .
      }

      BIND(STR(?project) AS ?id)
    }
    GROUP BY ?id ?name ?description ?geometry ?temporal_coverage ?url
             ?readiness_data ?readiness_requirements ?readiness_coordination
             ?maintenance_frequency ?publishing_principles
"""

sparql.setQuery(query)
sparql.setReturnFormat(JSON)
results = sparql.query().convert()

# EOVs as (uri, label) per project - one row per variableMeasured
query_eovs = """
    PREFIX schema: <http://schema.org/>
    SELECT ?id ?eovUri ?eovLabel
    WHERE {
      ?project a schema:ResearchProject .
      ?project schema:variableMeasured ?vm .
      ?vm schema:propertyID ?eovUri .
      OPTIONAL { ?vm schema:name ?eovLabel . }
      BIND(STR(?project) AS ?id)
    }
"""
sparql.setQuery(query_eovs)
eov_results = sparql.query().convert()
eov_by_id = {}
for row in eov_results["results"]["bindings"]:
    project_id = row["id"]["value"]
    uri = row["eovUri"]["value"]
    label = row.get("eovLabel", {}).get("value", "")
    if "/eov/" in uri:
        code = uri.split("/eov/", 1)[1]
    else:
        code = uri.rsplit("/", 1)[-1]
    if project_id not in eov_by_id:
        eov_by_id[project_id] = []
    # dedupe by uri
    if not any(e["uri"] == uri for e in eov_by_id[project_id]):
        eov_by_id[project_id].append({"uri": uri, "label": label, "code": code})

for i, result in enumerate(results["results"]["bindings"]):
    if limit is not None and i >= limit:
        break
    project = {k: v["value"] for k, v in result.items()}

    # Stable UUID based on the project URI
    original_uri = project["id"]
    project["id"] = str(uuid.uuid5(uuid.NAMESPACE_URL, original_uri))
    project["uri"] = original_uri

    # Temporal coverage and derived year fields (single date or ISO 8601 interval start/end)
    temporal = project.get("temporal_coverage")
    if temporal:
        try:
            s = temporal.replace("Z", "").strip()
            if "/" in s:
                start_str, end_str = s.split("/", 1)
                start_dt = datetime.fromisoformat(start_str.strip())
                end_dt = datetime.fromisoformat(end_str.strip())
                project["start_date"] = start_dt.date().isoformat()
                project["end_date"] = end_dt.date().isoformat()
                project["start_year"] = start_dt.year
                project["end_year"] = end_dt.year
            else:
                dt = datetime.fromisoformat(s)
                project["start_date"] = dt.date().isoformat()
                project["end_date"] = None
                project["start_year"] = dt.year
                project["end_year"] = dt.year
        except (ValueError, TypeError) as e:
            logging.warning(f"Could not parse temporal_coverage '{temporal}' for project {project['name']}: {e}")

    # Keywords as a list
    if "keywords" in project:
        keywords = [kw.strip() for kw in project["keywords"].split(",") if kw.strip()]
        project["keywords"] = list(dict.fromkeys(keywords))

    # EOVs as combined list of {uri, label, code}
    project["eovs"] = eov_by_id.get(original_uri, [])

    # Funding categories and descriptions
    if "funding_categories" in project:
        funding_categories_value = project["funding_categories"]
        if funding_categories_value:
            cats = [c for c in funding_categories_value.split(",") if c]
            project["funding_categories"] = list(dict.fromkeys(cats))
        else:
            # Remove empty string value to avoid mapping conflicts
            del project["funding_categories"]

    if "funding_descriptions" in project:
        funding_descriptions_value = project["funding_descriptions"]
        if funding_descriptions_value:
            descs = [d for d in funding_descriptions_value.split("||") if d]
            project["funding_descriptions"] = descs
        else:
            del project["funding_descriptions"]

    # All additionalProperty name/value pairs
    if "additional_properties" in project:
        additional_props_value = project["additional_properties"]
        if additional_props_value:
            pairs = [p for p in additional_props_value.split("||") if p]
            additional_properties = []
            for pair in pairs:
                if ":" in pair:
                    name, value = pair.split(":", 1)
                else:
                    name, value = pair, ""
                additional_properties.append(
                    {
                        "name": name,
                        "value": value,
                    }
                )
            project["additional_properties"] = additional_properties
        else:
            # Don't send an empty string for a nested field
            del project["additional_properties"]

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
            outer_geohashes_polygon = polygon_to_geohashes(poly, 4, False)
            cells.extend(outer_geohashes_polygon)
        #     outer_latlng = [(y, x) for x, y in poly.exterior.coords]
        #     holes_latlng = [[(y, x) for x, y in interior.coords] for interior in poly.interiors]
        #     latlng_poly = LatLngPoly(outer_latlng, *holes_latlng)
        #     cells.extend(
        #         h3.polygon_to_cells(
        #             latlng_poly,
        #             res=5
        #         )
        #     )
    try:
        response = client.index(index=project_index, id=project["id"], document=project)
    except BadRequestError as e:
        logging.error(e)

    if cells:
        cells = list(set(cells))
        actions = []
        for cell in list(set(cells)):
            lat, lon = geohash.decode(cell)
            doc = {
                "id": project["id"],
                "project": project["name"],
                "eov_codes": [e["code"] for e in project.get("eovs", [])],
                "start_year": project.get("start_year"),
                "end_year": project.get("end_year"),
                "geometry": (lon, lat)
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
