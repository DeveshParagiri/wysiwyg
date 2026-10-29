// css-tree's prebuilt ESM bundle has its JSON data inlined, so it survives bundling
// (the package entry loads ../data/*.json via require() at runtime).
declare module "css-tree/dist/csstree.esm" {
  export * from "css-tree";
}
