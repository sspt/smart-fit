# Direct video streaming from Synology

The app can fetch the video catalogue, HLS playlists, segments, posters and MP4 fallbacks directly from a NAS. Your footage does not need to pass through R2 or the app's Cloudflare Worker. The existing starter clips remain available as a fallback. Device-speed playback, equipment control modes, quality selection and immersive overlays use the same player.

## Endpoint

Use a dedicated HTTPS media hostname, for example `https://media.silvio.cloud`, with a valid browser-trusted certificate. A public IP provides reachability; HTTPS and a hostname make it usable from the installed Android app. Use a DNS-only record if delivery should go directly to your NAS. Do not use a DSM administration URL, QuickConnect page, or File Station share page as the video folder URL: the app needs normal static-file requests.

The media folder contains:

```
catalog.json
hls/
  forest-<version>/
    master.m3u8
    poster.jpg
    fallback.mp4
    720p/
      index.m3u8
      init.mp4
      segment-00000.m4s
    1080p/...
    2160p/...
```

Only resolutions at or below the source are generated. All delivery renditions and the fallback are silent. 4K is offered only when the source supports it. Originals remain unchanged outside this prepared media folder.

## Static server on Synology

If your NAS supports Container Manager, create a dedicated `fit-media` shared folder and give the web-server process read access. Put `deployment/synology/compose.yaml` and `nginx.conf` together in a Container Manager project. Adjust `/volume1/fit-media` if your volume/path differs. The media volume is mounted read-only by the web server.

The container listens on **NAS loopback port 8088**, not a public administration port. In Synology Reverse Proxy, create a dedicated rule:

- Source: HTTPS, your media hostname, port 443, valid TLS certificate.
- Destination: HTTP, `127.0.0.1`, port `8088`.
- Preserve normal `Origin`, `Range`, and any authentication/cookie headers.

The supplied Nginx configuration handles MIME types, byte-range requests, HLS segments, cache validators and CORS for `https://fit.silvio.cloud`. It serves prepared video assets and the catalogue, with directory listing disabled. It does not enable uploads or serve the NAS's original/private folders.

If Container Manager is unavailable, Web Station or another static server can serve the same folder. It must provide the same response types and browser access headers:

| File | Content-Type |
| --- | --- |
| `.json` | `application/json` |
| `.m3u8` | `application/vnd.apple.mpegurl` |
| `.m4s` | `video/iso.segment` |
| `.mp4` | `video/mp4` |

MP4 playback must support `Range` requests with `206 Partial Content`. Allow browser requests from `https://fit.silvio.cloud`. CORS is **not authentication**.

## Private access

The supplied static-server template does not authenticate users. If the footage must be private, protect the media endpoint with your chosen authentication layer before exposing it. The app can reuse an existing browser login session: enable **Use the server's existing login session**. This sends credentials on catalogue, HLS and MP4 requests; no NAS password is embedded in the app.

For cookie authentication, allow the exact app origin and `Access-Control-Allow-Credentials: true`. A media hostname under `silvio.cloud` is preferable for cookie compatibility with `fit.silvio.cloud`. Different-site NAS domains can encounter browser third-party-cookie restrictions. A bare DSM login cookie does not automatically protect a separate static server; authentication must actually be enforced at that media endpoint. Servers requiring a proprietary DSM download API or bearer-header-only authentication need a corresponding adapter.

## Encode on the home server

Requires Node 24+ and FFmpeg with `libx264`. HDR input uses FFmpeg `zscale`/`tonemap` support to produce SDR delivery renditions. Encoding is an offline job; the NAS serves pre-encoded files during workouts.

```
node scripts/encode-hls.mjs \
  --input "/mnt/nas/originals/forest-4k.mp4" \
  --id forest \
  --name "Quiet forest trek" \
  --kind Treadmill \
  --reference 5 \
  --author "Your name" \
  --source "https://your-source-page.example/forest" \
  --out "/srv/fit-exports" \
  --threads 8
```

`--reference` is the footage's recording speed in km/h; the app divides measured machine speed by this value. It can also be adjusted in Video options. Use `--loop` only when labelling a short looping clip; full recordings omit it. `--source` is the source/credit page, not a temporary download URL or a password-bearing URL.

The command reports its completed export directory. It generates 4-second fMP4 HLS segments, aligned keyframes, an adaptive master, a compatible MP4 fallback, a poster and a local integrity receipt. Source hashing and output verification use streams, so a many-gigabyte input does not need to fit in RAM. Failed jobs never publish a partial catalogue.

## Publish into the NAS folder

Mount the dedicated media share on the encoding server, verify that it is mounted, then publish the export:

```
node scripts/publish-nas.mjs \
  "/srv/fit-exports/forest-<version>" \
  --root "/mnt/nas/fit-media"
```

The publisher validates SHA-256 hashes, copies only prepared files, verifies the destination and publishes `catalog.json` last using an atomic rename. Existing versioned assets are reused only if they match; existing scenes are preserved. A filesystem lock prevents concurrent publishers from replacing one another's catalogue updates. On a failed/interrupted publish, inspect `.publish-lock` and ensure no publisher is running before removing a stale lock. A new catalogue is loaded when the app reloads.

## Connect the app

1. Open **Settings → Video server**.
2. Enter the HTTPS folder URL containing `catalog.json`.
3. Enable the existing-login-session option only if required by the endpoint.
4. Select **Save & test**.

The app validates the catalogue and stores the server setting locally on that device. Configuration changes are disabled during an active workout. New scenes appear without rebuilding the frontend. The video's own HLS paths are relative to its manifest; the publisher uses the same format for NAS and optional R2 hosting.

Quality defaults to Automatic. **Video options → Video quality** exposes available source resolutions, including 2160p/4K when present. Playback speed and the immersive Follow machine / Automatic equipment-control selector continue to work independently of storage location. Hosted footage requires a working connection; local-file playback remains available for offline use.

## Verification in this workspace

`npm run test:nas` starts a separate, cookie-protected local media server to exercise real cross-origin requests. It checks direct HLS delivery, quality changes, device-speed sync, actual 3840×2160 decoding using a local-only generated fixture, saved server configuration and authenticated MP4 byte-range fallback. This is a protocol integration test, not a claim that your actual Synology hostname, TLS certificate or authentication has already been configured. The generated QA fixture is not deployed as scenery.

## Simple public video list

The app also loads `https://videos.fit.silvio.cloud/info.json` on startup:

```json
{
  "videos": [
    {
      "file": "video.webm",
      "name": "Forest walk",
      "referenceSpeed": 5,
      "skipSeconds": 30,
      "deviceTypes": ["Treadmill", "Bike", "Rower"]
    }
  ]
}
```

`file` resolves against that hostname and supports `.webm` and `.mp4`. `referenceSpeed` defaults to 5 km/h, `skipSeconds` to 30 seconds; zero skips nothing. Files must remain on that hostname. The catalogue determines scene names, equipment filters, speed references and loop start positions. Device-local reference-speed adjustments take precedence for that scene. Short videos whose duration is less than the requested skip plus one second start at zero. Fades remain enabled for NAS scenes.

Only the JSON is fetched through `/api/video-info` on the app's Worker, allowing this small file to work without cross-origin JSON headers. Video requests remain direct to the NAS. The response may be cached for 60 seconds; reload the app to load changed entries. An invalid/unavailable file keeps the working default library. Phone-file playback and starter fallback clips remain available. Publish edits by replacing the complete JSON file atomically to avoid serving partial updates.
