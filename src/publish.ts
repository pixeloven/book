/* tslint:disable no-string-literal */
"use strict";

import npmFetch from "@evocateur/npm-registry-fetch";
import npmAuth from "@evocateur/npm-registry-fetch/auth.js";
import validate from "aproba";
import figgyPudding from "figgy-pudding";
import getStream from "get-stream";
import cloneDeep from "lodash.clonedeep";
import { fixer } from "normalize-package-data";
import npa from "npm-package-arg";
import semver from "semver";
import ssri from "ssri";
import url from "url";

const PublishConfig = figgyPudding({
    access: {},
    algorithms: { default: ["sha512"] },
    npmVersion: {},
    promise: { default: () => Promise },
    tag: { default: "latest" },
});

function publish(manifest: any, tarball: any, opts: any) {
    opts = PublishConfig(opts);
    return new opts.promise((resolve: any) => resolve())
        .then(() => {
            validate("OSO|OOO", [manifest, tarball, opts]);
            if (manifest.private) {
                throw Object.assign(
                    new Error(
                        "This package has been marked as private\n" +
                            "Remove the 'private' field from the package.json to publish it.",
                    ),
                    { code: "EPRIVATE" },
                );
            }
            const spec = npa.resolve(manifest.name, manifest.version);
            // NOTE: spec is used to pick the appropriate registry/auth combo.
            opts = opts.concat(manifest.publishConfig, { spec });
            const reg = npmFetch.pickRegistry(spec, opts);
            const auth = npmAuth(reg, opts);
            const pubManifest = patchedManifest(spec, auth, manifest, opts);

            // registry-frontdoor cares about the access level, which is only
            // configurable for scoped packages
            if (!spec.scope && opts.access === "restricted") {
                throw Object.assign(
                    new Error("Can't restrict access to unscoped packages."),
                    { code: "EUNSCOPED" },
                );
            }

            return slurpTarball(tarball, opts).then((tardata: any) => {
                const metadata = buildMetadata(
                    spec,
                    auth,
                    reg,
                    pubManifest,
                    tardata,
                    opts,
                );
                return npmFetch(
                    spec.escapedName,
                    opts.concat({
                        body: metadata,
                        ignoreBody: true,
                        method: "PUT",
                    }),
                ).catch((err: any) => {
                    if (err.code !== "E409") {
                        throw err;
                    }
                    return npmFetch
                        .json(
                            spec.escapedName,
                            opts.concat({
                                query: { write: true },
                            }),
                        )
                        .then((current: any) =>
                            patchMetadata(current, metadata, opts),
                        )
                        .then((newMetadata: any) => {
                            return npmFetch(
                                spec.escapedName,
                                opts.concat({
                                    body: newMetadata,
                                    ignoreBody: true,
                                    method: "PUT",
                                }),
                            );
                        });
                });
            });
        })
        .then(() => true);
}

function patchedManifest(spec: any, auth: any, base: any, opts: any) {
    const manifest = cloneDeep(base);
    manifest._nodeVersion = process.versions.node;
    if (opts.npmVersion) {
        manifest._npmVersion = opts.npmVersion;
    }
    if (auth.username || auth.email) {
        // NOTE: This is basically pointless, but reproduced because it's what
        // legacy does: tl;dr `auth.username` and `auth.email` are going to be
        // undefined in any auth situation that uses tokens instead of plain
        // auth. I can only assume some registries out there decided that
        // _npmUser would be of any use to them, but _npmUser in packuments
        // currently gets filled in by the npm registry itself, based on auth
        // information.
        manifest._npmUser = {
            email: auth.email,
            name: auth.username,
        };
    }

    fixer.fixNameField(manifest, {
        allowLegacyCase: true,
        strict: true,
    });
    const version = semver.clean(manifest.version);
    if (!version) {
        throw Object.assign(new Error("invalid semver: " + manifest.version), {
            code: "EBADSEMVER",
        });
    }
    manifest.version = version;
    return manifest;
}

function buildMetadata(
    spec: any,
    auth: any,
    registry: any,
    manifest: any,
    tardata: any,
    opts: any,
) {
    const root = {
        _attachments: {},
        _id: manifest.name,
        access: "",
        description: manifest.description,
        "dist-tags": {},
        maintainers: [] as any[],
        name: manifest.name,
        readme: manifest.readme || "",
        versions: {},
    };

    if (opts.access) {
        root.access = opts.access;
    }

    if (!auth.token) {
        root.maintainers = [{ name: auth.username, email: auth.email }];
        manifest.maintainers = JSON.parse(JSON.stringify(root.maintainers));
    }

    root.versions[manifest.version] = manifest;
    const tag = manifest.tag || opts.tag;
    root["dist-tags"][tag] = manifest.version;

    const tbName = manifest.name + "-" + manifest.version + ".tgz";
    const tbURI = manifest.name + "/-/" + tbName;
    const integrity = ssri.fromData(tardata, {
        algorithms: [...new Set(["sha1"].concat(opts.algorithms))],
    });

    manifest._id = manifest.name + "@" + manifest.version;
    manifest.dist = manifest.dist || {};
    // Don't bother having sha1 in the actual integrity field
    manifest.dist.integrity = integrity["sha512"][0].toString();
    // Legacy shasum support
    // @ts-ignore
    manifest.dist.shasum = integrity["sha1"][0].hexDigest();
    // eslint-disable-next-line node/no-deprecated-api
    manifest.dist.tarball = url
        .resolve(registry, tbURI)
        .replace(/^https:\/\//, "http://");

    root._attachments[tbName] = {
        content_type: "application/octet-stream",
        data: tardata.toString("base64"),
        length: tardata.length,
    };

    return root;
}

function patchMetadata(current: any, newData: any, opts: any) {
    const curVers = Object.keys(current.versions || {})
        .map(v => {
            return semver.clean(v, true);
        })
        .concat(
            Object.keys(current.time || {}).map(v => {
                if (semver.valid(v, true)) {
                    return semver.clean(v, true);
                }
                return null;
            }),
        )
        .filter(v => v);

    const newVersion = Object.keys(newData.versions)[0];

    if (curVers.indexOf(newVersion) !== -1) {
        throw ConflictError(newData.name, newData.version);
    }

    current.versions = current.versions || {};
    current.versions[newVersion] = newData.versions[newVersion];
    for (const i in newData) {
        if (newData[i]) {
            switch (i) {
                // objects that copy over the new stuffs
                case "dist-tags":
                case "versions":
                case "_attachments":
                    for (const j in newData[i]) {
                        if (newData[i][j]) {
                            current[i] = current[i] || {};
                            current[i][j] = newData[i][j];
                        }
                    }
                    break;

                // ignore these
                case "maintainers":
                    break;

                // copy
                default:
                    current[i] = newData[i];
            }
        }
    }
    const maint =
        newData.maintainers && JSON.parse(JSON.stringify(newData.maintainers));
    newData.versions[newVersion].maintainers = maint;
    return current;
}

function slurpTarball(tarSrc: any, opts: any) {
    if (Buffer.isBuffer(tarSrc)) {
        return opts.promise.resolve(tarSrc);
    } else if (typeof tarSrc === "string") {
        return opts.promise.resolve(Buffer.from(tarSrc, "base64"));
    } else if (typeof tarSrc.pipe === "function") {
        return getStream.buffer(tarSrc);
    } else {
        return opts.promise.reject(
            Object.assign(
                new Error(
                    "invalid tarball argument. Must be a Buffer, a base64 string, or a binary stream",
                ),
                {
                    code: "EBADTAR",
                },
            ),
        );
    }
}

function ConflictError(pkgid: string, version: string) {
    return Object.assign(
        new Error(`Cannot publish ${pkgid}@${version} over existing version.`),
        {
            code: "EPUBLISHCONFLICT",
            pkgid,
            version,
        },
    );
}

module.exports = publish;
