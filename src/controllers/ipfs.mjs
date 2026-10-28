import {devLog} from "../utils/debug.mjs";
import itToStream from 'it-to-stream';
import {blockstore, unixFS} from "./ipfs_helia.mjs";
import {CID} from "multiformats/cid";


/**
 *
 * @param x {{data: ReadableStream, type: string,size: *,name: string}}
 * @return {Promise<{cid: *}>}
 */
export async function generateCidFromDataStream(x) {
    const r = await unixFS.addByteStream(x?.data, {wrapWithDirectory: false});
    devLog('done save file to local ipfs with cid', r);
    return {
        cid: r?.toString() ?? ''
    }
}

/**
 *
 * @param x {{data: Buffer, type: string,size: *,name: string}}
 * @return {Promise<{cid: *}>}
 */
export async function generateCidFromBuffer(x) {
    const r = await unixFS.addBytes(x?.data, {wrapWithDirectory: false});
    devLog('done save file to local ipfs with cid', r);
    return {
        cid: r?.toString() ?? ''
    }
}

/**
 *
 * @param cid {*}
 * @param ipfsOptions{{stream:boolean,start?:number,end?: number}} start and end are inclusive byte offsets
 * @return {Promise<*>}
 */
export async function generateDataFromCid(
    cid,
    ipfsOptions
) {
    devLog('____start fetch cid content with ipfs_______');
    const results = await unixFS.cat(cid, {
        offset: ipfsOptions?.start,
        length: Number.isFinite(ipfsOptions?.end) ? ipfsOptions.end - (ipfsOptions.start ?? 0) + 1 : undefined,
        timeout: 1000 * 60 * 5,
    });
    devLog('____cid content found with ipfs______');
    if (ipfsOptions?.stream === true) {
        return itToStream.readable(results);
    } else {
        const chunks = [];
        let total = 0;
        for await (const chunk of results) {
            chunks.push(chunk);
            total += chunk?.length ?? 0;
        }
        return Buffer.concat(chunks, total);
    }
}

/**
 * @param cid {*}
 * @return {Promise<number>} size in bytes of the file content
 */
export async function getFileSizeFromCid(cid) {
    const stat = await unixFS.stat(typeof cid === "string" ? CID.parse(cid) : cid);
    return Number(stat.size);
}

/**
 *
 * @param cid {string}
 * @return {Promise<{deleted: boolean, reason?: string}>}
 */
export async function deleteDataFromCid(cid) {
    if (!cid) {
        return {deleted: false, reason: "missing cid"};
    }
    const parsed = CID.parse(`${cid}`);
    const exists = await blockstore.has(parsed);
    if (!exists) {
        return {deleted: false, reason: "cid-not-found"};
    }
    await blockstore.delete(parsed);
    return {deleted: true};
}

/**
 *
 * @param options {{limit?: number, offset?: number, includeSize?: boolean, cidQuery?: string}}
 * @return {Promise<{entries: Array<{cid: string, size?: number}>, total: number, truncated: boolean, limit: number, offset: number}>}
 */
export async function listDatastoreEntries(options = {}) {
    const limit = Number.isFinite(Number(options.limit)) ? Math.max(1, Number(options.limit)) : 500;
    const offset = Number.isFinite(Number(options.offset)) ? Math.max(0, Number(options.offset)) : 0;
    const includeSize = options.includeSize === true;
    const cidQuery = `${options.cidQuery ?? ""}`.trim().toLowerCase();
    const entries = [];
    let total = 0; // total matched
    let seenMatched = 0;
    let truncated = false;
    for await (const pair of blockstore.getAll()) {
        const cidStr = pair.cid.toString();
        if (cidQuery && !cidStr.toLowerCase().includes(cidQuery)) {
            continue;
        }
        total += 1;
        if (seenMatched++ < offset) {
            continue;
        }
        if (entries.length >= limit) {
            truncated = true;
            continue;
        }
        const item = {cid: cidStr};
        if (includeSize) {
            let size = 0;
            for await (const chunk of pair.bytes) {
                size += chunk?.length ?? 0;
            }
            item.size = size;
        }
        entries.push(item);
    }
    return {entries, total, truncated, limit, offset};
}
