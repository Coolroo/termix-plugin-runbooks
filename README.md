# Coolroo Plugins: a Termix plugin registry

`index.json` on this branch is a custom Termix plugin registry. Every plugin it lists is signed with one Ed25519 key, whose private half is held in an HSM-style transit engine and never exported.

Add it in Termix: **Plugins**, **Registries**, **Add registry**, paste

```
https://raw.githubusercontent.com/Coolroo/termix-plugin-runbooks/registry/index.json
```

then **Check**, and compare the key id before **Trust and add**:

- Public key: `ugy5pNjobUFpYKk3hLVBBeYiKvfEwYvVxUmjD2YbA+E=`
- Key id: `af0e8b5beaf9528f`

The plugin itself is also on its way to the Termix community registry; either source installs the same reviewed release.
