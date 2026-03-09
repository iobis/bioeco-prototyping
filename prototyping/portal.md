# BioEco portal architecture

## Functional requirements

The goal of the BioEco portal is to:

- show the spatial coverage of monitoring programmes by EOV, subvariables, SOPs
- provide access to monitoring programme metadata (EOV, subvariables, spatial and temporal coverage, SOPs, readiness levels)
- show the spatial coverage of EOV datasets or products by EOV or by monitoring programme
- act as a data discovery service for OBIS
- possibly show the location and status of platforms in real time (this will be implemented later)

## Data flow

The data flow into the portal is expected to be guided by the ODIS architecture, i.e. by publishing schema.org metadata online, registering the source in the ODIS catalog, and harvesting metadata into a knowledge graph. To avoid having to set up harvesting infrastructure we can try working with the OceanInfohub knowledge graph, but as this graph is currently not kept up to date, alternatives need to be explored. A first version of the portal could make use of a static graph export from the current GeoNode based system (see https://github.com/iobis/bioeco-export). The graph could be split up into separate files per programme, to make it easier to apply updates or add new programmes, for example from the BioEcoOcean metadata entry app.

The dataset view will rely on our ability to include links to the EOVs and monitoring programmes in dataset metadata, if possible in EML. This needs to be developed and documented.

## Tech stack

### Data ingestion

To be able to query and process the harvested linked data, it first needs to be loaded into a graph database. During prototyping, the BioEco portal graph was converted to Turtle (`prototyping/bioeco_convert_ttl.py`), before being importing into Blazegraph (`prototyping/load_blazegraph.sh`). From the graph database, the entities we are interested in can be extracted and loaded into Elasticsearch.

From Elasticsearch we can serve vector tiles for the programme geometries, or for a gridded aggregation with programme counts. As grid aggregation is currently not freely available for `geo_shape` fields, we will need a separate index where programme and dataset geometries have been converted to `geo_point` collections. This seems to be working well in prototyping:

![kibana](images/kibana.png)

### API

A FastAPI service will be implemented to support the frontend app, with the following endpoints and parameters:

- `eov`
- `subvariable`
- `sop`
- `/programme`
  - `eov`
  - `subvariable`
  - `sop`
  - `search`
  - `start_year`
  - `end_year`
  - `bbox`
- `/programme/{id}`
- `/dataset`
  - `eov`
  - `subvariable`
  - `sop`
  - `programme`
  - `start_year`
  - `end_year`
  - `bbox`
- `/dataset/{id}`
- `/tiles/programme/{z}/{x}/{y}.mvt`
  - `eov`
  - `subvariable`
  - `sop`
  - `search`
  - `start_year`
  - `end_year`
- `/tiles/dataset/{z}/{x}/{y}.mvt`
  - `eov`
  - `subvariable`
  - `sop`
  - `programme`
  - `start_year`
  - `end_year`

### Frontend

The new frontend will be based on the existing React app. Functionality for viewing data coverage is not implemented in the current portal and will need to be added.
