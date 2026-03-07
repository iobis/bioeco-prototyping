# BioEco Portal (frontend)

## Development

From the **repo root**:

```bash
docker compose up
```

Then open **http://localhost:5173**. Edit files in `app/`; the dev server in the frontend container will hot-reload. The frontend image bakes in `node_modules` and only mounts `src/` and config files so the container reliably sees your changes.
