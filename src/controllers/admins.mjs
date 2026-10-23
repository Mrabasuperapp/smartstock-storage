import {mkdir, readFile, rename, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {metaDir} from "../utils/paths.mjs";

/**
 * Who may sign in to the console with Google.
 *  - ADMIN_EMAILS (env, comma separated) are the owners: always admins, cannot be removed from the console.
 *  - Everyone else is added or removed in the console and kept in <zebra-store>/_meta/admins.json.
 */
const registryPath = join(metaDir, "admins.json");
const EMAIL = /^[^\s@;:,]+@[^\s@;:,]+\.[^\s@;:,]+$/;

export const normalizeEmail = value => typeof value === "string" ? value.trim().toLowerCase() : "";
export const validEmail = value => EMAIL.test(value) && value.length <= 254;

const httpError = (status, message) => Object.assign(new Error(message), {status});

let records;
let queue = Promise.resolve();

const owners = () => new Set(`${process.env.ADMIN_EMAILS ?? ""}`.split(",").map(normalizeEmail).filter(validEmail));

async function load() {
    if (records) {
        return records;
    }
    try {
        const parsed = JSON.parse(await readFile(registryPath, "utf8"));
        records = Array.isArray(parsed?.admins) ? parsed.admins.filter(a => validEmail(normalizeEmail(a?.email))) : [];
    } catch (_) {
        records = [];
    }
    return records;
}

async function save() {
    await mkdir(metaDir, {recursive: true});
    const tmp = `${registryPath}.tmp`;
    await writeFile(tmp, JSON.stringify({admins: records}, null, 2), "utf8");
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

export function isAdminEmail(email) {
    const address = normalizeEmail(email);
    if (!validEmail(address)) {
        return Promise.resolve(false);
    }
    if (owners().has(address)) {
        return Promise.resolve(true);
    }
    return exclusive(async () => records.some(a => normalizeEmail(a.email) === address));
}

export function listAdmins() {
    return exclusive(async () => {
        const ownerList = [...owners()].map(email => ({email, owner: true}));
        const added = records
            .filter(a => !owners().has(normalizeEmail(a.email)))
            .map(a => ({email: normalizeEmail(a.email), owner: false, addedBy: a.addedBy, addedAt: a.addedAt}));
        return [...ownerList, ...added];
    });
}

export function addAdmin(email, addedBy) {
    const address = normalizeEmail(email);
    if (!validEmail(address)) {
        throw httpError(400, "Enter a valid Google email address");
    }
    return exclusive(async () => {
        if (owners().has(address) || records.some(a => normalizeEmail(a.email) === address)) {
            throw httpError(409, `${address} already has access`);
        }
        const record = {email: address, addedBy: normalizeEmail(addedBy) || undefined, addedAt: new Date().toISOString()};
        records.push(record);
        await save();
        return {...record, owner: false};
    });
}

export function removeAdmin(email, requestedBy) {
    const address = normalizeEmail(email);
    return exclusive(async () => {
        if (owners().has(address)) {
            throw httpError(400, `${address} is an owner set by ADMIN_EMAILS and can only be changed on the server`);
        }
        if (address === normalizeEmail(requestedBy)) {
            throw httpError(400, "You cannot remove your own access");
        }
        const index = records.findIndex(a => normalizeEmail(a.email) === address);
        if (index < 0) {
            return false;
        }
        records.splice(index, 1);
        await save();
        return true;
    });
}
