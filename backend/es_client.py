from elasticsearch import Elasticsearch

from config import ELASTICSEARCH_URL, ELASTIC_USER, ELASTIC_PASSWORD

def get_es_client():
    return Elasticsearch(
        ELASTICSEARCH_URL,
        basic_auth=(ELASTIC_USER, ELASTIC_PASSWORD),
        request_timeout=60,
    )
