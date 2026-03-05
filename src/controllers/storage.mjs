import httpStatus, {StatusCodes} from "http-status-codes";
import {rm} from "node:fs/promises";
import {createReadStream} from "node:fs";
import {pipeline} from "node:stream/promises";
import formidable from 'formidable';
import mime from 'mime'
import {createFileFromBuffer, createFileFromStream, getFileStream} from "./files.mjs";
import {devLog} from "../utils/debug.mjs";
import {deleteDataFromCid, listDatastoreEntries} from "./ipfs.mjs";
import {authorize, getAuthConfigSummary} from "./auth.mjs";
import {
    addDagIndexedFile,
    findDagIndexedFileByCid,
    getDagRootInfo,
    listDagIndexedFiles,
    removeDagIndexedFilesByCid,
    replaceDagIndexFiles
} from "./dag_index.mjs";

const MAX_JSON_BODY_BYTES = 1024 * 1024;

function safeDecodeURIComponent(value) {
    try {
        return decodeURIComponent(`${value ?? ""}`);
    } catch (_) {
        return `${value ?? ""}`;
    }
}

function parseStorageUrl(url) {
    const [_, __, cid = "", filename = ""] = `${url ?? ""}`.split("/");
    return {
        cid: safeDecodeURIComponent(cid),
        name: safeDecodeURIComponent(filename),
        url
    };
}

function escapeHtml(input) {
    return `${input ?? ""}`
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function sanitizeFilenameForHeader(filename) {
    const cleaned = `${filename ?? "file"}`
        .replace(/[\r\n]/g, " ")
        .replace(/"/g, "'");
    return cleaned || "file";
}

async function safeRemoveFile(filePath) {
    if (!filePath) {
        return;
    }
    try {
        await rm(filePath, {force: true});
    } catch (_) {
    }
}

function sendJsonError(response, status, message) {
    if (response.headersSent || response.writableEnded) {
        return;
    }
    response.status(status).json({message});
}

async function streamToHttpResponse(request, response, sourceStream, headers) {
    response.set(headers);
    const onAbort = () => {
        try {
            sourceStream?.destroy?.();
        } catch (_) {
        }
    };
    request.once("aborted", onAbort);
    response.once("close", onAbort);
    try {
        await pipeline(sourceStream, response);
    } finally {
        request.off("aborted", onAbort);
        response.off("close", onAbort);
    }
}

function resolveMimeType(recordType, filename) {
    const fromName = mime.getType(`${filename || ""}`) || "";
    const cleanRecord = `${recordType || ""}`.toLowerCase();
    if (!cleanRecord || cleanRecord === "application/octet-stream") {
        return fromName || "application/octet-stream";
    }
    return cleanRecord;
}

export function multipartForm() {
    return [
        authorize({
            roles: ["admin", "uploader", "service"],
            scopes: ["storage:write"]
        }),
        (request, response) => {
            try {
                devLog('START HANDLING MULTI PART');
                const max = 50
                const form = formidable({
                    multiples: true,
                    maxFileSize: max * 1024 * 1024,
                    keepExtensions: true
                });
                let settled = false;
                form.on('error', function (error) {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    const {code = -1, message} = error ?? {};
                    sendJsonError(response, StatusCodes.BAD_REQUEST, code === 1009 ? `File too large, max is ${max}MB` : message);
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
                                if (!filepath) {
                                    return;
                                }
                                const fileMeta = {name: undefined, type: undefined};
                                const regx = /[^\w.\- ]/gi;
                                const fallbackName = `${newFilename ?? ""}`.replace(regx, '').trim();
                                fileMeta.name = `${originalFilename ?? ""}`.replace(regx, '').trim() || fallbackName || `upload-${Date.now()}`;
                                fileMeta.type = `${type || mime.getType(fileMeta.name) || "application/octet-stream"}`;
                                const stream = createReadStream(filepath);
                                try {
                                    const data = {
                                        data: stream,
                                        type: fileMeta.type,
                                        size: size,
                                        name: fileMeta?.name
                                    }
                                    const result = await createFileFromStream(data.name, data.size, data.data, data.type);
                                    const parsed = parseStorageUrl(result);
                                    await addDagIndexedFile({
                                        cid: parsed.cid,
                                        name: parsed.name,
                                        size: data.size,
                                        type: data.type,
                                        url: result,
                                        createdAt: new Date().toISOString()
                                    });
                                    urls.push(result);
                                } finally {
                                    stream.destroy();
                                    await safeRemoveFile(filepath);
                                }
                            }

                            if (Array.isArray(file)) {
                                for (const item of file) {
                                    await handle(item)
                                }
                            } else {
                                await handle(file);
                            }
                        }
                        for (const [fieldName, fieldValue] of Object.entries(fields ?? {})) {
                            const values = Array.isArray(fieldValue) ? fieldValue : [fieldValue];
                            for (const value of values) {
                                if (value === undefined || value === null) {
                                    continue;
                                }
                                const regx = /[^\w.\- ]/gi;
                                const safeName = `${fieldName}`.replace(regx, '').trim() || `field-${Date.now()}.txt`;
                                const type = `${mime.getType(safeName) || "application/octet-stream"}`;
                                const buffer = Buffer.isBuffer(value) ? value : Buffer.from(`${value}`);
                                const result = await createFileFromBuffer(safeName, buffer.length, buffer, type);
                                const parsed = parseStorageUrl(result);
                                await addDagIndexedFile({
                                    cid: parsed.cid,
                                    name: parsed.name,
                                    size: buffer.length,
                                    type,
                                    url: result,
                                    createdAt: new Date().toISOString()
                                });
                                urls.push(result);
                            }
                        }
                        settled = true;
                        response.status(StatusCodes.OK).json({urls});
                    } catch (e) {
                        settled = true;
                        sendJsonError(response, StatusCodes.BAD_REQUEST, e?.toString());
                    }
                });
            } catch (reason) {
                devLog(reason, '::::::');
                sendJsonError(response, StatusCodes.BAD_REQUEST, reason?.toString());
            }
        }
    ]
}

export function handleGetFile() {
    return [
        authorize({
            roles: ["admin", "reader", "uploader", "service"],
            scopes: ["storage:read"]
        }),
        async (request, response) => {
            try {
                const cid = request.params.cid;
                const filename = request.params.filename;
                devLog('CID::', cid)
                const indexed = await findDagIndexedFileByCid(cid);
                const f = await getFileStream({cid});
                const detectedType = resolveMimeType(indexed?.type, filename);
                await streamToHttpResponse(request, response, f, {
                    'Content-Type': detectedType,
                    'Content-Disposition': `inline; filename="${sanitizeFilenameForHeader(filename)}"`
                });
            } catch (reason) {
                sendJsonError(response, httpStatus.BAD_REQUEST, reason?.toString());
            }
        }
    ]
}

export function handleGetFileByCid() {
    return [
        authorize({
            roles: ["admin", "reader", "uploader", "service"],
            scopes: ["storage:read"]
        }),
        async (request, response) => {
            try {
                const cid = `${request.params?.cid ?? ""}`;
                const indexed = await findDagIndexedFileByCid(cid);
                const filename = indexed?.name || cid;
                const detectedType = resolveMimeType(indexed?.type, filename);
                const stream = await getFileStream({cid});
                await streamToHttpResponse(request, response, stream, {
                    'Content-Type': detectedType,
                    'Content-Disposition': `inline; filename="${sanitizeFilenameForHeader(filename)}"`
                });
            } catch (reason) {
                sendJsonError(response, httpStatus.BAD_REQUEST, reason?.toString());
            }
        }
    ]
}

export function adminDashboard() {
    return [
        authorize({
            roles: ["admin"],
            scopes: ["admin:dashboard"]
        }),
        async (_, response) => {
            const authSummary = getAuthConfigSummary();
            response.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
            response.end(`<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Dropbox-Style Storage Dashboard</title>
  <style>
    :root {
      --bg: #f4f7fb;
      --panel: #ffffff;
      --text: #111827;
      --muted: #667085;
      --line: #dde3ed;
      --primary: #0b6ef3;
      --primary-2: #0949a5;
      --danger: #d92d20;
      --shadow: 0 12px 34px rgba(21, 36, 68, .08);
      --radius: 16px;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--text);
      background:
        radial-gradient(1200px 600px at 95% -10%, #dcecff 0%, transparent 65%),
        radial-gradient(1000px 500px at -20% 110%, #e8f4ea 0%, transparent 55%),
        var(--bg);
      font-family: "Sora", "Nunito Sans", "Segoe UI", sans-serif;
    }
    .shell { max-width: 1300px; margin: 18px auto; padding: 0 14px 30px; }
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
      margin-bottom: 10px;
      padding: 12px;
    }
    .head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
      margin-bottom: 6px;
    }
    h1 { margin: 0; font-size: clamp(1rem, 2.2vw, 1.45rem); letter-spacing: -.02em; }
    .muted { margin: 2px 0 0; color: var(--muted); font-size: .88rem; }
    .toolbar {
      display: grid;
      grid-template-columns: 1fr auto auto;
      gap: 10px;
      margin-top: 12px;
      align-items: center;
    }
    .upload-zone {
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 10px;
      background: linear-gradient(180deg, #fafdff 0%, #f5f9ff 100%);
      margin-top: 8px;
    }
    .upload-zone h3 {
      margin: 0 0 6px;
      font-size: .9rem;
      letter-spacing: -.01em;
    }
    .upload-zone .hint {
      margin: 0 0 10px;
      color: var(--muted);
      font-size: .82rem;
    }
    .upload-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
    }
    .file-badge {
      font-size: .85rem;
      color: #3d4b62;
      background: #eef3fb;
      border: 1px solid #d4deef;
      border-radius: 999px;
      padding: 7px 10px;
      line-height: 1;
    }
    .dropzone {
      border: 1.5px dashed #b7c8e6;
      border-radius: 12px;
      padding: 10px;
      background: linear-gradient(180deg, #fbfdff 0%, #f5f9ff 100%);
      color: #4f6280;
      font-weight: 700;
      min-width: 220px;
      margin-top: 8px;
      text-align: center;
    }
    .dropzone.drag {
      border-color: var(--primary);
      background: #ebf3ff;
      color: var(--primary-2);
    }
    .search {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 10px 12px;
      font-size: .95rem;
      background: #fbfcff;
    }
    .inline { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .btn, button, select {
      border: 1px solid var(--line);
      background: #fff;
      color: #111827;
      padding: 10px 12px;
      border-radius: 12px;
      font-weight: 700;
      text-decoration: none;
      cursor: pointer;
    }
    .tiny {
      padding: 7px 9px;
      border-radius: 10px;
      font-size: .82rem;
      font-weight: 700;
    }
    .btn.primary, button.primary { background: var(--primary); border-color: var(--primary); color: #fff; }
    .btn.primary:hover, button.primary:hover { background: var(--primary-2); border-color: var(--primary-2); }
    button.danger { background: var(--danger); border-color: var(--danger); color: #fff; }
    .layout {
      display: block;
    }
    .viewport {
      border: 1px solid var(--line);
      border-radius: 14px;
      overflow: hidden;
      background: #fff;
    }
    .list-table {
      width: 100%;
      border-collapse: collapse;
      font-size: .93rem;
    }
    .list-table th, .list-table td {
      border-bottom: 1px solid var(--line);
      text-align: left;
      padding: 8px 8px;
      vertical-align: top;
    }
    .list-table th { color: var(--muted); font-size: .76rem; text-transform: uppercase; letter-spacing: .04em; }
    .row-active { background: #f2f7ff; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
    .grid {
      display: grid;
      gap: 12px;
      grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
      padding: 12px;
    }
    .card {
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 12px;
      background: #fff;
      cursor: pointer;
      min-height: 148px;
    }
    .card:hover { border-color: #b8caea; transform: translateY(-1px); }
    .folder-grid {
      display: grid;
      gap: 14px;
      padding: 12px;
      grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    }
    .folder {
      border: 1px solid var(--line);
      border-radius: 14px;
      background: #fbfcff;
      padding: 12px;
    }
    .folder h3 { margin: 0 0 6px; font-size: .95rem; }
    .folder small { color: var(--muted); }
    .folder ul { margin: 8px 0 0; padding-left: 16px; max-height: 170px; overflow: auto; }
    .preview {
      position: fixed;
      top: 0;
      right: 0;
      width: min(560px, 100vw);
      height: 100vh;
      border-left: 1px solid var(--line);
      box-shadow: -10px 0 40px rgba(9, 24, 52, .18);
      display: flex;
      flex-direction: column;
      background: #fff;
      overflow: hidden;
      transform: translateX(100%);
      transition: transform .24s ease;
      z-index: 40;
    }
    .preview.open {
      transform: translateX(0);
    }
    .preview-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(8, 17, 34, .42);
      backdrop-filter: blur(1px);
      opacity: 0;
      pointer-events: none;
      transition: opacity .2s ease;
      z-index: 30;
    }
    .preview-backdrop.show {
      opacity: 1;
      pointer-events: auto;
    }
    .delete-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(7, 12, 23, .58);
      opacity: 0;
      pointer-events: none;
      transition: opacity .18s ease;
      z-index: 60;
      display: grid;
      place-items: center;
      padding: 18px;
    }
    .delete-backdrop.show {
      opacity: 1;
      pointer-events: auto;
    }
    .delete-modal {
      width: min(520px, 100%);
      background: #fff;
      border: 1px solid #ebc6c6;
      border-radius: 16px;
      box-shadow: 0 18px 50px rgba(7, 14, 34, .35);
      padding: 14px;
    }
    .delete-modal h3 {
      margin: 0 0 6px;
      font-size: 1.03rem;
      color: #8d1010;
    }
    .delete-meta {
      margin: 0 0 10px;
      color: #5b6475;
      font-size: .89rem;
      line-height: 1.35;
      word-break: break-word;
    }
    .delete-label {
      display: block;
      font-size: .84rem;
      margin-bottom: 6px;
      color: #5b6475;
      font-weight: 700;
    }
    .delete-input {
      width: 100%;
      border: 1px solid #e2b5b5;
      border-radius: 10px;
      padding: 10px 12px;
      font-size: .94rem;
      margin-bottom: 12px;
      outline: none;
    }
    .delete-input:focus {
      border-color: #d92d20;
      box-shadow: 0 0 0 3px rgba(217,45,32,.13);
    }
    .delete-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      flex-wrap: wrap;
    }
    .preview-head { padding: 12px; border-bottom: 1px solid var(--line); }
    .preview-head .line { display:flex; justify-content:space-between; gap:8px; align-items:center; flex-wrap:wrap; }
    .preview-actions { display:flex; gap:8px; flex-wrap:wrap; }
    .preview-body {
      padding: 12px;
      display: grid;
      place-items: center;
      flex: 1;
      background: linear-gradient(180deg, #fbfdff 0%, #f5f8ff 100%);
    }
    .preview-body img, .preview-body video, .preview-body iframe { max-width: 100%; max-height: 440px; border-radius: 12px; border: 1px solid var(--line); background: #fff; }
    .preview-body audio { width: 100%; }
    .preview-meta { padding: 12px; border-top: 1px solid var(--line); font-size: .9rem; color: var(--muted); }
    .pager {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px;
      border-top: 1px solid var(--line);
      gap: 12px;
      flex-wrap: wrap;
    }
    .status { min-height: 20px; color: var(--muted); margin-top: 10px; font-size: .92rem; }
    .truncate { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .filters-meta { margin-top: 6px; color: var(--muted); font-size: .88rem; }
    .file-name {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .file-icon {
      min-width: 30px;
      text-align: center;
      border-radius: 8px;
      font-size: .7rem;
      font-weight: 800;
      padding: 5px 6px;
      border: 1px solid #d6dfef;
      background: #f3f6fb;
      color: #334155;
    }
    .file-icon.image { background: #e8f7ef; border-color: #b6e4c8; color: #17633f; }
    .file-icon.video { background: #fff2e8; border-color: #ffd3b5; color: #914700; }
    .file-icon.audio { background: #f0ecff; border-color: #d7cbff; color: #4a2b9d; }
    .file-icon.text { background: #e8f2ff; border-color: #c6dcff; color: #1e4ea3; }
    .file-icon.application { background: #eef1f5; border-color: #d8dee8; color: #374151; }
    .action-row {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      justify-content: flex-start;
    }
    .name-cell .truncate {
      max-width: 100%;
    }
    @media (max-width: 1080px) { .preview { width: min(100vw, 620px); } }
    @media (max-width: 760px) {
      .shell { padding: 0 8px 16px; }
      .panel { padding: 10px; margin-bottom: 8px; border-radius: 12px; }
      .upload-actions { gap: 6px; }
      .upload-actions .file-badge { width: 100%; text-align: center; }
      .upload-actions button { flex: 1 1 130px; }
      .dropzone { margin-top: 6px; padding: 9px; font-size: .9rem; }
      .toolbar { grid-template-columns: 1fr; }
      .toolbar .inline { width: 100%; }
      .toolbar select { flex: 1 1 120px; }
      .hide-mobile { display: none; }

      .list-table thead { display: none; }
      .list-table, .list-table tbody, .list-table tr, .list-table td {
        display: block;
        width: 100%;
      }
      .list-table tr {
        border-bottom: 1px solid var(--line);
        padding: 8px 0;
      }
      .list-table td {
        border-bottom: none;
        padding: 4px 2px;
        display: flex;
        justify-content: space-between;
        gap: 10px;
        align-items: flex-start;
      }
      .list-table td::before {
        content: attr(data-label);
        color: var(--muted);
        font-size: .76rem;
        text-transform: uppercase;
        letter-spacing: .03em;
        min-width: 74px;
      }
      .list-table td.name-cell {
        display: block;
        padding-top: 0;
      }
      .list-table td.name-cell::before { content: none; }
      .list-table td.actions-cell { display: block; }
      .list-table td.actions-cell::before { content: "Actions"; display: block; margin-bottom: 6px; }
      .action-row .tiny { padding: 8px 10px; font-size: .82rem; }
      .pager { padding: 10px 4px 4px; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <section class="panel">
      <div class="head">
        <div>
          <h1>Storage Dashboard</h1>
          <p class="muted">Upload and manage files with preview. Auth issuer: ${escapeHtml(authSummary.issuer)}.</p>
        </div>
        <div>
          <button id="logoutBtn" type="button">Sign out</button>
        </div>
      </div>
      <div class="upload-zone">
        <h3>Upload Files</h3>
        <p class="hint">Choose files or drag and drop to upload instantly.</p>
        <div class="upload-actions">
          <button id="chooseUploadBtn" class="primary" type="button">Choose Files</button>
          <button id="uploadNowBtn" type="button">Upload Selected</button>
          <span id="uploadSelection" class="file-badge">No files selected</span>
        </div>
        <div id="dropzone" class="dropzone">Drop files here to upload</div>
      </div>
      <input id="uploadInput" type="file" name="multipleFiles" multiple hidden />
      <p id="status" class="status"></p>
    </section>

    <section class="panel">
      <div class="toolbar">
        <input id="search" class="search" placeholder="Search by name or CID..." />
        <div class="inline">
          <select id="typeFilter">
            <option value="all">All types</option>
            <option value="image">Images</option>
            <option value="video">Video</option>
            <option value="audio">Audio</option>
            <option value="application">Documents/App</option>
            <option value="text">Text</option>
          </select>
          <select id="pageSize">
            <option value="12">12/page</option>
            <option value="20" selected>20/page</option>
            <option value="40">40/page</option>
          </select>
        </div>
      </div>
      <div id="filtersMeta" class="filters-meta">List view</div>
    </section>

    <section class="layout">
      <div class="viewport">
        <div id="fileHost"></div>
        <div class="pager">
          <div class="inline">
            <button id="prevPage" type="button">Prev</button>
            <button id="nextPage" type="button">Next</button>
          </div>
          <div id="pageInfo" class="muted">Page 1</div>
        </div>
      </div>
      <aside id="previewPanel" class="preview" aria-hidden="true">
        <div class="preview-head">
          <div class="line">
            <strong id="previewTitle">No file selected</strong>
            <div class="preview-actions">
              <button id="previewOpen" class="tiny" type="button">Open</button>
              <button id="previewDownload" class="tiny" type="button">Download</button>
              <button id="previewCopyCid" class="tiny" type="button">Copy CID</button>
              <button id="previewClose" class="tiny" type="button">Close</button>
            </div>
          </div>
        </div>
        <div id="previewBody" class="preview-body">
          <div class="muted">Select a file and click Preview.</div>
        </div>
        <div id="previewMeta" class="preview-meta">MIME-aware preview panel</div>
      </aside>
    </section>
</div>
  <div id="previewBackdrop" class="preview-backdrop"></div>
  <div id="deleteBackdrop" class="delete-backdrop" aria-hidden="true">
    <div class="delete-modal" role="dialog" aria-modal="true" aria-labelledby="deleteTitle">
      <h3 id="deleteTitle">Delete File Permanently</h3>
      <p id="deleteMeta" class="delete-meta">This action deletes from Helia datastore and DAG root index.</p>
      <label class="delete-label" for="deleteConfirmInput">Type <strong>DELETE</strong> to confirm.</label>
      <input id="deleteConfirmInput" class="delete-input" type="text" autocomplete="off" placeholder="Type DELETE" />
      <div class="delete-actions">
        <button id="deleteCancelBtn" type="button">Cancel</button>
        <button id="deleteConfirmBtn" class="danger" type="button" disabled>Delete Permanently</button>
      </div>
    </div>
  </div>

  <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.6.82/pdf.min.js"></script>
  <script>
    const pdfJsReady = !!window.pdfjsLib;
    if (pdfJsReady) {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.6.82/pdf.worker.min.js";
    }
    const state = {
      files: [],
      pagination: {page: 1, totalPages: 1, total: 0, pageSize: 20},
      q: "",
      type: "all",
      selected: null,
      previewFile: null,
      previewOpen: false,
      pdfLoadingTask: null,
      deleteCandidate: null,
      deleteOpen: false,
      deleteBusy: false
    };
    const statusEl = document.getElementById("status");
    const fileHost = document.getElementById("fileHost");
    const pageInfo = document.getElementById("pageInfo");
    const searchEl = document.getElementById("search");
    const typeFilter = document.getElementById("typeFilter");
    const pageSize = document.getElementById("pageSize");
    const previewTitle = document.getElementById("previewTitle");
    const previewBody = document.getElementById("previewBody");
    const previewMeta = document.getElementById("previewMeta");
    const filtersMeta = document.getElementById("filtersMeta");
    const dropzone = document.getElementById("dropzone");
    const uploadInput = document.getElementById("uploadInput");
    const chooseUploadBtn = document.getElementById("chooseUploadBtn");
    const uploadNowBtn = document.getElementById("uploadNowBtn");
    const uploadSelection = document.getElementById("uploadSelection");
    const logoutBtn = document.getElementById("logoutBtn");
    const previewOpen = document.getElementById("previewOpen");
    const previewDownload = document.getElementById("previewDownload");
    const previewCopyCid = document.getElementById("previewCopyCid");
    const previewClose = document.getElementById("previewClose");
    const previewPanel = document.getElementById("previewPanel");
    const previewBackdrop = document.getElementById("previewBackdrop");
    const deleteBackdrop = document.getElementById("deleteBackdrop");
    const deleteMeta = document.getElementById("deleteMeta");
    const deleteConfirmInput = document.getElementById("deleteConfirmInput");
    const deleteCancelBtn = document.getElementById("deleteCancelBtn");
    const deleteConfirmBtn = document.getElementById("deleteConfirmBtn");

    async function apiFetch(url, options) {
      const res = await fetch(url, {
        cache: "no-store",
        ...(options || {})
      });
      if (res.status === 401) {
        window.location.href = "/auth/login";
        throw new Error("Session expired. Please sign in again.");
      }
      return res;
    }

    function showStatus(message, isError = false) {
      statusEl.textContent = message || "";
      statusEl.style.color = isError ? "#d92d20" : "#667085";
    }
    function formatSize(v) {
      const n = Number(v) || 0;
      if (n < 1024) return n + " B";
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
      if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + " MB";
      return (n / (1024 * 1024 * 1024)).toFixed(1) + " GB";
    }
    function escapeHtml(s) { return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
    function fileUrl(file) {
      if (file && typeof file.url === "string" && file.url.trim()) {
        return file.url;
      }
      return "/storage/" + encodeURIComponent(file.cid);
    }

    async function loadFiles() {
      try {
        fileHost.innerHTML = '<div style="padding:16px;color:#667085;">Loading files...</div>';
        const params = new URLSearchParams();
        params.set("page", String(state.pagination.page));
        params.set("pageSize", String(state.pagination.pageSize));
        if (state.q) params.set("q", state.q);
        if (state.type && state.type !== "all") params.set("type", state.type);
        const res = await apiFetch("/admin/storage/files?" + params.toString());
        const data = await res.json();
        if (!res.ok) throw new Error(data?.message || "Failed loading files");
        state.files = Array.isArray(data.files) ? data.files : [];
        state.pagination = data.pagination || state.pagination;
        const stillVisible = state.selected && state.files.find(x => x.cid === state.selected.cid);
        if (!stillVisible) {
          state.selected = state.files[0] || null;
        }
        if (!state.selected && state.files.length) {
          state.selected = state.files[0];
        }
        const visiblePreview = state.previewFile && state.files.find(x => x.cid === state.previewFile.cid);
        state.previewFile = visiblePreview || null;
        if (!state.previewFile) {
          state.previewOpen = false;
        }
        renderFiles();
        renderPreview(state.previewFile);
        updatePreviewVisibility();
      } catch (e) {
        showStatus(e.message || "Failed loading files", true);
      }
    }

    function renderFiles() {
      pageInfo.textContent = "Page " + state.pagination.page + " of " + state.pagination.totalPages + " • " + state.pagination.total + " files";
      filtersMeta.textContent = "Type: " + state.type + (state.q ? " • Search: " + state.q : "");
      if (!state.files.length) {
        fileHost.innerHTML = '<div style="padding:16px;color:#667085;">No files found.</div>';
        return;
      }
      return renderList();
    }

    function fileTypeClass(type) {
      const major = String(type || "").split("/")[0];
      if (["image", "video", "audio", "text", "application"].includes(major)) return major;
      return "application";
    }

    function fileTypeCode(type) {
      const major = String(type || "").split("/")[0];
      if (major === "image") return "IMG";
      if (major === "video") return "VID";
      if (major === "audio") return "AUD";
      if (major === "text") return "TXT";
      return "FILE";
    }

    function actionButtons(file) {
      return \`
        <div class="action-row">
          <button class="tiny" data-open="\${file.cid}" type="button">Open</button>
          <button class="tiny" data-preview="\${file.cid}" type="button">Preview</button>
          <button class="tiny danger" data-delete="\${file.cid}" type="button">Delete</button>
        </div>
      \`;
    }

    async function renderPdfPreview(url) {
      if (!pdfJsReady) {
        const pdfUrl = url + (url.includes("#") ? "" : "#view=FitH");
        previewBody.innerHTML = '<iframe title="PDF preview" src="' + pdfUrl + '"></iframe>';
        return;
      }
      if (state.pdfLoadingTask?.destroy) {
        try {
          await state.pdfLoadingTask.destroy();
        } catch (_) {
        }
      }
      previewBody.innerHTML = '<div class="muted">Loading PDF preview...</div>';
      const loadingTask = window.pdfjsLib.getDocument({url});
      state.pdfLoadingTask = loadingTask;
      try {
        const pdf = await loadingTask.promise;
        const page = await pdf.getPage(1);
        const viewport = page.getViewport({scale: 1.2});
        const canvas = document.createElement("canvas");
        canvas.style.maxWidth = "100%";
        canvas.style.height = "auto";
        canvas.style.border = "1px solid var(--line)";
        canvas.style.borderRadius = "12px";
        const context = canvas.getContext("2d");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        await page.render({canvasContext: context, viewport}).promise;
        previewBody.innerHTML = "";
        previewBody.appendChild(canvas);
      } catch (_) {
        const pdfUrl = url + (url.includes("#") ? "" : "#view=FitH");
        previewBody.innerHTML = '<iframe title="PDF preview" src="' + pdfUrl + '"></iframe>';
      }
    }

    function renderList() {
      const rows = state.files.map(file => \`
        <tr data-row="\${file.cid}" class="\${state.selected?.cid === file.cid ? "row-active" : ""}">
          <td class="name-cell" data-label="Name">
            <div class="file-name">
              <span class="file-icon \${fileTypeClass(file.type)}">\${fileTypeCode(file.type)}</span>
              <div class="truncate">\${escapeHtml(file.name)}</div>
            </div>
          </td>
          <td data-label="Type">\${escapeHtml(file.type || "-")}</td>
          <td data-label="Size">\${formatSize(file.size)}</td>
          <td class="mono hide-mobile" data-label="CID"><div class="truncate">\${escapeHtml(file.cid)}</div></td>
          <td data-label="Created">\${file.createdAt ? new Date(file.createdAt).toLocaleString() : "-"}</td>
          <td class="actions-cell" data-label="Actions">\${actionButtons(file)}</td>
        </tr>
      \`).join("");
      fileHost.innerHTML = \`
        <table class="list-table">
          <thead><tr><th>Name</th><th>MIME Type</th><th>Size</th><th class="hide-mobile">CID</th><th>Created</th><th>Actions</th></tr></thead>
          <tbody>\${rows}</tbody>
        </table>
      \`;
      bindActions();
    }

    async function deleteFile(cid) {
      const res = await apiFetch("/admin/storage/files/" + encodeURIComponent(cid), {method: "DELETE"});
      const json = await res.json();
      if (!res.ok) throw new Error(json?.message || "Delete failed");
      const helia = json?.helia?.deleted ? "helia deleted" : ("helia " + (json?.helia?.reason || "not-deleted"));
      showStatus("Deleted " + (json.removed || 0) + " record(s), " + helia);
      if (state.selected?.cid === cid) state.selected = null;
      await loadFiles();
    }

    function renderPreview(file) {
      if (!file) {
        previewTitle.textContent = "No file selected";
        previewBody.innerHTML = '<div class="muted">Select a file to preview.</div>';
        previewMeta.textContent = "MIME-aware preview panel";
        previewOpen.onclick = null;
        previewDownload.onclick = null;
        previewCopyCid.onclick = null;
        return;
      }
      const url = fileUrl(file);
      const type = String(file.type || "application/octet-stream");
      const isPdf = type.toLowerCase().includes("pdf") || String(file.name || "").toLowerCase().endsWith(".pdf");
      previewTitle.textContent = file.name;
      previewMeta.textContent = type + " • " + formatSize(file.size) + " • CID " + file.cid;
      previewOpen.onclick = () => window.open(url, "_blank");
      previewDownload.onclick = () => {
        const a = document.createElement("a");
        a.href = url;
        a.download = file.name || file.cid;
        a.target = "_blank";
        a.click();
      };
      previewCopyCid.onclick = async () => {
        try {
          await navigator.clipboard.writeText(file.cid);
          showStatus("CID copied to clipboard");
        } catch (_) {
          showStatus("Unable to copy CID", true);
        }
      };
      if (type.startsWith("image/")) {
        previewBody.innerHTML = '<img alt="preview" src="' + url + '" />';
        return;
      }
      if (type.startsWith("video/")) {
        previewBody.innerHTML = '<video controls src="' + url + '"></video>';
        return;
      }
      if (type.startsWith("audio/")) {
        previewBody.innerHTML = '<audio controls src="' + url + '"></audio>';
        return;
      }
      if (isPdf) {
        renderPdfPreview(url);
        return;
      }
      if (type.startsWith("text/") || type.includes("json") || type.includes("javascript")) {
        apiFetch(url).then(r => r.text()).then(text => {
          const safe = escapeHtml(text.slice(0, 16000));
          previewBody.innerHTML = '<pre style="width:100%;max-height:420px;overflow:auto;border:1px solid var(--line);padding:12px;border-radius:12px;background:#fff;">' + safe + '</pre>';
        }).catch(() => {
          previewBody.innerHTML = '<div class="muted">Could not preview text file.</div>';
        });
        return;
      }
      previewBody.innerHTML = '<div class="muted">No inline preview for this MIME type.</div><a class="btn primary" target="_blank" href="' + url + '">Open File</a>';
    }

    function stopPreviewMedia() {
      if (state.pdfLoadingTask?.destroy) {
        try {
          state.pdfLoadingTask.destroy();
        } catch (_) {
        }
        state.pdfLoadingTask = null;
      }
      const mediaEls = previewBody.querySelectorAll("video, audio");
      mediaEls.forEach(media => {
        try {
          media.pause();
          media.currentTime = 0;
          media.removeAttribute("src");
          media.load();
        } catch (_) {
        }
      });
      const iframeEls = previewBody.querySelectorAll("iframe");
      iframeEls.forEach(frame => {
        try {
          frame.src = "about:blank";
        } catch (_) {
        }
      });
    }

    function updatePreviewVisibility() {
      const open = state.previewOpen === true;
      previewPanel.classList.toggle("open", open);
      previewBackdrop.classList.toggle("show", open);
      previewPanel.setAttribute("aria-hidden", open ? "false" : "true");
    }

    function openPreview(file) {
      if (!file) return;
      state.previewFile = file;
      state.selected = file;
      state.previewOpen = true;
      renderFiles();
      renderPreview(file);
      updatePreviewVisibility();
    }

    function updateDeleteDialogState() {
      const open = state.deleteOpen === true;
      deleteBackdrop.classList.toggle("show", open);
      deleteBackdrop.setAttribute("aria-hidden", open ? "false" : "true");
      const canConfirm = !state.deleteBusy && deleteConfirmInput.value.trim().toUpperCase() === "DELETE";
      deleteConfirmBtn.disabled = !canConfirm;
      deleteCancelBtn.disabled = state.deleteBusy;
      deleteConfirmInput.disabled = state.deleteBusy;
      deleteConfirmBtn.textContent = state.deleteBusy ? "Deleting..." : "Delete Permanently";
    }

    function openDeleteDialog(file) {
      if (!file) return;
      state.deleteCandidate = file;
      state.deleteOpen = true;
      state.deleteBusy = false;
      deleteConfirmInput.value = "";
      deleteMeta.textContent = 'You are deleting "' + file.name + '" (' + file.cid + '). This is destructive and cannot be undone.';
      updateDeleteDialogState();
      setTimeout(() => deleteConfirmInput.focus(), 20);
    }

    function closeDeleteDialog() {
      if (state.deleteBusy) return;
      state.deleteOpen = false;
      state.deleteCandidate = null;
      deleteConfirmInput.value = "";
      updateDeleteDialogState();
    }

    async function confirmDeleteDialog() {
      if (!state.deleteCandidate) return;
      if (deleteConfirmInput.value.trim().toUpperCase() !== "DELETE") return;
      state.deleteBusy = true;
      updateDeleteDialogState();
      try {
        await deleteFile(state.deleteCandidate.cid);
        state.deleteOpen = false;
        state.deleteCandidate = null;
        deleteConfirmInput.value = "";
      } catch (e) {
        showStatus(e.message || "Delete failed", true);
      } finally {
        state.deleteBusy = false;
        updateDeleteDialogState();
      }
    }

    function closePreview() {
      stopPreviewMedia();
      state.previewOpen = false;
      updatePreviewVisibility();
    }

    async function uploadFiles(fileList) {
      if (!fileList || !fileList.length) return;
      const formData = new FormData();
      Array.from(fileList).forEach(file => formData.append("multipleFiles", file));
      showStatus("Uploading " + fileList.length + " file(s)...");
      const res = await apiFetch("/storage", {method: "POST", body: formData});
      const json = await res.json();
      if (!res.ok) throw new Error(json?.message || "Upload failed");
      showStatus("Uploaded " + ((json.urls || []).length) + " file(s)");
      state.pagination.page = 1;
      await loadFiles();
    }

    function updateUploadSelectionLabel() {
      const count = uploadInput.files?.length || 0;
      uploadSelection.textContent = count ? (count + " file(s) selected") : "No files selected";
    }

    function bindActions() {
      document.querySelectorAll("[data-preview]").forEach(el => el.onclick = () => {
        const file = state.files.find(x => x.cid === el.getAttribute("data-preview"));
        if (!file) return;
        openPreview(file);
      });
      document.querySelectorAll("[data-open]").forEach(el => el.onclick = () => {
        const file = state.files.find(x => x.cid === el.getAttribute("data-open"));
        if (!file) return;
        window.open(fileUrl(file), "_blank");
      });
      document.querySelectorAll("[data-delete]").forEach(el => el.onclick = async () => {
        const file = state.files.find(x => x.cid === el.getAttribute("data-delete"));
        if (!file) return;
        openDeleteDialog(file);
      });
      document.querySelectorAll("[data-row]").forEach(row => row.onclick = (ev) => {
        if (ev.target.closest("button")) return;
        const file = state.files.find(x => x.cid === row.getAttribute("data-row"));
        if (!file) return;
        state.selected = file;
        renderFiles();
      });
    }

    document.getElementById("prevPage").addEventListener("click", async () => {
      if (state.pagination.page <= 1) return;
      state.pagination.page -= 1;
      await loadFiles();
    });
    document.getElementById("nextPage").addEventListener("click", async () => {
      if (state.pagination.page >= state.pagination.totalPages) return;
      state.pagination.page += 1;
      await loadFiles();
    });
    let searchTimer = null;
    searchEl.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(async () => {
        state.q = searchEl.value.trim();
        state.pagination.page = 1;
        await loadFiles();
      }, 280);
    });
    typeFilter.addEventListener("change", async () => {
      state.type = typeFilter.value;
      state.pagination.page = 1;
      await loadFiles();
    });
    pageSize.addEventListener("change", async () => {
      state.pagination.pageSize = Number(pageSize.value);
      state.pagination.page = 1;
      await loadFiles();
    });
    chooseUploadBtn.addEventListener("click", () => uploadInput.click());
    uploadInput.addEventListener("change", updateUploadSelectionLabel);
    uploadNowBtn.addEventListener("click", async () => {
      try {
        await uploadFiles(uploadInput.files);
        uploadInput.value = "";
        updateUploadSelectionLabel();
      } catch (e) {
        showStatus(e.message || "Upload failed", true);
      }
    });
    previewClose.addEventListener("click", closePreview);
    previewBackdrop.addEventListener("click", closePreview);
    deleteConfirmInput.addEventListener("input", updateDeleteDialogState);
    deleteCancelBtn.addEventListener("click", closeDeleteDialog);
    deleteConfirmBtn.addEventListener("click", async () => {
      await confirmDeleteDialog();
    });
    deleteBackdrop.addEventListener("click", ev => {
      if (ev.target === deleteBackdrop) {
        closeDeleteDialog();
      }
    });
    document.addEventListener("keydown", ev => {
      if (ev.key === "Escape") {
        if (state.deleteOpen) {
          closeDeleteDialog();
          return;
        }
        closePreview();
      }
    });

    ["dragenter", "dragover"].forEach(evt => dropzone.addEventListener(evt, e => {
      e.preventDefault();
      dropzone.classList.add("drag");
    }));
    ["dragleave", "drop"].forEach(evt => dropzone.addEventListener(evt, e => {
      e.preventDefault();
      dropzone.classList.remove("drag");
    }));
    dropzone.addEventListener("drop", async e => {
      try {
        const files = e.dataTransfer?.files;
        await uploadFiles(files);
        uploadInput.value = "";
        updateUploadSelectionLabel();
      } catch (err) {
        showStatus(err.message || "Upload failed", true);
      }
    });

    updateUploadSelectionLabel();
    updatePreviewVisibility();
    updateDeleteDialogState();
    logoutBtn?.addEventListener("click", async () => {
      await fetch("/auth/session", {method: "DELETE"});
      window.location.href = "/auth/login";
    });
    loadFiles();
  </script>
</body>
</html>`);
        }
    ];
}

export function adminListFiles() {
    return [
        authorize({
            roles: ["admin"],
            scopes: ["admin:files"]
        }),
        async (request, response) => {
            try {
                response.set({
                    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
                    "Pragma": "no-cache",
                    "Expires": "0",
                    "Surrogate-Control": "no-store"
                });
                const files = await listDagIndexedFiles();
                const q = `${request.query?.q ?? ""}`.trim().toLowerCase();
                const type = `${request.query?.type ?? "all"}`.trim().toLowerCase();
                const view = `${request.query?.view ?? "list"}`.trim().toLowerCase();
                const page = Math.max(1, Number(request.query?.page ?? 1));
                const pageSize = Math.min(100, Math.max(1, Number(request.query?.pageSize ?? 20)));
                const filtered = files.filter(item => {
                    const matchQuery = !q || `${item.name}`.toLowerCase().includes(q) || `${item.cid}`.toLowerCase().includes(q);
                    if (!matchQuery) {
                        return false;
                    }
                    if (type === "all") {
                        return true;
                    }
                    if (type === "folder") {
                        return false;
                    }
                    return `${item.type || ""}`.toLowerCase().startsWith(`${type}/`);
                });
                const sorted = filtered.sort((a, b) => `${b.createdAt || ""}`.localeCompare(`${a.createdAt || ""}`));
                const total = sorted.length;
                const totalPages = Math.max(1, Math.ceil(total / pageSize));
                const safePage = Math.min(page, totalPages);
                const start = (safePage - 1) * pageSize;
                const entries = sorted.slice(start, start + pageSize);
                const dag = await getDagRootInfo();
                response.status(StatusCodes.OK).json({
                    files: entries,
                    pagination: {
                        total,
                        totalPages,
                        page: safePage,
                        pageSize,
                        hasNext: safePage < totalPages,
                        hasPrev: safePage > 1
                    },
                    filters: {q, type, view},
                    dag: {
                        rootCid: dag.rootCid,
                        count: dag.count,
                        updatedAt: dag.updatedAt
                    }
                });
            } catch (e) {
                response.status(StatusCodes.INTERNAL_SERVER_ERROR).json({message: e?.toString()});
            }
        }
    ];
}

export function adminDeleteFile() {
    return [
        authorize({
            roles: ["admin"],
            scopes: ["admin:files"]
        }),
        async (request, response) => {
            try {
                const cid = decodeURIComponent(`${request.params?.cid ?? ""}`);
                const heliaResult = await deleteDataFromCid(cid);
                const indexResult = await removeDagIndexedFilesByCid(cid);
                response.status(StatusCodes.OK).json({
                    removed: indexResult.removed,
                    helia: heliaResult
                });
            } catch (e) {
                response.status(StatusCodes.BAD_REQUEST).json({message: e?.toString()});
            }
        }
    ];
}

async function parseJsonBody(request) {
    if (request.body && typeof request.body === "object") {
        return request.body;
    }
    if (typeof request.body === "string") {
        return JSON.parse(request.body);
    }
    return await new Promise((resolve, reject) => {
        let total = 0;
        const chunks = [];
        const onData = chunk => {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(`${chunk ?? ""}`);
            total += buf.length;
            if (total > MAX_JSON_BODY_BYTES) {
                cleanup();
                reject(new Error(`Request body too large. Max is ${MAX_JSON_BODY_BYTES} bytes`));
                request.destroy();
                return;
            }
            chunks.push(buf);
        };
        const onEnd = () => {
            try {
                const raw = Buffer.concat(chunks).toString("utf8");
                resolve(raw ? JSON.parse(raw) : {});
            } catch (e) {
                reject(e);
            }
            cleanup();
        };
        const onError = err => {
            cleanup();
            reject(err);
        };
        const cleanup = () => {
            request.off("data", onData);
            request.off("end", onEnd);
            request.off("error", onError);
        };
        request.on("data", onData);
        request.on("end", onEnd);
        request.on("error", onError);
    });
}

async function parseImportMultipart(request) {
    return await new Promise((resolve, reject) => {
        const form = formidable({
            multiples: false,
            maxFileSize: 10 * 1024 * 1024,
            keepExtensions: true
        });
        form.parse(request, async (error, _, files) => {
            if (error) {
                reject(error);
                return;
            }
            let tempPath;
            try {
                const importFile = files?.importFile;
                const f = Array.isArray(importFile) ? importFile[0] : importFile;
                if (!f?.filepath) {
                    reject(new Error("importFile is required"));
                    return;
                }
                tempPath = f.filepath;
                const {readFile} = await import("node:fs/promises");
                const payload = JSON.parse(await readFile(f.filepath, "utf8"));
                resolve(payload);
            } catch (e) {
                reject(e);
            } finally {
                await safeRemoveFile(tempPath);
            }
        });
    });
}

export function adminImportFiles() {
    return [
        authorize({
            roles: ["admin"],
            scopes: ["admin:files"]
        }),
        async (request, response) => {
            const mode = `${request.query?.mode ?? "merge"}`.toLowerCase() === "replace" ? "replace" : "merge";
            const contentType = `${request.get('content-type') ?? ""}`.split(';')[0].toLowerCase();
            try {
                const payload = contentType === "application/json"
                    ? await parseJsonBody(request)
                    : await parseImportMultipart(request);
                const files = Array.isArray(payload) ? payload : payload?.files;
                if (!Array.isArray(files)) {
                    response.status(StatusCodes.BAD_REQUEST).json({message: "Invalid import payload"});
                    return;
                }
                const hasBinaryData = files.some(x => typeof x?.dataBase64 === "string" && x.dataBase64.length > 0);
                if (!hasBinaryData) {
                    response.status(StatusCodes.BAD_REQUEST).json({
                        message: "Metadata-only import is disabled. Provide files with dataBase64."
                    });
                    return;
                }
                let imported = 0;
                const urls = [];
                const indexedRecords = [];
                for (const file of files) {
                    if (!file?.name || !file?.dataBase64) {
                        continue;
                    }
                    const buffer = Buffer.from(`${file.dataBase64}`, "base64");
                    const saved = await createFileFromBuffer(
                        `${file.name}`,
                        Number(file.size) || buffer.length,
                        buffer,
                        `${file.type ?? "application/octet-stream"}`
                    );
                    urls.push(saved);
                    const parsed = parseStorageUrl(saved);
                    indexedRecords.push({
                        cid: parsed.cid,
                        name: parsed.name,
                        size: Number(file.size) || buffer.length,
                        type: `${file.type ?? "application/octet-stream"}`,
                        url: saved,
                        createdAt: file?.createdAt || new Date().toISOString()
                    });
                    imported += 1;
                }
                const existing = mode === "replace" ? [] : await listDagIndexedFiles();
                await replaceDagIndexFiles([...existing, ...indexedRecords]);
                response.status(StatusCodes.OK).json({
                    mode,
                    imported,
                    urls,
                    type: "full-bundle"
                });
            } catch (e) {
                response.status(StatusCodes.BAD_REQUEST).json({message: e?.toString()});
            }
        }
    ];
}

export function adminListHeliaDatastore() {
    return [
        authorize({
            roles: ["admin"],
            scopes: ["admin:datastore"]
        }),
        async (request, response) => {
            try {
                const limit = Math.min(2000, Math.max(1, Number(request.query?.limit ?? 500)));
                const offset = Math.max(0, Number(request.query?.offset ?? 0));
                const q = `${request.query?.q ?? ""}`.trim().toLowerCase();
                const ds = await listDatastoreEntries({
                    limit: Math.max(limit, q ? 5000 : limit),
                    offset: 0,
                    includeSize: true,
                    cidQuery: ""
                });
                const filtered = ds.entries.filter(item => {
                    if (!q) {
                        return true;
                    }
                    const inCid = `${item.cid}`.toLowerCase().includes(q);
                    return inCid;
                });
                const page = filtered.slice(offset, offset + limit);
                response.status(StatusCodes.OK).json({
                    total: filtered.length,
                    truncated: filtered.length > offset + limit || ds.truncated,
                    limit,
                    offset,
                    entries: page
                });
            } catch (e) {
                response.status(StatusCodes.INTERNAL_SERVER_ERROR).json({message: e?.toString()});
            }
        }
    ];
}
