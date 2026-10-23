import {metaDir} from "../utils/paths.mjs";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {dirname, join} from "node:path";

const storageIndexPath = join(metaDir, "storage-index.json");

function normalizeRecord(record) {
    const cid = `${record?.cid ?? ""}`.trim();
    const name = `${record?.name ?? ""}`.trim();
    if (!cid || !name) {
        return undefined;
    }
    const createdAt = record?.createdAt ? new Date(record.createdAt).toISOString() : new Date().toISOString();
    const size = Number.isFinite(Number(record?.size)) ? Number(record.size) : 0;
    const type = record?.type ? `${record.type}` : "application/octet-stream";
    const url = record?.url ? `${record.url}` : `/storage/${encodeURIComponent(cid)}/${encodeURIComponent(name)}`;
    return {cid, name, size, type, url, createdAt};
}

async function ensureIndexFile() {
    await mkdir(dirname(storageIndexPath), {recursive: true});
    try {
        await readFile(storageIndexPath, "utf8");
    } catch (_) {
        await writeFile(storageIndexPath, JSON.stringify({files: []}, null, 2), "utf8");
    }
}

export async function readStorageIndex() {
    await ensureIndexFile();
    const raw = await readFile(storageIndexPath, "utf8");
    const parsed = JSON.parse(raw || "{}");
    const files = Array.isArray(parsed?.files) ? parsed.files : [];
    return files.map(normalizeRecord).filter(Boolean);
}

async function writeStorageIndex(files) {
    await ensureIndexFile();
    const normalized = files.map(normalizeRecord).filter(Boolean);
    await writeFile(
        storageIndexPath,
        JSON.stringify({files: normalized, updatedAt: new Date().toISOString()}, null, 2),
        "utf8"
    );
    return normalized;
}

export async function addStorageRecord(record) {
    const normalized = normalizeRecord(record);
    if (!normalized) {
        return undefined;
    }
    const files = await readStorageIndex();
    const key = `${normalized.cid}::${normalized.name}`;
    const withoutExisting = files.filter(x => `${x.cid}::${x.name}` !== key);
    withoutExisting.unshift(normalized);
    await writeStorageIndex(withoutExisting);
    return normalized;
}

export async function removeStorageRecordByCid(cid) {
    const cleanCid = `${cid ?? ""}`.trim();
    if (!cleanCid) {
        return {removed: 0, files: await readStorageIndex()};
    }
    const files = await readStorageIndex();
    const kept = files.filter(x => x.cid !== cleanCid);
    const removed = files.length - kept.length;
    await writeStorageIndex(kept);
    return {removed, files: kept};
}

export async function importStorageRecords(records, mode = "merge") {
    const incoming = (Array.isArray(records) ? records : [])
        .map(normalizeRecord)
        .filter(Boolean);
    const existing = mode === "replace" ? [] : await readStorageIndex();
    const byKey = new Map();
    for (const item of [...existing, ...incoming]) {
        byKey.set(`${item.cid}::${item.name}`, item);
    }
    const merged = Array.from(byKey.values())
        .sort((a, b) => `${b.createdAt}`.localeCompare(`${a.createdAt}`));
    await writeStorageIndex(merged);
    return {saved: merged.length, imported: incoming.length};
}

export async function exportStorageRecords() {
    const files = await readStorageIndex();
    return {
        exportedAt: new Date().toISOString(),
        count: files.length,
        files
    };
}
