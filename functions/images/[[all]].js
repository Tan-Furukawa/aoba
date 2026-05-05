export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const key = decodeURIComponent(url.pathname.replace(/^\/images\/?/, ""));

  if (!key) {
    return new Response("Not found", { status: 404 });
  }

  const object = await context.env.BUCKET.get(key);

  if (!object) {
    return new Response("Not found", { status: 404 });
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");

  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/octet-stream");
  }

  return new Response(object.body, { headers });
}
