# GraphHopper exact isochrone backend

This folder is the exact-road-network backend for the GitHub Pages H5.

## Why it exists

The public FOSSGIS Valhalla instance limits isochrones to 4 contours and a maximum 120-minute contour. The H5 intentionally does not fake longer results with circles.

GraphHopper's open-source `/isochrone` endpoint expands a shortest-path tree on the imported OSM graph and accepts `time_limit` in seconds. The frontend can therefore request longer exact road-network service areas from a self-hosted instance.

## Data

Place your OSM PBF at:

```
routing-backend/graphhopper/data/region.osm.pbf
```

For very long durations the imported graph must cover every area that could be reached. A small regional extract will naturally stop at its data boundary.

## Start

```bash
docker compose up -d --build
```

The CORS proxy listens on:

```
http://SERVER_IP:8988
```

For production, put HTTPS in front of this port (Nginx/Caddy/Cloudflare) because GitHub Pages is HTTPS and browsers block mixed HTTP content.

Then edit:

```
isochrone/router-config.js
```

and set:

```js
graphhopperBaseUrl: 'https://routing.example.com'
```

No API key is required.

## Important performance note

GraphHopper's isochrone endpoint enumerates a shortest-path tree. A 30-day car budget on a continent-scale/world-scale graph can visit a huge fraction of the graph and may require substantial RAM/CPU and long request times. The result is still road-network based, but the practical limit is hardware + graph coverage, not the H5 input field.
