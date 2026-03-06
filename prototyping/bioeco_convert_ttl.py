from rdflib import Graph


g = Graph()
g.parse("/Users/pieter/IPOfI Dropbox/Pieter Provoost/werk/projects/GOOS bioeco/bioeco-export/bioeco_graph.jsonld", format="json-ld")
g.serialize(destination="data/bioeco_graph.ttl", format="turtle")
