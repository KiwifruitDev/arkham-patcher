// Development shim: the built page uses the ps3xport-wasm layout module that
// build.mjs copies next to this file. Node tests resolve it from the source
// tree instead, so the module can be imported by both.
export * from '../../web/layout.js';
