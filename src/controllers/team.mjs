import {StatusCodes} from "http-status-codes";
import {authorize, parseJsonBody} from "./auth.mjs";
import {addAdmin, listAdmins, removeAdmin} from "./admins.mjs";

const adminOnly = () => authorize({roles: ["admin"], scopes: ["admin:dashboard"]});

const respond = handler => [adminOnly(), async (request, response) => {
    try {
        response.set({"Cache-Control": "no-store"});
        const result = await handler(request);
        if (result === undefined) {
            response.status(StatusCodes.NOT_FOUND).json({message: "Not found"});
            return;
        }
        response.status(StatusCodes.OK).json(result);
    } catch (e) {
        response.status(e?.status ?? StatusCodes.BAD_REQUEST).json({message: `${e?.message ?? e}`});
    }
}];

export const teamList = () => respond(() => listAdmins());

export const teamAdd = () => respond(async request => {
    const body = await parseJsonBody(request);
    return addAdmin(body?.email, request.auth?.sub);
});

export const teamRemove = () => respond(async request => {
    const removed = await removeAdmin(decodeURIComponent(`${request.params?.email ?? ""}`), request.auth?.sub);
    return removed ? {removed: true} : undefined;
});
