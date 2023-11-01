import httpStatus, {StatusCodes} from "http-status-codes";
import {rm} from "node:fs/promises";
import {createReadStream} from "node:fs";
import formidable from 'formidable';
import mime from 'mime'
import {createFileFromBuffer, createFileFromStream, getFileBuffer, getFileStream} from "./files.mjs";
import {devLog} from "../utils/debug.mjs";
import {join} from "node:path";

export function multipartForm() {
    return [
        (request, response) => {
            const contentType = `${request.get('content-type')}`.split(';')[0].toString().trim().toLowerCase();
            devLog(contentType)
            // if (contentType !== 'multipart/form-data'.trim().toLowerCase()) {
            //     response.status(StatusCodes.BAD_REQUEST).json({message: 'Accept only multipart request'});
            //     return;

            // }
            try {
                devLog('START HANDLING MULTI PART');
                const max = 50
                const form = formidable({
                    multiples: true,
                    maxFileSize: max * 1024 * 1024,
                    keepExtensions: true
                });
                form.on('error', function (error) {
                    const {code = -1, message} = error ?? {};
                    response.status(StatusCodes.BAD_REQUEST)
                        .send({message: code === 1009 ? `File too large, max is ${max}MB` : message});
                });
                form.parse(request, async (error, fields, files) => {
                    if (error) {
                        return;
                    }
                    try {
                        const urls = [];
                        const filesValues = Object.values(files);
                        for (let i = 0; i < filesValues.length; i++) {
                            const file = filesValues[i];

                            async function handle(x) {
                                const {filepath, originalFilename, newFilename, type, size} = x ?? {};
                                devLog('FILE_PARTS', filepath, originalFilename, newFilename, type, size)
                                const fileMeta = {name: undefined, type: undefined};
                                const regx = /[^0-9a-z.]/gi;
                                fileMeta.name = originalFilename ?? `${newFilename}`.replace(regx, '');
                                fileMeta.type = type;
                                const data = {
                                    data: createReadStream(join(filepath)),
                                    type: type,
                                    size: size,
                                    name: fileMeta?.name
                                }
                                const result = await createFileFromStream(data.name, data.size, data.data, data.type);
                                await rm(join(filepath));
                                urls.push(result);
                            }

                            if (Array.isArray(file)) {
                                for (const item of file) {
                                    await handle(item)
                                }
                            } else {
                                await handle(file);
                            }
                        }
                        for (const s of Object.keys(fields)) {
                            async function handleBuffer(x) {
                                const fileMeta = {name: undefined, type: undefined};
                                const regx = /[^0-9a-z.]/gi;
                                fileMeta.name = x
                                    .toString()
                                    .replace(regx, '');
                                const data = {
                                    data: Buffer.from(fields[x]),
                                    type: fileMeta.type,
                                    size: fields[x]?.length,
                                    name: fileMeta.name
                                }
                                fileMeta.type = mime.getType(x);
                                const result = await createFileFromBuffer(data.name, data.size, data.data, data.type);
                                urls.push(result);
                            }

                            if (Array.isArray(s)) {
                                for (const item of s) {
                                    await handleBuffer(item)
                                }
                            } else {
                                await handleBuffer(s);
                            }
                        }
                        response.status(StatusCodes.OK).json({urls});
                    } catch (e) {
                        response.status(StatusCodes.BAD_REQUEST).end(e.toString());
                    }
                });
            } catch (reason) {
                devLog(reason, '::::::');
                response.status(StatusCodes.BAD_REQUEST).send(reason?.toString());
            }
        }
    ]
}

export function handleGetFile() {
    return [
        (request, response) => {
            const cid = request.params.cid;
            const filename = request.params.filename;
            devLog('CID::', cid)
            getFileStream({cid}).then(f => {
                // devLog(f);
                // response.set({
                // // 'Content-Type': typeof f.type === 'string' ? f.type : 'application/octet-stream',
                // // 'Content-Length': typeof f.size === 'number' ? f.size : 0,
                // 'Content-Disposition': `attachment; filename="${filename}"`,
                // });
                f.pipe(response);
            }).catch(reason => {
                response.status(httpStatus.BAD_REQUEST).send(reason);
            });
        }
    ]
}