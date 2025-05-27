from rdflib import Graph


g = Graph()
g.parse("../bioeco-export/bioeco_graph.jsonld", format="json-ld")
g.serialize(destination="data/bioeco_graph.ttl", format="turtle")
