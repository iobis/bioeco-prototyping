from rdflib import Graph


g = Graph()
g.parse("/Users/pieter/IPOfI Dropbox/Pieter Provoost/werk/projects/MARCO-BOLO/bioeco-export/bioeco_graph.jsonld", format="json-ld")
g.serialize(destination="bioeco_graph.ttl", format="turtle")
