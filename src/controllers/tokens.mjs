import {randomUUID} from "node:crypto";
import {mkdir, readFile, rename, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {metaDir} from "../utils/paths.mjs";

const registryPath = join(metaDir, "tokens.json");
const LAST_USED_FLUSH_MS = 60_000;

let records;
let queue = Promise.resolve();

async function load() {
    if (records) {
        return records;
    }
    try {
        const parsed = JSON.parse(await readFile(registryPath, "utf8"));
        records = Array.isArray(parsed?.tokens) ? parsed.tokens : [];
    } catch (_) {
        records = [];
    }
    return records;
}

async function save() {
    await mkdir(metaDir, {recursive: true});
    const tmp = `${registryPath}.tmp`;
    await writeFile(tmp, JSON.stringify({tokens: records}, null, 2), "utf8");
    await rename(tmp, registryPath);
}

function exclusive(fn) {
    const run = queue.then(async () => {
        await load();
        return fn();
    });
    queue = run.catch(() => undefined);
    return run;
}

const view = r => ({id: r.id, label: r.label, scopes: r.scopes, createdAt: r.createdAt, createdBy: r.createdBy, lastUsedAt: r.lastUsedAt, revokedAt: r.revokedAt});

export function registerApiToken({label, scopes, createdBy}) {
    return exclusive(async () => {
        const record = {id: randomUUID(), label, scopes, createdBy, createdAt: new Date().toISOString()};
        records.unshift(record);
        await save();
        return view(record);
    });
}

export function revokeApiToken(id) {
    return exclusive(async () => {
        const record = records.find(r => r.id === id);
        if (!record) {
            return undefined;
        }
        record.revokedAt ??= new Date().toISOString();
        await save();
        return view(record);
    });
}

export function listApiTokens() {
    return exclusive(async () => records.map(view));
}

/** True while the token exists and has not been revoked; records last use at most once a minute. */
export function checkApiToken(id) {
    return exclusive(async () => {
        const record = records.find(r => r.id === id);
        if (!record || record.revokedAt) {
            return false;
        }
        const last = record.lastUsedAt ? Date.parse(record.lastUsedAt) : 0;
        if (Date.now() - last > LAST_USED_FLUSH_MS) {
            record.lastUsedAt = new Date().toISOString();
            await save();
        }
        return true;
    });
}
