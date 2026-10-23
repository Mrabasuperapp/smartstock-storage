import {metaDir} from "../utils/paths.mjs";
import {mkdir, readFile, rm, writeFile} from "node:fs/promises";
import {dirname, join} from "node:path";
import {CID} from "multiformats/cid";
import {sha256} from "multiformats/hashes/sha2";
import * as dagCbor from "@ipld/dag-cbor";
import * as dagJson from "@ipld/dag-json";
import {blockstore} from "./ipfs_helia.mjs";

const dagRootPointerPath = join(metaDir, "helia-storage-root.cid");
const dagRootSnapshotPath = join(metaDir, "helia-storage-root.snapshot.json");
const LEGACY_ROOT_NAME = "storage-root";
const NAMESPACE = `${process.env.STORAGE_NAMESPACE || "smartstock-storage"}`;
const LOG_VERSION = 2;

function safeIsoDate(value) {
    try {
        if (!value) {
            return new Date().toISOString();
        }
        return new Date(value).toISOString();
    } catch (_) {
        return new Date().toISOString();
    }
}

function normalizeRecord(record) {
    const cid = `${record?.cid ?? ""}`.trim();
    const name = `${record?.name ?? ""}`.trim();
    if (!cid || !name) {
        return undefined;
    }
    const size = Number.isFinite(Number(record?.size)) ? Number(record.size) : 0;
    const type = `${record?.type ?? "application/octet-stream"}`.trim() || "application/octet-stream";
    const createdAt = safeIsoDate(record?.createdAt);
    const url = `${record?.url ?? `/storage/${encodeURIComponent(cid)}/${encodeURIComponent(name)}`}`;
    return {cid, name, size, type, createdAt, url};
}

function normalizeAll(records) {
    const byKey = new Map();
    for (const item of Array.isArray(records) ? records : []) {
        const normalized = normalizeRecord(item);
        if (!normalized) {
            continue;
        }
        byKey.set(`${normalized.cid}::${normalized.name}`, normalized);
    }
    return Array.from(byKey.values())
        .sort((a, b) => `${b.createdAt}`.localeCompare(`${a.createdAt}`));
}

async function ensureRootPointerDir() {
    await mkdir(dirname(dagRootPointerPath), {recursive: true});
}

async function readRootPointerCid() {
    await ensureRootPointerDir();
    try {
        const raw = await readFile(dagRootPointerPath, "utf8");
        const clean = `${raw ?? ""}`.trim();
        return clean || undefined;
    } catch (_) {
        return undefined;
    }
}

async function writeRootPointerCid(cid) {
    await ensureRootPointerDir();
    await writeFile(dagRootPointerPath, `${cid}`, "utf8");
}

async function writeSnapshot(payload) {
    await ensureRootPointerDir();
    await writeFile(dagRootSnapshotPath, JSON.stringify(payload, null, 2), "utf8");
}

async function readSnapshot() {
    await ensureRootPointerDir();
    try {
        const raw = await readFile(dagRootSnapshotPath, "utf8");
        const parsed = JSON.parse(raw || "{}");
        return {
            rootCid: `${parsed?.rootCid ?? ""}`.trim() || undefined,
            files: normalizeAll(parsed?.files ?? [])
        };
    } catch (_) {
        return {rootCid: undefined, files: []};
    }
}


/**
 * The index is an append-only log of dag-json entries stored in the same blockstore as the file data.
 * Every entry carries the namespace, links to the previous entry (`prev`) and, for additions, to the
 * file content (`content`), so the whole index can be rebuilt from the blockstore alone.
 */
async function writeDagNode(node) {
    const bytes = dagJson.encode(node);
    const hash = await sha256.digest(bytes);
    const cid = CID.createV1(dagJson.code, hash);
    await blockstore.put(cid, bytes);
    return cid;
}

async function readNode(cid) {
    const raw = await blockstore.get(cid);
    const bytes = raw instanceof Uint8Array ? raw : Buffer.concat(await Array.fromAsync(raw));
    return cid.code === dagCbor.code ? dagCbor.decode(bytes) : dagJson.decode(bytes);
}

function isLogEntry(node) {
    return node?.namespace === NAMESPACE && node?.version === LOG_VERSION;
}

function recordFromNode(file) {
    return normalizeRecord({...file, cid: file?.content?.toString?.() ?? file?.cid});
}

function recordToNode(record) {
    const {cid, ...rest} = record;
    return {...rest, content: CID.parse(cid)};
}

async function appendEntry(entry, prevCid) {
    return writeDagNode({
        namespace: NAMESPACE,
        version: LOG_VERSION,
        at: new Date().toISOString(),
        prev: prevCid ?? null,
        ...entry
    });
}

function applyEntry(byKey, entry) {
    if (entry.op === "snapshot") {
        byKey.clear();
        for (const f of entry.files ?? []) {
            const r = recordFromNode(f);
            r && byKey.set(`${r.cid}::${r.name}`, r);
        }
    } else if (entry.op === "add") {
        const r = recordFromNode(entry.file);
        r && byKey.set(`${r.cid}::${r.name}`, r);
    } else if (entry.op === "remove") {
        const cid = entry.content?.toString?.();
        for (const [k, v] of byKey) {
            if (v.cid === cid) {
                byKey.delete(k);
            }
        }
    }
}

async function foldLog(headCid) {
    const entries = [];
    let cursor = headCid;
    while (cursor) {
        const node = await readNode(cursor);
        if (!isLogEntry(node)) {
            break;
        }
        entries.push(node);
        if (node.op === "snapshot") {
            break;
        }
        cursor = node.prev;
    }
    const byKey = new Map();
    for (const entry of entries.reverse()) {
        applyEntry(byKey, entry);
    }
    return {files: normalizeAll(Array.from(byKey.values())), at: entries.at(-1)?.at};
}

async function scanForHead() {
    const all = new Map();
    const referenced = new Set();
    try {
        // the blockstore keeps only the multihash, so the codec is gone: sniff for a json object instead
        for await (const {cid: stored, bytes} of blockstore.getAll()) {
            let first;
            for await (const chunk of bytes) {
                first = chunk[0];
                break;
            }
            if (first !== 0x7b) {
                continue;
            }
            try {
                const cid = CID.createV1(dagJson.code, stored.multihash);
                const node = await readNode(cid);
                if (isLogEntry(node)) {
                    all.set(cid.toString(), {cid, at: node.at});
                    node.prev && referenced.add(node.prev.toString());
                }
            } catch (_) {
            }
        }
    } catch (_) {
        // blockstore directory does not exist yet
    }
    const heads = Array.from(all.values()).filter(x => !referenced.has(x.cid.toString()));
    heads.sort((a, b) => `${b.at}`.localeCompare(`${a.at}`));
    return heads[0]?.cid;
}

let state;
let queue = Promise.resolve();

async function pointerHead() {
    const raw = await readRootPointerCid();
    if (!raw) {
        return {};
    }
    try {
        const cid = CID.parse(raw);
        const node = await readNode(cid);
        if (isLogEntry(node)) {
            return {cid};
        }
        if (node?.name === LEGACY_ROOT_NAME) {
            return {legacyFiles: normalizeAll(node.files ?? [])};
        }
    } catch (_) {
    }
    return {};
}

async function persist(headCid, files) {
    await writeRootPointerCid(headCid.toString());
    await writeSnapshot({rootCid: headCid.toString(), namespace: NAMESPACE, updatedAt: new Date().toISOString(), files});
}

async function load() {
    if (state) {
        return state;
    }
    let {cid, legacyFiles} = await pointerHead();
    cid ??= await scanForHead();
    if (!cid) {
        legacyFiles ??= (await readSnapshot()).files;
        if (legacyFiles.length > 0) {
            cid = await appendEntry({op: "snapshot", files: legacyFiles.map(recordToNode)}, null);
            await persist(cid, legacyFiles);
        }
    }
    const {files, at} = cid ? await foldLog(cid) : {files: [], at: undefined};
    if (cid && cid.toString() !== (await readRootPointerCid())) {
        await persist(cid, files);
    }
    state = {head: cid, files, updatedAt: at};
    return state;
}

function mutate(fn) {
    const run = queue.then(async () => {
        const current = await load();
        const result = await fn(current);
        state = current;
        return result;
    });
    queue = run.catch(() => undefined);
    return run;
}

async function commit(current, entry, files) {
    const cid = await appendEntry(entry, current.head);
    current.head = cid;
    current.files = normalizeAll(files);
    current.updatedAt = new Date().toISOString();
    await persist(cid, current.files);
}

export async function listDagIndexedFiles() {
    await queue;
    return (await load()).files;
}

export async function addDagIndexedFile(record) {
    const normalized = normalizeRecord(record);
    if (!normalized) {
        return undefined;
    }
    return mutate(async current => {
        await commit(current, {op: "add", file: recordToNode(normalized)}, [normalized, ...current.files]);
        return current.files.find(x => x.cid === normalized.cid && x.name === normalized.name) ?? normalized;
    });
}

export async function findDagIndexedFileByCid(cid) {
    const cleanCid = `${cid ?? ""}`.trim();
    if (!cleanCid) {
        return undefined;
    }
    const files = await listDagIndexedFiles();
    return files.find(x => x.cid === cleanCid);
}

export async function removeDagIndexedFilesByCid(cid) {
    const cleanCid = `${cid ?? ""}`.trim();
    if (!cleanCid) {
        return {removed: 0, files: await listDagIndexedFiles()};
    }
    return mutate(async current => {
        const kept = current.files.filter(x => x.cid !== cleanCid);
        const removed = current.files.length - kept.length;
        if (removed > 0) {
            await commit(current, {op: "remove", content: CID.parse(cleanCid)}, kept);
        }
        return {removed, files: current.files};
    });
}

export async function replaceDagIndexFiles(records) {
    return mutate(async current => {
        const files = normalizeAll(records);
        await commit(current, {op: "snapshot", files: files.map(recordToNode)}, files);
        return {saved: current.files.length, rootCid: current.head.toString()};
    });
}

export async function getDagRootInfo() {
    await queue;
    const current = await load();
    return {
        rootCid: current.head?.toString(),
        name: NAMESPACE,
        namespace: NAMESPACE,
        version: LOG_VERSION,
        updatedAt: current.updatedAt,
        count: current.files.length
    };
}

export async function listDagLog(limit = 100) {
    await queue;
    const current = await load();
    const out = [];
    let cursor = current.head;
    while (cursor && out.length < limit) {
        const node = await readNode(cursor);
        if (!isLogEntry(node)) {
            break;
        }
        out.push({
            cid: cursor.toString(),
            op: node.op,
            at: node.at,
            name: node.file?.name,
            count: node.files?.length,
            content: (node.file?.content ?? node.content)?.toString?.()
        });
        cursor = node.prev;
    }
    return out;
}

/** Drops the cached head and pointer, then finds the newest log entry by scanning the blockstore. */
export async function rebuildDagIndexFromStore() {
    return mutate(async current => {
        await rm(dagRootPointerPath, {force: true});
        const head = await scanForHead();
        if (!head) {
            return {rebuilt: false, count: 0};
        }
        const {files, at} = await foldLog(head);
        current.head = head;
        current.files = files;
        current.updatedAt = at;
        await persist(head, files);
        return {rebuilt: true, rootCid: head.toString(), count: files.length};
    });
}
