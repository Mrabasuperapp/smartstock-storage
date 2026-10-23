import {readFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {authorize} from "./auth.mjs";

const uiDir = join(dirname(fileURLToPath(import.meta.url)), "..", "ui");
const isProd = `${process.env.NODE_ENV ?? ""}`.toLowerCase() === "production";
const cache = new Map();

function readUi(name) {
    if (isProd && cache.has(name)) {
        return cache.get(name);
    }
    const content = readFileSync(join(uiDir, name), "utf8");
    cache.set(name, content);
    return content;
}

function serve(name, contentType, cacheControl) {
    return (_, response) => {
        response.writeHead(200, {"content-type": `${contentType}; charset=utf-8`, "cache-control": cacheControl});
        response.end(readUi(name));
    };
}

const assetCache = isProd ? "public, max-age=3600" : "no-store";
export const uiCss = () => [serve("console.css", "text/css", assetCache)];
export const uiThemeJs = () => [serve("theme.js", "text/javascript", assetCache)];
export const uiJs = () => [serve("console.js", "text/javascript", assetCache)];
export const uiLandingJs = () => [serve("landing.js", "text/javascript", assetCache)];
export const landingPage = () => [serve("landing.html", "text/html", "no-store")];
export const loginPageHtml = () => readUi("login.html");

export function consolePage() {
    return [
        authorize({roles: ["admin"], scopes: ["admin:dashboard"]}),
        serve("console.html", "text/html", "no-store")
    ];
}
