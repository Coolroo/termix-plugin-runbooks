# Coolroo Plugins: a Termix plugin registry

`index.json` on this branch is a custom Termix plugin registry. It lists two plugins: **Runbooks** ([termix-plugin-runbooks](https://github.com/Coolroo/termix-plugin-runbooks)) and **OpenBao Secrets** ([termix-plugin-openbao-secrets](https://github.com/Coolroo/termix-plugin-openbao-secrets)). Every plugin it lists is signed with one Ed25519 key, whose private half lives in an OpenBao transit engine and cannot be exported.

Add it in Termix: **Plugins**, **Registries**, **Add registry**, paste

```
https://raw.githubusercontent.com/Coolroo/termix-plugin-runbooks/registry/index.json
```

then **Check**, and compare the key id before **Trust and add**:

- Public key: `ugy5pNjobUFpYKk3hLVBBeYiKvfEwYvVxUmjD2YbA+E=`
- Key id: `af0e8b5beaf9528f`

## Adding a release

`tools/` builds and checks this index (Node 22, no dependencies):

1. Sign the release file's sha256 with the registry key (Ed25519 over the 32-byte digest, base64), into `<file>.tmxplug.sig`.
2. `node tools/gen-index.mjs <manifest.json> <CHANGELOG.md> <file.tmxplug> <file.sig> <publicKey> <release url> <publishedAt> new.json`
3. `node tools/merge-index.mjs new.json index.json index.json` keeps every listed release and puts the new one first.
4. `node tools/validate.mjs registry-index-schema.json index.json <file.tmxplug>` checks the schema (Termix-Registry's `registry-index-schema.json`), the sha256, the size and the signature.
