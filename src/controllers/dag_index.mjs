import {mkdir, readFile, writeFile} from "node:fs/promises";
import {dirname, join} from "node:path";
import {CID} from "multiformats/cid";
import {sha256} from "multiformats/hashes/sha2";
import * as dagCbor from "@ipld/dag-cbor";
import {blockstore} from "./ipfs_helia.mjs";

const dagRootPointerPath = join(process.cwd(), ".data", "helia-storage-root.cid");
const dagRootSnapshotPath = join(process.cwd(), ".data", "helia-storage-root.snapshot.json");
const ROOT_NAME = "storage-root";
const ROOT_VERSION = 1;

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

async function writeDagNode(node) {
    const bytes = dagCbor.encode(node);
    const hash = await sha256.digest(bytes);
    const cid = CID.createV1(dagCbor.code, hash);
    await blockstore.put(cid, bytes);
    return cid.toString();
}

async function readDagNode(cidString) {
    if (!cidString) {
        return undefined;
    }
    const cid = CID.parse(`${cidString}`);
    const bytes = await blockstore.get(cid);
    return dagCbor.decode(bytes);
}

function buildRootNode(files) {
    return {
        name: ROOT_NAME,
        version: ROOT_VERSION,
        updatedAt: new Date().toISOString(),
        files: normalizeAll(files)
    };
}

async function readCurrentRootNode() {
    const rootCid = await readRootPointerCid();
    if (!rootCid) {
        const snap = await readSnapshot();
        if (snap.files.length > 0) {
            return {rootCid: snap.rootCid, root: buildRootNode(snap.files)};
        }
        return {rootCid: undefined, root: buildRootNode([])};
    }
    try {
        const root = await readDagNode(rootCid);
        const files = normalizeAll(root?.files ?? []);
        return {rootCid, root: buildRootNode(files)};
    } catch (_) {
        const snap = await readSnapshot();
        if (snap.files.length > 0) {
            return {rootCid: snap.rootCid ?? rootCid, root: buildRootNode(snap.files)};
        }
        return {rootCid: undefined, root: buildRootNode([])};
    }
}

async function saveRootFiles(files) {
    const root = buildRootNode(files);
    const cid = await writeDagNode(root);
    await writeRootPointerCid(cid);
    await writeSnapshot({
        rootCid: cid,
        updatedAt: root.updatedAt,
        files: root.files
    });
    return {rootCid: cid, files: root.files};
}

export async function listDagIndexedFiles() {
    const {root} = await readCurrentRootNode();
    return root.files;
}

export async function addDagIndexedFile(record) {
    const normalized = normalizeRecord(record);
    if (!normalized) {
        return undefined;
    }
    const {root} = await readCurrentRootNode();
    const merged = [normalized, ...(root.files ?? [])];
    const {files} = await saveRootFiles(merged);
    return files.find(x => x.cid === normalized.cid && x.name === normalized.name) ?? normalized;
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
    const files = await listDagIndexedFiles();
    if (!cleanCid) {
        return {removed: 0, files};
    }
    const kept = files.filter(x => x.cid !== cleanCid);
    const removed = files.length - kept.length;
    await saveRootFiles(kept);
    return {removed, files: kept};
}

export async function replaceDagIndexFiles(records) {
    const {files, rootCid} = await saveRootFiles(records);
    return {saved: files.length, rootCid};
}

export async function getDagRootInfo() {
    const {rootCid, root} = await readCurrentRootNode();
    return {
        rootCid,
        name: root?.name ?? ROOT_NAME,
        version: root?.version ?? ROOT_VERSION,
        updatedAt: root?.updatedAt,
        count: Array.isArray(root?.files) ? root.files.length : 0
    };
}
