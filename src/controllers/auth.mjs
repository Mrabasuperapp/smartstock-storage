import {createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as signData, timingSafeEqual, verify as verifySig} from "node:crypto";
import {mkdir, readFile, stat, writeFile} from "node:fs/promises";
import {dirname, join} from "node:path";
import {StatusCodes} from "http-status-codes";
import {metaDir} from "../utils/paths.mjs";
import {loginPageHtml} from "./ui.mjs";
import {checkApiToken, listApiTokens, registerApiToken, revokeApiToken} from "./tokens.mjs";

const issuer = process.env.AUTH_ISSUER || "smartstock-storage";
const audience = process.env.AUTH_AUDIENCE || "smartstock-storage-api";
const tokenTtlSec = Number(process.env.AUTH_TOKEN_TTL_SEC || 60 * 60);
const keyDir = process.env.AUTH_KEY_DIR || join(metaDir, "keys");
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
        ...(payload?.jti ? {typ: "api", jti: payload.jti} : {exp: now + tokenTtlSec}),
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
    const isApiToken = claims?.typ === "api" && !!claims?.jti;
    if (!isApiToken && Number(claims?.exp || 0) <= now) {
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

            if (claims?.typ === "api" && !await checkApiToken(`${claims.jti}`)) {
                unauthorizedResponse(request, response, "Token revoked");
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

const flag = (name, fallback) => {
    const raw = `${process.env[name] ?? ""}`.trim().toLowerCase();
    return raw ? ["1", "true", "yes", "on"].includes(raw) : fallback;
};

/** Compatibility switches so servers that do not send tokens yet keep working while they are migrated. */
export const accessPolicy = () => ({
    requireWriteToken: flag("STORAGE_REQUIRE_WRITE_TOKEN", false),
    publicRead: flag("STORAGE_PUBLIC_READ", true)
});

const untokened = {writes: 0, lastAt: undefined, lastReason: undefined};
export const getUntokenedWriteStats = () => ({...untokened});

async function tokenIsValid(request) {
    const token = extractTokenFromRequest(request);
    if (!token) {
        return {ok: false, reason: "no-token"};
    }
    try {
        await ensureKeyPairLoaded();
        const claims = verifyJwt(token);
        if (claims?.typ === "api" && !await checkApiToken(`${claims.jti}`)) {
            return {ok: false, reason: "token-revoked"};
        }
        return {ok: true};
    } catch (e) {
        return {ok: false, reason: `${e?.message || "invalid-token"}`};
    }
}

/**
 * Like authorize(), but when `isRequired()` is false a missing or invalid token is let through.
 * Valid tokens are always checked for role and scope. With `logWrites` each unauthenticated request is logged.
 */
export function authorizeUnlessOptional({roles = [], scopes = [], isRequired, logWrites = false} = {}) {
    const strict = authorize({roles, scopes});
    return async (request, response, next) => {
        if (isRequired()) {
            return strict(request, response, next);
        }
        const check = await tokenIsValid(request);
        if (check.ok) {
            return strict(request, response, next);
        }
        if (logWrites) {
            untokened.writes++;
            untokened.lastAt = new Date().toISOString();
            untokened.lastReason = check.reason;
            const ip = request.headers?.["x-forwarded-for"] ?? request.socket?.remoteAddress ?? "-";
            console.warn(`[zebra:untokened-write] reason=${check.reason} ${request.method} ${request.originalUrl ?? request.url} ip=${ip} ua=${JSON.stringify(request.headers?.["user-agent"] ?? "-")} origin=${request.headers?.origin ?? request.headers?.referer ?? "-"}`);
        }
        request.auth = {sub: "anonymous", roles: [], scopes: [], anonymous: true};
        next?.();
    };
}

export const authorizeWrite = () => authorizeUnlessOptional({
    roles: ["admin", "uploader", "service"],
    scopes: ["storage:write"],
    isRequired: () => accessPolicy().requireWriteToken,
    logWrites: true
});

export const authorizeRead = () => authorizeUnlessOptional({
    roles: ["admin", "reader", "uploader", "service"],
    scopes: ["storage:read"],
    isRequired: () => !accessPolicy().publicRead
});

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
            response.end(loginPageHtml());
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

const adminOnly = () => authorize({roles: ["admin"], scopes: ["admin:dashboard"]});

/** Mints a write token that never expires; it works until an admin revokes it. */
export function authIssueWriteToken() {
    return [
        adminOnly(),
        async (request, response) => {
            try {
                const body = await parseJsonBody(request);
                const label = `${body?.label || "uploader"}`.trim().replace(/[^\w .-]/g, "").slice(0, 40) || "uploader";
                const scopes = body?.access === "read-write" ? ["storage:read", "storage:write"] : ["storage:write"];
                const record = await registerApiToken({label, scopes, createdBy: request.auth?.sub});
                const token = buildJwt({sub: `token:${label}`, roles: ["uploader"], scopes, jti: record.id});
                response.status(StatusCodes.OK).json({tokenType: "Bearer", accessToken: token, token: record});
            } catch (e) {
                response.status(StatusCodes.BAD_REQUEST).json({message: e?.toString()});
            }
        }
    ];
}

export function authListTokens() {
    return [adminOnly(), async (_, response) => {
        response.set({"Cache-Control": "no-store"});
        response.status(StatusCodes.OK).json(await listApiTokens());
    }];
}

export function authRevokeToken() {
    return [adminOnly(), async (request, response) => {
        const record = await revokeApiToken(`${request.params?.id ?? ""}`);
        if (!record) {
            response.status(StatusCodes.NOT_FOUND).json({message: "Token not found"});
            return;
        }
        response.status(StatusCodes.OK).json(record);
    }];
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
