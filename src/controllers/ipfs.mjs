import {devLog} from "../utils/debug.mjs";
import itToStream from 'it-to-stream';
import {unixFS} from "./ipfs_helia.mjs";


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
 * @param ipfsOptions{{stream:boolean,start?:number,end?: number}}
 * @return {Promise<*>}
 */
export async function generateDataFromCid(
    cid,
    ipfsOptions
) {
    devLog('____start fetch cid content with ipfs_______');
    const results = await unixFS.cat(cid, {
        offset: (ipfsOptions && ipfsOptions.start) ? ipfsOptions.start : undefined,
        length: (ipfsOptions && ipfsOptions.end) ? ipfsOptions.end : undefined,
        timeout: 1000 * 60 * 5,
    });
    devLog('____cid content found with ipfs______');
    if (ipfsOptions?.stream === true) {
        return itToStream.readable(results);
    } else {
        let buffer = Buffer.alloc(0);
        for await (const chunk of results) {
            buffer = Buffer.concat([buffer, chunk]);
        }
        return buffer;
    }
}

/**
 *
 * @param cid {string}
 * @return {Promise<boolean>}
 */
export async function checkIfWeHaveCidInWeb3(
    cid,
) {
    return true;
}