// `vite-plugin-font` resolves `*.ttf` file imports.
// It provides the type definition for the `*.ttf` imports,
// but it misses some properties,
// so we need to declare them here.
declare module "@konghayao/_font_" {
  export const fontFamilyFallback: string;
}
