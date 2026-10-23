import {readdir, stat, statfs} from "node:fs/promises";
import {join} from "node:path";
import {StatusCodes} from "http-status-codes";
import {CID} from "multiformats/cid";
import {accessPolicy, authorize, getUntokenedWriteStats} from "./auth.mjs";
import {blockstore, unixFS} from "./ipfs_helia.mjs";
import {getDagRootInfo, listDagIndexedFiles, listDagLog, rebuildDagIndexFromStore} from "./dag_index.mjs";
import {blockstoreDir, metaDir} from "../utils/paths.mjs";

const guard = () => authorize({roles: ["admin"], scopes: ["admin:datastore"]});

async function walkBlocks(dir, acc) {
    for (const entry of await readdir(dir, {withFileTypes: true})) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (path !== metaDir) {
                await walkBlocks(path, acc);
            }
        } else if (entry.name.endsWith(".data")) {
            acc.blocks++;
            acc.bytes += (await stat(path)).size;
        }
    }
}

async function readStats() {
    const acc = {blocks: 0, bytes: 0};
    await walkBlocks(blockstoreDir, acc).catch(() => undefined);
    const dag = await getDagRootInfo();
    const files = await listDagIndexedFiles();
    const disk = await statfs(blockstoreDir).catch(() => undefined);
    return {
        blockstoreDir,
        metaDir,
        namespace: dag.namespace,
        headCid: dag.rootCid,
        updatedAt: dag.updatedAt,
        indexedFiles: dag.count,
        indexedBytes: files.reduce((n, f) => n + (f.size || 0), 0),
        blocks: acc.blocks,
        blockBytes: acc.bytes,
        diskFreeBytes: disk ? disk.bavail * disk.bsize : undefined,
        diskTotalBytes: disk ? disk.blocks * disk.bsize : undefined,
        policy: accessPolicy(),
        untokenedWrites: getUntokenedWriteStats()
    };
}

async function verifyFiles() {
    const files = await listDagIndexedFiles();
    const results = [];
    for (const f of files) {
        let status = "ok";
        let detail;
        try {
            const cid = CID.parse(f.cid);
            if (!await blockstore.has(cid)) {
                status = "missing";
            } else {
                const s = await unixFS.stat(cid, {offline: true, signal: AbortSignal.timeout(10000)});
                const total = s.fileSize ?? s.size ?? 0n;
                if ((s.localFileSize ?? total) < total) {
                    status = "partial";
                } else if (f.size && Number(total) !== f.size) {
                    status = "size-mismatch";
                    detail = `index ${f.size}, store ${total}`;
                }
            }
        } catch (e) {
            status = "error";
            detail = `${e?.message ?? e}`;
        }
        results.push({cid: f.cid, name: f.name, size: f.size, status, detail});
    }
    return {
        checked: results.length,
        problems: results.filter(r => r.status !== "ok"),
        ok: results.filter(r => r.status === "ok").length
    };
}

function json(handler) {
    return [guard(), async (request, response) => {
        try {
            response.set({"Cache-Control": "no-store"});
            response.status(StatusCodes.OK).json(await handler(request));
        } catch (e) {
            response.status(StatusCodes.INTERNAL_SERVER_ERROR).json({message: `${e?.message ?? e}`});
        }
    }];
}

export const storeStats = () => json(readStats);
export const storeLog = () => json(request => listDagLog(Math.min(500, Number(request.query?.limit ?? 100))));
export const storeVerify = () => json(verifyFiles);
export const storeRebuildIndex = () => json(rebuildDagIndexFromStore);
