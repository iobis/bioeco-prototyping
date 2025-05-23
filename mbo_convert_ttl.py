from rdflib import Graph
from os import listdir
from os.path import isfile, join


wp5_path = "../dataset-catalogue/scripts/tests/output/WP5"

files = [join(wp5_path, f) for f in listdir(wp5_path) if isfile(join(wp5_path, f)) and f.startswith("VLIZ")]
combined_graph = Graph()

for f in files:
    print(f)
    g = Graph()
    g.parse(f, format="json-ld")
    combined_graph += g

combined_graph.serialize(destination="data/mbo_graph.ttl", format="turtle")
