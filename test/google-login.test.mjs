import {after, before, describe, test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createLocalJWKSet, exportJWK, generateKeyPair, SignJWT} from "jose";

const dir = await mkdtemp(join(tmpdir(), "zebra-login-"));
process.env.STORAGE_BLOCKSTORE_DIR = dir;
process.env.ADMIN_EMAILS = "Owner@Example.com";
process.env.NODE_ENV = "test";

const {createFirebaseVerifier} = await import("../src/controllers/google_auth.mjs");
const {authCreateSession} = await import("../src/controllers/auth.mjs");
const {teamAdd, teamList, teamRemove} = await import("../src/controllers/team.mjs");
const {isAdminEmail} = await import("../src/controllers/admins.mjs");

const PROJECT = "test-project";
const {privateKey, publicKey} = await generateKeyPair("RS256");
const jwk = {...await exportJWK(publicKey), kid: "k1", alg: "RS256", use: "sig"};
const verify = createFirebaseVerifier(PROJECT, createLocalJWKSet({keys: [jwk]}));

const idToken = ({email = "owner@example.com", verified = true, provider = "google.com", aud = PROJECT, key = privateKey, exp = "10m"} = {}) =>
    new SignJWT({email, email_verified: verified, name: "Test User", firebase: {sign_in_provider: provider}})
        .setProtectedHeader({alg: "RS256", kid: "k1"})
        .setIssuer(`https://securetoken.google.com/${PROJECT}`).setAudience(aud).setSubject(`uid-${email}`)
        .setIssuedAt().setExpirationTime(exp).sign(key);

const makeResponse = () => ({
    code: 200, headers: {}, body: undefined,
    set(h) { Object.assign(this.headers, h); return this; },
    status(c) { this.code = c; return this; },
    json(b) { this.body = b; return this; },
    redirect() {}, end() {}
});
const makeRequest = (over = {}) => {
    const request = {headers: {}, params: {}, method: "GET", ...over};
    request.get = name => request.headers[name.toLowerCase()] ?? "";
    return request;
};

/** Runs a handler chain the way the router does: each guard must call next() to continue. */
async function run(chain, request) {
    const response = makeResponse();
    for (const fn of chain.slice(0, -1)) {
        let proceed = false;
        await fn(request, response, () => { proceed = true; });
        if (!proceed) return response;
    }
    await chain.at(-1)(request, response);
    return response;
}

const signIn = async email => {
    const response = await run(authCreateSession({verifyIdToken: verify}), makeRequest({body: {idToken: await idToken({email})}}));
    const cookie = response.headers["Set-Cookie"]?.split(";")[0];
    return {response, cookie};
};
const as = (cookie, extra = {}) => makeRequest({headers: {cookie}, ...extra});

after(() => rm(dir, {recursive: true, force: true}));

describe("Firebase ID token verification", () => {
    test("accepts a verified Google account", async () => {
        const user = await verify(await idToken({email: "Owner@Example.com"}));
        assert.equal(user.email, "owner@example.com");
    });

    for (const [name, options] of Object.entries({
        "an unverified email": {verified: false},
        "a non-Google provider": {provider: "password"},
        "another project's audience": {aud: "someone-else"},
        "an expired token": {exp: "-1m"}
    })) {
        test(`rejects ${name}`, async () => {
            await assert.rejects(async () => verify(await idToken(options)), error => error.status === 401);
        });
    }

    test("rejects a token signed with a different key", async () => {
        const other = await generateKeyPair("RS256");
        await assert.rejects(async () => verify(await idToken({key: other.privateKey})), error => error.status === 401);
    });

    test("rejects a missing token", async () => {
        await assert.rejects(() => verify(undefined), error => error.status === 401);
    });
});

describe("console sign-in and the team list", () => {
    test("the owner from ADMIN_EMAILS signs in and gets an HttpOnly session cookie", async () => {
        const {response} = await signIn("owner@example.com");
        assert.equal(response.code, 200);
        assert.deepEqual(response.body.roles, ["admin"]);
        assert.match(response.headers["Set-Cookie"], /HttpOnly/);
        assert.match(response.headers["Set-Cookie"], /SameSite=Strict/);
    });

    test("an account that was not added is refused", async () => {
        const {response} = await signIn("stranger@gmail.com");
        assert.equal(response.code, 403);
        assert.match(response.body.message, /does not have access/);
    });

    test("an invalid ID token is refused", async () => {
        const response = await run(authCreateSession({verifyIdToken: verify}), makeRequest({body: {idToken: "garbage"}}));
        assert.equal(response.code, 401);
    });

    test("the team list needs a session", async () => {
        assert.equal((await run(teamList(), makeRequest())).code, 401);
    });

    test("an owner adds a teammate who can then sign in, and removal ends their session", async () => {
        const {cookie: ownerCookie} = await signIn("owner@example.com");

        assert.equal((await run(teamAdd(), as(ownerCookie, {method: "POST", body: {email: "not-an-email"}}))).code, 400);
        const added = await run(teamAdd(), as(ownerCookie, {method: "POST", body: {email: "Friend@Gmail.com"}}));
        assert.equal(added.code, 200);
        assert.equal(added.body.email, "friend@gmail.com");
        assert.equal((await run(teamAdd(), as(ownerCookie, {method: "POST", body: {email: "friend@gmail.com"}}))).code, 409);

        const listed = await run(teamList(), as(ownerCookie));
        assert.deepEqual(listed.body.map(a => [a.email, a.owner]), [["owner@example.com", true], ["friend@gmail.com", false]]);

        const friend = await signIn("friend@gmail.com");
        assert.equal(friend.response.code, 200);
        assert.equal((await run(teamList(), as(friend.cookie))).code, 200);

        const removed = await run(teamRemove(), as(ownerCookie, {method: "DELETE", params: {email: encodeURIComponent("friend@gmail.com")}}));
        assert.equal(removed.code, 200);
        assert.equal(await isAdminEmail("friend@gmail.com"), false);

        const afterRemoval = await run(teamList(), as(friend.cookie));
        assert.equal(afterRemoval.code, 401, "the removed teammate's existing session stops working at once");
        assert.equal((await signIn("friend@gmail.com")).response.code, 403);
    });

    test("owners and your own account cannot be removed from the console", async () => {
        const {cookie} = await signIn("owner@example.com");
        const owner = await run(teamRemove(), as(cookie, {method: "DELETE", params: {email: "owner@example.com"}}));
        assert.equal(owner.code, 400);
        assert.match(owner.body.message, /ADMIN_EMAILS/);

        await run(teamAdd(), as(cookie, {method: "POST", body: {email: "second@gmail.com"}}));
        const second = await signIn("second@gmail.com");
        const self = await run(teamRemove(), as(second.cookie, {method: "DELETE", params: {email: "second@gmail.com"}}));
        assert.equal(self.code, 400);
        assert.match(self.body.message, /own access/);
    });

    test("removing someone who is not on the list is a 404", async () => {
        const {cookie} = await signIn("owner@example.com");
        assert.equal((await run(teamRemove(), as(cookie, {method: "DELETE", params: {email: "nobody@gmail.com"}}))).code, 404);
    });
});
