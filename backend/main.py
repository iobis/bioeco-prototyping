from fastapi import APIRouter, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from config import CORS_ORIGINS
from routers import projects, tiles, vocabularies

api_app = FastAPI(
    title="BioEco Portal API",
    description="Projects and gridded map tiles from Elasticsearch for the BioEco portal.",
    version="0.1.0",
)

api_app.include_router(vocabularies.router, tags=["vocabularies"])
api_app.include_router(projects.router, prefix="/projects", tags=["projects"])
api_app.include_router(tiles.router, prefix="/tiles", tags=["tiles"])


@api_app.get("/health")
def health():
    return {"status": "ok"}


app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/api", api_app)
