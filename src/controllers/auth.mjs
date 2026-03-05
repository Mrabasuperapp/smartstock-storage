import {createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as signData, timingSafeEqual, verify as verifySig} from "node:crypto";
import {mkdir, readFile, stat, writeFile} from "node:fs/promises";
import {dirname, join} from "node:path";
import {StatusCodes} from "http-status-codes";

const issuer = process.env.AUTH_ISSUER || "smartstock-storage";
const audience = process.env.AUTH_AUDIENCE || "smartstock-storage-api";
const tokenTtlSec = Number(process.env.AUTH_TOKEN_TTL_SEC || 60 * 60);
const keyDir = process.env.AUTH_KEY_DIR || join(process.cwd(), ".data", "keys");
const privateKeyPath = process.env.AUTH_PRIVATE_KEY_PATH || join(keyDir, "auth-private.pem");
const publicKeyPath = process.env.AUTH_PUBLIC_KEY_PATH || join(keyDir, "auth-public.pem");
const keyId = process.env.AUTH_KEY_ID || "storage-rs256-v1";
const cookieName = process.env.AUTH_COOKIE_NAME || "storage_access_token";

let signingKey;
let verificationKey;

function b64url(input) {
    return Buffer.from(input)
        .toString("base64")
        .replace(/=/g, "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_");
}

function b64urlJson(obj) {
    return b64url(JSON.stringify(obj));
}

function b64urlDecodeToString(input) {
    const normalized = `${input}`.replace(/-/g, "+").replace(/_/g, "/");
    const pad = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
    return Buffer.from(normalized + pad, "base64").toString("utf8");
}

async function ensureKeyPairLoaded() {
    if (signingKey && verificationKey) {
        return;
    }

    await mkdir(dirname(privateKeyPath), {recursive: true});

    const hasPrivate = await stat(privateKeyPath).then(() => true).catch(() => false);
    const hasPublic = await stat(publicKeyPath).then(() => true).catch(() => false);

    if (!hasPrivate || !hasPublic) {
        const generated = generateKeyPairSync("rsa", {
            modulusLength: 4096,
            privateKeyEncoding: {type: "pkcs8", format: "pem"},
            publicKeyEncoding: {type: "spki", format: "pem"}
        });

        if (!hasPrivate) {
            await writeFile(privateKeyPath, generated.privateKey, {encoding: "utf8", mode: 0o600});
        }
        if (!hasPublic) {
            await writeFile(publicKeyPath, generated.publicKey, {encoding: "utf8", mode: 0o644});
        }
    }

    const privatePem = await readFile(privateKeyPath, "utf8");
    const publicPem = await readFile(publicKeyPath, "utf8");
    signingKey = createPrivateKey(privatePem);
    verificationKey = createPublicKey(publicPem);
}

function parseCookies(request) {
    const raw = `${request.get("cookie") || ""}`;
    if (!raw) {
        return {};
    }
    const out = {};
    for (const part of raw.split(";")) {
        const [name, ...rest] = part.trim().split("=");
        if (!name) {
            continue;
        }
        out[name] = decodeURIComponent(rest.join("="));
    }
    return out;
}

function parseAuthorizationBearer(request) {
    const header = `${request.get("authorization") || ""}`.trim();
    if (!header) {
        return undefined;
    }
    const [scheme, token] = header.split(" ");
    if ((scheme || "").toLowerCase() !== "bearer" || !token) {
        return undefined;
    }
    return token.trim();
}

function extractTokenFromRequest(request) {
    const fromHeader = parseAuthorizationBearer(request);
    if (fromHeader) {
        return fromHeader;
    }
    const cookies = parseCookies(request);
    return cookies[cookieName];
}

function hashPlainPassword(password) {
    return createHash("sha256").update(`${password}`).digest("hex");
}

function parseUserConfig() {
    const configured = `${process.env.AUTH_USERS_JSON || ""}`.trim();
    if (!configured) {
        return [];
    }
    try {
        const parsed = JSON.parse(configured);
        return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
        return [];
    }
}

function safeEqual(a, b) {
    const x = Buffer.from(`${a}`);
    const y = Buffer.from(`${b}`);
    if (x.length !== y.length) {
        return false;
    }
    return timingSafeEqual(x, y);
}

function verifyPassword(user, password) {
    if (user?.passwordHash) {
        const candidate = hashPlainPassword(password);
        return safeEqual(candidate, user.passwordHash);
    }
    if (user?.password) {
        return safeEqual(user.password, `${password}`);
    }
    return false;
}

function normalizeUser(user) {
    const username = `${user?.username || ""}`.trim();
    if (!username) {
        return undefined;
    }
    const roles = Array.isArray(user?.roles) ? user.roles.map(x => `${x}`.trim()).filter(Boolean) : [];
    const scopes = Array.isArray(user?.scopes) ? user.scopes.map(x => `${x}`.trim()).filter(Boolean) : [];
    return {
        username,
        roles,
        scopes,
        password: user?.password,
        passwordHash: user?.passwordHash
    };
}

function authenticateUser(username, password) {
    const users = parseUserConfig().map(normalizeUser).filter(Boolean);
    const found = users.find(x => x.username === `${username || ""}`.trim());
    if (!found) {
        return undefined;
    }
    if (!verifyPassword(found, password)) {
        return undefined;
    }
    return found;
}

async function parseJsonBody(request) {
    if (request.body && typeof request.body === "object") {
        return request.body;
    }
    if (typeof request.body === "string") {
        return JSON.parse(request.body);
    }
    return await new Promise((resolve, reject) => {
        let raw = "";
        request.on("data", chunk => {
            raw += chunk;
        });
        request.on("end", () => {
            try {
                resolve(raw ? JSON.parse(raw) : {});
            } catch (e) {
                reject(e);
            }
        });
        request.on("error", reject);
    });
}

function buildJwt(payload) {
    const now = Math.floor(Date.now() / 1000);
    const header = {
        alg: "RS256",
        typ: "JWT",
        kid: keyId
    };
    const body = {
        iss: issuer,
        aud: payload?.aud || audience,
        iat: now,
        nbf: now,
        exp: now + tokenTtlSec,
        sub: payload.sub,
        roles: payload.roles || [],
        scopes: payload.scopes || []
    };

    const encodedHeader = b64urlJson(header);
    const encodedPayload = b64urlJson(body);
    const signingInput = `${encodedHeader}.${encodedPayload}`;
    const signature = signData("RSA-SHA256", Buffer.from(signingInput), signingKey);
    return `${signingInput}.${b64url(signature)}`;
}

function validateClaims(claims, expectedAudience) {
    const now = Math.floor(Date.now() / 1000);
    if (`${claims?.iss || ""}` !== issuer) {
        throw new Error("invalid-issuer");
    }
    if (`${claims?.aud || ""}` !== `${expectedAudience || audience}`) {
        throw new Error("invalid-audience");
    }
    if (!claims?.sub) {
        throw new Error("missing-subject");
    }
    if (Number(claims?.nbf || 0) > now) {
        throw new Error("token-not-active");
    }
    if (Number(claims?.exp || 0) <= now) {
        throw new Error("token-expired");
    }
}

function verifyJwt(token, expectedAudience) {
    const parts = `${token || ""}`.split(".");
    if (parts.length !== 3) {
        throw new Error("invalid-token-format");
    }
    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    const header = JSON.parse(b64urlDecodeToString(encodedHeader));
    if (header?.alg !== "RS256") {
        throw new Error("invalid-token-alg");
    }

    const signature = Buffer.from(
        encodedSignature.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - encodedSignature.length % 4) % 4),
        "base64"
    );
    const data = Buffer.from(`${encodedHeader}.${encodedPayload}`);
    const ok = verifySig("RSA-SHA256", data, verificationKey, signature);
    if (!ok) {
        throw new Error("invalid-signature");
    }

    const claims = JSON.parse(b64urlDecodeToString(encodedPayload));
    validateClaims(claims, expectedAudience);
    return claims;
}

function unauthorizedResponse(request, response, message = "Unauthorized") {
    const acceptsHtml = `${request.get("accept") || ""}`.toLowerCase().includes("text/html");
    if (acceptsHtml) {
        response.redirect?.("/auth/login");
        if (!response.headersSent) {
            response.status(StatusCodes.FOUND).set({Location: "/auth/login"}).end();
        }
        return;
    }
    response.status(StatusCodes.UNAUTHORIZED).json({message});
}

function forbiddenResponse(response, message = "Forbidden") {
    response.status(StatusCodes.FORBIDDEN).json({message});
}

export function authorize({roles = [], scopes = [], audience: expectedAudience} = {}) {
    return async (request, response, next) => {
        try {
            await ensureKeyPairLoaded();
            const token = extractTokenFromRequest(request);
            if (!token) {
                unauthorizedResponse(request, response, "Missing access token");
                return;
            }
            const claims = verifyJwt(token, expectedAudience);
            const claimRoles = Array.isArray(claims?.roles) ? claims.roles : [];
            const claimScopes = Array.isArray(claims?.scopes) ? claims.scopes : [];

            if (roles.length && !roles.some(role => claimRoles.includes(role))) {
                forbiddenResponse(response, "Missing required role");
                return;
            }
            if (scopes.length && !scopes.every(scope => claimScopes.includes(scope))) {
                forbiddenResponse(response, "Missing required scope");
                return;
            }

            request.auth = {
                sub: `${claims.sub}`,
                roles: claimRoles,
                scopes: claimScopes,
                token
            };
            next?.();
        } catch (e) {
            unauthorizedResponse(request, response, `${e?.message || "Unauthorized"}`);
        }
    };
}

function makeSessionCookie(token) {
    const maxAge = Math.max(60, tokenTtlSec);
    const secure = `${process.env.AUTH_COOKIE_SECURE || "auto"}`.toLowerCase();
    const shouldSecure = secure === "true" || (secure === "auto" && `${process.env.NODE_ENV || ""}` === "production");
    const parts = [
        `${cookieName}=${encodeURIComponent(token)}`,
        "HttpOnly",
        "Path=/",
        "SameSite=Strict",
        `Max-Age=${maxAge}`
    ];
    if (shouldSecure) {
        parts.push("Secure");
    }
    return parts.join("; ");
}

function clearSessionCookie() {
    return `${cookieName}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0`;
}

export function authLoginPage() {
    return [
        (_, response) => {
            response.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
            response.end(`<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Storage Login</title>
  <style>
    body{font-family:Segoe UI,Arial,sans-serif;background:#f3f5f8;display:grid;place-items:center;min-height:100vh;margin:0}
    .card{background:#fff;border:1px solid #d6dde8;border-radius:12px;padding:20px;width:min(420px,92vw);box-shadow:0 10px 30px rgba(17,24,39,.08)}
    h1{margin:0 0 14px;font-size:1.2rem}
    label{display:block;font-size:.88rem;color:#4b5563;margin:8px 0 4px}
    input{width:100%;padding:10px;border:1px solid #cbd5e1;border-radius:8px}
    button{margin-top:14px;width:100%;padding:10px;border:0;border-radius:8px;background:#0b6ef3;color:#fff;font-weight:600;cursor:pointer}
    .error{color:#b42318;min-height:20px;font-size:.86rem;margin-top:10px}
  </style>
</head>
<body>
  <form class="card" id="loginForm">
    <h1>Storage Admin Login</h1>
    <label for="username">Username</label>
    <input id="username" name="username" autocomplete="username" required />
    <label for="password">Password</label>
    <input id="password" type="password" name="password" autocomplete="current-password" required />
    <button type="submit">Sign In</button>
    <div class="error" id="error"></div>
  </form>
  <script>
    const form = document.getElementById("loginForm");
    const errorEl = document.getElementById("error");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      errorEl.textContent = "";
      const username = form.username.value;
      const password = form.password.value;
      const res = await fetch("/auth/session", {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({username, password})
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        errorEl.textContent = data.message || "Login failed";
        return;
      }
      window.location.href = "/admin/storage";
    });
  </script>
</body>
</html>`);
        }
    ];
}

export function authIssueToken() {
    return [
        async (request, response) => {
            try {
                await ensureKeyPairLoaded();
                const body = await parseJsonBody(request);
                const username = `${body?.username || ""}`.trim();
                const password = `${body?.password || ""}`;
                const user = authenticateUser(username, password);
                if (!user) {
                    const hasUsers = parseUserConfig().length > 0;
                    response.status(StatusCodes.UNAUTHORIZED).json({
                        message: hasUsers ? "Invalid credentials" : "No AUTH_USERS_JSON users configured"
                    });
                    return;
                }
                const token = buildJwt({sub: user.username, roles: user.roles, scopes: user.scopes, aud: body?.audience});
                response.status(StatusCodes.OK).json({
                    tokenType: "Bearer",
                    accessToken: token,
                    expiresIn: tokenTtlSec,
                    subject: user.username,
                    roles: user.roles,
                    scopes: user.scopes,
                    issuer,
                    audience: body?.audience || audience
                });
            } catch (e) {
                response.status(StatusCodes.BAD_REQUEST).json({message: e?.toString()});
            }
        }
    ];
}

export function authCreateSession() {
    return [
        async (request, response) => {
            try {
                await ensureKeyPairLoaded();
                const body = await parseJsonBody(request);
                const username = `${body?.username || ""}`.trim();
                const password = `${body?.password || ""}`;
                const user = authenticateUser(username, password);
                if (!user) {
                    const hasUsers = parseUserConfig().length > 0;
                    response.status(StatusCodes.UNAUTHORIZED).json({
                        message: hasUsers ? "Invalid credentials" : "No AUTH_USERS_JSON users configured"
                    });
                    return;
                }
                const token = buildJwt({sub: user.username, roles: user.roles, scopes: user.scopes});
                response.set({"Set-Cookie": makeSessionCookie(token)});
                response.status(StatusCodes.OK).json({
                    ok: true,
                    subject: user.username,
                    roles: user.roles,
                    scopes: user.scopes
                });
            } catch (e) {
                response.status(StatusCodes.BAD_REQUEST).json({message: e?.toString()});
            }
        }
    ];
}

export function authDestroySession() {
    return [
        (_, response) => {
            response.set({"Set-Cookie": clearSessionCookie()});
            response.status(StatusCodes.OK).json({ok: true});
        }
    ];
}

export function authWhoAmI() {
    return [
        authorize(),
        (request, response) => {
            response.status(StatusCodes.OK).json({
                subject: request.auth?.sub,
                roles: request.auth?.roles || [],
                scopes: request.auth?.scopes || []
            });
        }
    ];
}

export function authPublicKey() {
    return [
        async (_, response) => {
            await ensureKeyPairLoaded();
            const publicPem = await readFile(publicKeyPath, "utf8");
            response.set({'Content-Type': 'application/x-pem-file'});
            response.status(StatusCodes.OK).send(publicPem);
        }
    ];
}

export function getAuthConfigSummary() {
    return {
        issuer,
        audience,
        cookieName,
        tokenTtlSec,
        keyId,
        privateKeyPath,
        publicKeyPath
    };
}
