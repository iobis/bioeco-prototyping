from elasticsearch import Elasticsearch
import os


def create_mapping(client, index, mapping):
    if client.indices.exists(index=index):
        client.indices.delete(index=index)
    if not client.indices.exists(index=index):
        client.indices.create(index=index, body=mapping)
    client.indices.put_settings(
        index=index,
        body={
            "index": {
                "refresh_interval": "30s"
            }
        }
    )


def create_es_client(es_url: str) -> Elasticsearch:
    return Elasticsearch(
        es_url,
        basic_auth=("elastic", os.environ.get("ELASTIC_PASSWORD", "")),
        request_timeout=60,
    )
