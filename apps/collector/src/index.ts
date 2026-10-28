/** Deliberately disabled until secure sources and storage exist. */
export default { async fetch(request: Request): Promise<Response> { if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/batch") return new Response("Not found", { status: 404 }); return Response.json({ error: "not_configured" }, { status: 503 }); } };
