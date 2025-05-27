from elasticsearch import Elasticsearch


def create_mapping(client, index, mapping):
    if client.indices.exists(index=index):
        client.indices.delete(index=index)
    if not client.indices.exists(index=index):
        client.indices.create(index=index, body=mapping)
    client.indices.put_settings(
        index=index,
        body={
            "index": {
                "refresh_interval": "10s"
            }
        }
    )


def create_es_client():
    return Elasticsearch(
        "https://localhost:9200",
        basic_auth=("elastic", "FYiriTb4zH=+r0EJ877A"),
        verify_certs=False
    )
