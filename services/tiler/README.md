# services/tiler

`pmtiles extract` behind HTTP. The MCP Worker's queue consumer calls `POST /extract` and streams the result into R2.

```sh
docker build -t waypack-tiler services/tiler
docker run --rm -p 8090:8080 waypack-tiler        # matches TILER_URL in services/mcp/wrangler.jsonc
curl -s -X POST localhost:8090/extract \
  -d '{"source":"https://build.protomaps.com/20261003.pmtiles","bbox":[-118.78,36.56,-118.73,36.61],"maxzoom":14}' -o test.pmtiles
```

In production, leave `TILER_URL` empty: the Worker uses the `TILER` Cloudflare Container binding built from this Dockerfile.

## Planet mirror (design §6.6)
Monthly, mirror the latest Protomaps build to R2 so extracts read same-cloud:

```sh
# container env: MIRROR_TOKEN, RCLONE_CONFIG_R2_TYPE=s3, RCLONE_CONFIG_R2_PROVIDER=Cloudflare,
# RCLONE_CONFIG_R2_ACCESS_KEY_ID, RCLONE_CONFIG_R2_SECRET_ACCESS_KEY, RCLONE_CONFIG_R2_ENDPOINT=https://<acct>.r2.cloudflarestorage.com
curl -X POST -H "Authorization: Bearer $MIRROR_TOKEN" tiler/mirror \
  -d '{"source":"https://build.protomaps.com/20261003.pmtiles","dest":"r2:waypack/basemap/planet-20261003.pmtiles"}'
```
Then set the Worker's `PLANET_URL` to the mirror's URL (public R2 custom domain or a signed endpoint).
