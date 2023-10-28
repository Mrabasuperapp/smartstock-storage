import {pipeline} from 'stream';
import {ReadableStream} from "node:stream/web";
import {generateCidFromBuffer, generateCidFromDataStream, generateDataFromCid} from "./ipfs.mjs";
import {devLog} from "../utils/debug.mjs";

/**
 *
 * @param name {string}
 * @param size {number}
 * @param data {ReadableStream}
 * @param contentType {string}
 * @return {Promise<{cid: string,name: string,size: *}>}
 */
async function _saveFile(
    name, size, data, contentType
) {

}

/**
 *
 * @param name{string}
 * @param size {number}
 * @param data {ReadableStream}
 * @param contentType {string}
 * @return {Promise<Storage>}
 */
export async function createFileFromStream(
    name, size, data, contentType
) {
    devLog('WRITE FILE')
    const dataRes = await generateCidFromDataStream({
        data,
        size,
        name,
        type: contentType
    });
    return getFileLocation(dataRes.cid, name);
}

/**
 *
 * @param name{string}
 * @param size {number}
 * @param data {Buffer}
 * @param contentType {string}
 * @return {Promise<Storage>}
 */
export async function createFileFromBuffer(
    name, size, data, contentType
) {
    devLog('WRITE FILE')
    const dataRes = await generateCidFromBuffer({
        data,
        size,
        name,
        type: contentType
    });
    return getFileLocation(dataRes.cid, name);
}


/**
 *
 * @param cid {string}
 * @param filename {string}
 * @return {Promise<string>}
 */
export async function getFileLocation(cid, filename) {
    return `/storage/${encodeURIComponent(cid)}/${encodeURIComponent(filename)}`;
}

/**
 *
 * @param file {{cid:string,size: *,type: *}}
 * @param req
 * @param res
 * @param contentType {string}
 * @return {Promise<*>}
 */
export async function handleFileStream(
    file, req, res, contentType
) {
    if (file && file.cid && file.type && file.size) {
        const size = file.size;
        const range = req.headers.range;
        const parts = range.replace(/bytes=/, "").split('-');
        let start = parts[0];
        let end = parts[1];
        start = parseInt(start, 10);
        end = end ? parseInt(end, 10) : size - 1;

        if (!isNaN(start) && isNaN(end)) {
            // start = start;
            end = size - 1;
        }
        if (isNaN(start) && !isNaN(end)) {
            start = size - end;
            end = size - 1;
        }
        if (start >= size || end >= size) {
            res.writeHead(416, {
                "Content-Range": `bytes */${size}`
            });
            return res.end();
        }
        res.writeHead(206, {
            "Content-Range": `bytes ${start}-${end}/${size}`,
            "Accept-Ranges": "bytes",
            "Content-Length": `${end - start + 1}`,
            "Content-Type": typeof file.type === 'string' ? file.type : 'application/octet-stream'
        });
        const buffer = await generateDataFromCid(
            file.cid, {stream: true, start: start, end: end}
        );
        pipeline(buffer, res, err => {
            if (err) {
                try {
                    res.end()
                } catch (_) {
                }
            }
        });
    } else throw 'file not found, maybe its deleted';
}

/**
 *
 * @param query{{ prefix: string, size: number, skip: number }}
 * @return {Promise<*[]>}
 */
export async function listFiles(
    query = {prefix: '', size: 20, skip: 0}
) {
    // const q = {
    //     filter: {},
    //     return: [],
    //     size: query.size,
    //     skip: query.skip
    // }
    // const context = {useMasterKey: true}
    // const wOptions = {bypassDomainVerification: true}
    // let r = await findDataByFilterInStore(domain, q, context, databaseFactory(), wOptions, options);
    // if (Array.isArray(r)) return r.filter(x => x?.name?.toString()?.includes(query.prefix));
    // else
    return [];
}

/**
 *
 * @param name {string}
 * @return {string}
 */
function validateFilename(name) {
    const regx = /[^.a-zA-Z0-9]/;
    return name.replace(new RegExp(regx), '');
}

/**
 *
 * @param file {{cid: string}}
 * @return {Promise<Buffer>}
 */
export async function getFileBuffer({cid}) {
    if (cid) {
        return await generateDataFromCid(
            cid, {json: false, stream: false}
        );
    } else {
        throw 'file not found, maybe its deleted';
    }
}

/**
 *
 * @param file {{cid: string}}
 * @return {Promise<ReadableStream>}
 */
export async function getFileStream({cid}) {
    if (cid) {
        return await generateDataFromCid(
            cid, {stream: true}
        );
    } else {
        throw 'file not found, maybe its deleted';
    }
}
