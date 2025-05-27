#!/bin/bash

# python bioeco_convert_ttl.py
python mbo_convert_ttl.py
bash load_blazegraph.sh
# python bioeco_load_elastic.py
python mbo_load_elastic.py
