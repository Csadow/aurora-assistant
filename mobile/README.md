# Aurora Mobile source

This is an experimental offline Android companion. It stores Markdown notes,
tasks, drafts, and request history on the device and supports reviewed manual
file transfer with desktop Aurora. Cloud replies require a separately supplied
key and an explicit request preview. The mobile assistant does not control the
laptop or sync automatically.

Build and test on Linux with Android platform/build tools and JDK 17:

```sh
python3 scripts/build-mobile.py
node tests/mobile.test.mjs
node scripts/mobile-browser-test.mjs
```

Set `AURORA_ANDROID_TOOLS` to the directory containing `jdk/`,
`platform/android.jar`, and `build-tools/`. The build uses a local signing key
outside this repository. Keep that key private and preserve it for upgrades.
The browser test uses a mocked Android bridge; physical device behavior and
cloud provider connectivity need separate validation.
