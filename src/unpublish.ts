"use strict";

import npmFetch from "@evocateur/npm-registry-fetch";
import figgyPudding from "figgy-pudding";
import npa from "npm-package-arg";
import semver from "semver";
import url from "url";

const UnpublishConfig = figgyPudding({
    force: { default: false },
    promise: { default: () => Promise },
});

function unpublish(spec: any, opts: any) {
    opts = UnpublishConfig(opts);
    return new opts.promise((resolve: any) => resolve())
        .then(() => {
            spec = npa(spec);
            // NOTE: spec is used to pick the appropriate registry/auth combo.
            opts = opts.concat({ spec });
            const pkgUri = spec.escapedName;
            return npmFetch
                .json(
                    pkgUri,
                    opts.concat({
                        query: { write: true },
                    }),
                )
                .then(
                    (pkg: any) => {
                        if (!spec.rawSpec || spec.rawSpec === "*") {
                            return npmFetch(
                                `${pkgUri}/-rev/${pkg._rev}`,
                                opts.concat({
                                    ignoreBody: true,
                                    method: "DELETE",
                                }),
                            );
                        } else {
                            const version = spec.rawSpec;
                            const allVersions = pkg.versions || {};
                            const versionPublic = allVersions[version];
                            let dist: any;
                            if (versionPublic) {
                                dist = allVersions[version].dist;
                            }
                            delete allVersions[version];
                            // if it was the only version, then delete the whole package.
                            if (!Object.keys(allVersions).length) {
                                return npmFetch(
                                    `${pkgUri}/-rev/${pkg._rev}`,
                                    opts.concat({
                                        ignoreBody: true,
                                        method: "DELETE",
                                    }),
                                );
                            } else if (versionPublic) {
                                const latestVer = pkg["dist-tags"].latest;
                                Object.keys(pkg["dist-tags"]).forEach(tag => {
                                    if (pkg["dist-tags"][tag] === version) {
                                        delete pkg["dist-tags"][tag];
                                    }
                                });

                                if (latestVer === version) {
                                    pkg["dist-tags"].latest = Object.keys(
                                        allVersions,
                                    )
                                        // @ts-ignore
                                        .sort(semver.compareLoose)
                                        .pop();
                                }

                                delete pkg._revisions;
                                delete pkg._attachments;
                                // Update packument with removed versions
                                return npmFetch(
                                    `${pkgUri}/-rev/${pkg._rev}`,
                                    opts.concat({
                                        body: pkg,
                                        ignoreBody: true,
                                        method: "PUT",
                                    }),
                                ).then(() => {
                                    // Remove the tarball itself
                                    return npmFetch
                                        .json(
                                            pkgUri,
                                            opts.concat({
                                                query: { write: true },
                                            }),
                                        )
                                        .then((f: any) => {
                                            // eslint-disable-next-line node/no-deprecated-api
                                            const tarballPathName = url.parse(
                                                dist.tarball,
                                            ).pathname;
                                            const tarballUrl = tarballPathName
                                                ? tarballPathName.substr(1)
                                                : "";
                                            return npmFetch(
                                                `${tarballUrl}/-rev/${f._rev}`,
                                                opts.concat({
                                                    ignoreBody: true,
                                                    method: "DELETE",
                                                }),
                                            );
                                        });
                                });
                            }
                        }
                    },
                    (err: any) => {
                        if (err.code !== "E404") {
                            throw err;
                        }
                    },
                );
        })
        .then(() => true);
}

module.exports = unpublish;
