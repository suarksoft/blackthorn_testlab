import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

const API_TARGET = process.env.API_TARGET ?? "http://127.0.0.1:8080";

function buildTargetUrl(pathSegments: string[], request: NextRequest): URL {
  const incomingUrl = new URL(request.url);
  const targetPath = pathSegments.join("/");
  const upstreamUrl = new URL(`${API_TARGET.replace(/\/$/, "")}/${targetPath}`);
  upstreamUrl.search = incomingUrl.search;
  return upstreamUrl;
}

async function proxyToApi(request: NextRequest, pathSegments: string[]) {
  const upstreamUrl = buildTargetUrl(pathSegments, request);
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("content-length");

  const method = request.method.toUpperCase();
  const body = method === "GET" || method === "HEAD" ? undefined : await request.arrayBuffer();

  const upstreamResponse = await fetch(upstreamUrl, {
    method,
    headers,
    body,
    redirect: "manual",
  });

  const responseHeaders = new Headers(upstreamResponse.headers);
  responseHeaders.delete("content-encoding");

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders,
  });
}

type RouteContext = {
  params: Promise<{ path: string[] }>;
};

export async function GET(request: NextRequest, context: RouteContext) {
  const { path } = await context.params;
  return proxyToApi(request, path);
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { path } = await context.params;
  return proxyToApi(request, path);
}

export async function PUT(request: NextRequest, context: RouteContext) {
  const { path } = await context.params;
  return proxyToApi(request, path);
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const { path } = await context.params;
  return proxyToApi(request, path);
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const { path } = await context.params;
  return proxyToApi(request, path);
}

export async function OPTIONS(request: NextRequest, context: RouteContext) {
  const { path } = await context.params;
  return proxyToApi(request, path);
}
