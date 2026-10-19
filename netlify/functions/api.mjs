import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const serverless = require("serverless-http");
let handler;

export default async function api(request, context) {
  try {
    const url = new URL(request.url);
    const headers = Object.fromEntries(request.headers);
    const body = Buffer.from(await request.arrayBuffer());
    if (body.length > 100 * 1024) {
      return Response.json({ message: "資料過大" }, { status: 413, headers: { "Cache-Control": "no-store" } });
    }
    const event = {
      version: "2.0",
      rawPath: url.pathname.replace(/^\/\.netlify\/functions\/api(?=\/|$)/, "") || "/",
      rawQueryString: url.search.slice(1),
      headers,
      body: body.toString("base64"),
      isBase64Encoded: true,
      requestContext: {
        requestId: context.requestId,
        http: { method: request.method, sourceIp: context.ip },
      },
    };
    handler ||= serverless(require("../../server/app"), { binary: ["application/zip"] });
    const result = await handler(event, context);
    const responseHeaders = new Headers(result.headers);
    responseHeaders.set("Cache-Control", "no-store");
    for (const [name, values] of Object.entries(result.multiValueHeaders || {})) {
      for (const value of values) responseHeaders.append(name, value);
    }
    for (const cookie of result.cookies || []) responseHeaders.append("set-cookie", cookie);
    const responseBody = request.method === "HEAD" || [204, 205, 304].includes(result.statusCode)
      ? null
      : result.isBase64Encoded ? Buffer.from(result.body, "base64") : result.body;
    return new Response(responseBody, { status: result.statusCode, headers: responseHeaders });
  } catch (error) {
    console.error("API unavailable", { code: /^[A-Z0-9_]{1,40}$/.test(error.code || "") ? error.code : undefined });
    return Response.json(
      { message: "後端尚未完成設定，請確認 JWT_SECRET、雲端資料庫及 migration" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
