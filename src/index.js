addEventListener("fetch", (event) => {
  event.passThroughOnException();
  event.respondWith(handleRequest(event.request));
});

const DOCKER_HUB = "https://registry-1.docker.io";

const routes = {
  "docker.letscloud.net": DOCKER_HUB,
  // "quay.eastcoal.tech": "https://quay.io",
  // "gcr.eastcoal.tech": "https://gcr.io",
  // "k8s-gcr.eastcoal.tech": "https://k8s.gcr.io",
  // "k8s.eastcoal.tech": "https://registry.k8s.io",
  // "ghcr.eastcoal.tech": "https://ghcr.io",
  // "cloudsmith.eastcoal.tech": "https://docker.cloudsmith.io",
};

async function handleRequest(request) {
  const handler = new RequestHandler(request)
  return handler.start()
}

const AUTHORIZE_PATH = "/v2/auth";

class RequestHandler {
  request;
  url;
  upstream;
  constructor(request) {
    this.request = request;
    this.url = new URL(request.url)
    this.upstream = getUpstream(this.url.hostname)
    if (!this.upstream) {
      throw new Error('未找到映射的 upstream 配置项')
    }
  }

  get isDockerHub() {
    this.upstream === DOCKER_HUB;
  }

  start() {
    if (this.url.pathname === AUTHORIZE_PATH) {
      return this.authorize()
    }
    // 处理默认的 library 命名空间
    // Example: /v2/busybox/manifests/latest => /v2/library/busybox/manifests/latest
    if (this.isDockerHub) {
      const pathParts = url.pathname.split("/");
      if (pathParts.length == 5) {
        pathParts.splice(2, 0, "library");
        const redirectUrl = new URL(url);
        redirectUrl.pathname = pathParts.join("/");
        return Response.redirect(redirectUrl, 301);
      }
    }
    // 代理原始请求
    return this.forwardRequest()
  }

  async forwardRequest() {
    const newUrl = new URL(this.upstream + this.url.pathname);
    const newReq = new Request(newUrl, {
      method: this.request.method,
      headers: this.request.headers,
      redirect: "follow",
    });
    const resp = await fetch(newReq);
    if (resp.status === 401) {
      const newResp = new Response(resp.body, resp);
      newResp.headers.set(
        "Www-Authenticate",
        `Bearer realm="${this.url.protocol}//${this.url.host}${AUTHORIZE_PATH}",service="cloudflare-docker-proxy"`
      );
      return newResp;
    }
    return resp;
  }

  async authorize() {
    const authorization = this.request.headers.get("Authorization");
    const newUrl = new URL(this.upstream + "/v2/");
    const resp = await fetch(newUrl, {
      method: "GET",
      redirect: "follow",
      headers: {
        Authorization: authorization
      }
    });
    if (resp.status !== 401) {
      return resp;
    }
    const authenticateStr = resp.headers.get("WWW-Authenticate");
    if (authenticateStr === null) {
      return resp;
    }
    const wwwAuthenticate = parseAuthenticate(authenticateStr);
    const scope = this.url.searchParams.get("scope");
    // autocomplete repo part into scope for DockerHub library images
    // Example: repository:busybox:pull => repository:library/busybox:pull
    return fetchToken(wwwAuthenticate, scope, authorization);
  }
}

function getUpstream(host) {
  if (host in routes) {
    return routes[host];
  }
  if (MODE == "debug") {
    return TARGET_UPSTREAM;
  }
  return "";
}

function parseAuthenticate(authenticateStr) {
  // sample: Bearer realm="https://auth.ipv6.docker.com/token",service="registry.docker.io"
  // match strings after =" and before "
  const re = /(?<=\=")(?:\\.|[^"\\])*(?=")/g;
  const matches = authenticateStr.match(re);
  if (matches == null || matches.length < 2) {
    throw new Error(`invalid Www-Authenticate Header: ${authenticateStr}`);
  }
  return {
    realm: matches[0],
    service: matches[1],
  };
}

async function fetchToken(wwwAuthenticate, scope, authorization) {
  const url = new URL(wwwAuthenticate.realm);
  if (wwwAuthenticate.service.length) {
    url.searchParams.set("service", wwwAuthenticate.service);
  }
  if (scope) {
    url.searchParams.set("scope", scope);
  }
  headers = new Headers();
  if (authorization) {
    headers.set("Authorization", authorization);
  }
  return await fetch(url, { method: "GET", headers: headers });
}

